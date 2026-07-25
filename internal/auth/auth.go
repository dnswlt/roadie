// Package auth turns OIDC logins into a session cookie and puts the resulting
// identity into the request context.
//
// Roadie runs in one of two modes, chosen by a flag on the server. With auth
// off, no middleware is installed and From reports an anonymous identity —
// exactly the behaviour Roadie has always had, everyone can see and edit
// everything. With auth on, every request outside a small public allowlist
// needs a session, and login is delegated to an OIDC provider (Entra ID in
// production). There is no password store and no local account concept in
// either mode.
//
// Roadie is a *confidential* client: the authorization code flow runs
// server-side and the browser only ever receives an opaque session cookie. No
// token is exposed to JavaScript. That is also what keeps SSE working
// unchanged — EventSource cannot set an Authorization header, but it does send
// cookies (see internal/server/events.go).
//
// Nothing is stored server-side: no user table, no session table. The ID token
// is used once, at the callback, to learn who the user is, and is then
// discarded; the cookie is a sealed blob holding only the claims Roadie needs.
// Sessions therefore survive restarts and work across replicas that share a
// session key — but they cannot be revoked before they expire. That is an
// acceptable trade here, where re-login is a silent redirect against a live
// provider session and the app holds no unsaved state to lose.
//
// Because there is no user table, anything that wants to record who acted must
// denormalize the display name at write time. See Identity.
package auth

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Identity is everything the rest of Roadie knows about who is making a
// request. It is always present in the context — anonymous when auth is off —
// so callers never have to branch on the server's auth mode.
//
// Subject is the OIDC "sub" claim, stable per user per application. Name and
// Email are for display and are captured at login: with no user table to join
// against later, a caller that records an actor must store these alongside the
// subject.
type Identity struct {
	Subject string
	Name    string
	Email   string
}

// IsAnonymous reports whether the request carries no authenticated user, which
// is the normal case when the server runs with auth off.
func (i Identity) IsAnonymous() bool { return i.Subject == "" }

// Label is a human-readable actor name for logs and audit records.
func (i Identity) Label() string {
	switch {
	case i.Name != "":
		return i.Name
	case i.Email != "":
		return i.Email
	case i.Subject != "":
		return i.Subject
	default:
		return "anonymous"
	}
}

type ctxKey struct{}

// WithIdentity returns a context carrying id.
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// From returns the identity a request was made under. It never fails: a
// context without one yields the anonymous identity, which is what every
// request looks like when the server runs with auth off.
func From(ctx context.Context) Identity {
	id, _ := ctx.Value(ctxKey{}).(Identity)
	return id
}

// Config is the OIDC deployment configuration. It is only consulted when the
// server runs with auth enabled.
type Config struct {
	// Issuer is the provider's issuer URL, used for discovery. Pin it to a
	// single tenant (e.g. https://login.microsoftonline.com/<tenant>/v2.0)
	// rather than Entra's "common" endpoint: then plain issuer validation also
	// restricts logins to that tenant, with no tid claim check to remember.
	Issuer string

	ClientID     string
	ClientSecret string

	// RedirectURL is Roadie's own callback URL, e.g.
	// https://roadie.example.com/auth/callback. It is configured rather than
	// derived from the request's Host header: the provider requires an exact
	// match anyway, and taking it from the request would mean trusting proxy
	// headers. Its scheme also decides whether cookies are marked Secure.
	RedirectURL string

	// SessionKey seals the session cookie and must be 32 bytes. Replicas must
	// share it; rotating it logs everyone out.
	SessionKey []byte

	// SessionTTL is the absolute session lifetime, independent of the ID
	// token's own (much shorter) validity. Zero means DefaultSessionTTL.
	SessionTTL time.Duration

	// InsecureTLS skips certificate verification when talking to the provider.
	// It exists for local OIDC mocks with self-signed certificates and must
	// never be set in production.
	InsecureTLS bool
}

// DefaultSessionTTL is how long a login lasts by default. Long enough to cover
// a working day without a re-login, short enough that a stolen cookie is not
// forever.
const DefaultSessionTTL = 12 * time.Hour

// Cookie names. The login cookie is short-lived and only exists between the
// redirect to the provider and the callback.
const (
	sessionCookie = "roadie_session"
	loginCookie   = "roadie_login"
)

// loginTTL bounds how long a user may take to complete a login before the
// flow state expires and they have to start over.
const loginTTL = 10 * time.Minute

// Authenticator runs the OIDC login flow and gates requests on the resulting
// session. A nil *Authenticator means auth is off; the server simply does not
// install its middleware or routes in that case.
type Authenticator struct {
	oauth      *oauth2.Config
	provider   *oidc.Provider
	verifier   *oidc.IDTokenVerifier
	sealer     *sealer
	sessionTTL time.Duration
	secure     bool

	// callbackPath is the path component of Config.RedirectURL: both where the
	// callback handler is registered and what has to be served without a
	// session, since the user completing a login does not have one yet.
	callbackPath string

	// ctx carries the HTTP client used for provider traffic (JWKS refresh
	// happens lazily on verification, so it outlives New).
	ctx context.Context
}

// New performs OIDC discovery against cfg.Issuer and returns an Authenticator.
// It fails fast: a server started with auth enabled but unreachable or
// misconfigured provider should not come up pretending to be secure.
func New(ctx context.Context, cfg Config) (*Authenticator, error) {
	switch {
	case cfg.Issuer == "":
		return nil, fmt.Errorf("OIDC issuer is required")
	case cfg.ClientID == "":
		return nil, fmt.Errorf("OIDC client id is required")
	case cfg.ClientSecret == "":
		return nil, fmt.Errorf("OIDC client secret is required")
	case cfg.RedirectURL == "":
		return nil, fmt.Errorf("OIDC redirect URL is required")
	}

	redirect, err := url.Parse(cfg.RedirectURL)
	if err != nil || !redirect.IsAbs() {
		return nil, fmt.Errorf("invalid OIDC redirect URL %q (want an absolute URL)", cfg.RedirectURL)
	}
	// The callback route is served at whatever path the redirect URL names,
	// rather than at a fixed /auth/callback: the provider's registered URI is
	// the one that has to match, and it is often not ours to choose. These two
	// paths would silently shadow the app instead of serving a login.
	if redirect.Path == "" || redirect.Path == "/" || strings.HasPrefix(redirect.Path, "/api/") {
		return nil, fmt.Errorf("OIDC redirect URL %q needs a path of its own, outside /api/", cfg.RedirectURL)
	}

	sl, err := newSealer(cfg.SessionKey)
	if err != nil {
		return nil, err
	}

	// A dedicated client, so InsecureTLS cannot leak into anything else, and so
	// provider calls have a deadline of their own.
	httpClient := &http.Client{Timeout: 15 * time.Second}
	if cfg.InsecureTLS {
		httpClient.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}
	}
	// oidc.ClientContext is how both discovery here and the later JWKS refresh
	// and token exchange pick up this client, so it has to outlive New.
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, httpClient), cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery for %s: %w", cfg.Issuer, err)
	}

	ttl := cfg.SessionTTL
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}

	return &Authenticator{
		oauth: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Endpoint:     provider.Endpoint(),
			// email is requested but not relied upon: Entra only emits the
			// claim under some configurations, so the callback falls back to
			// preferred_username.
			Scopes: []string{oidc.ScopeOpenID, "profile", "email"},
		},
		provider:     provider,
		verifier:     provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		sealer:       sl,
		sessionTTL:   ttl,
		secure:       redirect.Scheme == "https",
		callbackPath: redirect.Path,
		ctx:          oidc.ClientContext(context.WithoutCancel(ctx), httpClient),
	}, nil
}

// safeNext sanitizes a post-login redirect target. Only same-site absolute
// paths are allowed: without this, ?next=https://evil.example turns the login
// endpoint into an open redirect. "//host" is rejected too — browsers read it
// as a protocol-relative URL.
func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		return "/"
	}
	return next
}
