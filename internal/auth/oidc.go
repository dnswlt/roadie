package auth

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Routes registers the login endpoints. They are reachable without a session
// (see publicPath) — otherwise logging in would require being logged in.
func (a *Authenticator) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/login", a.handleLogin)
	mux.HandleFunc("GET "+a.callbackPath, a.handleCallback)
	mux.HandleFunc("POST /auth/logout", a.handleLogout)
	mux.HandleFunc("GET /auth/signed-out", a.handleSignedOut)
}

// publicPath reports whether a path is served without authentication: the k8s
// probes, which must keep answering for an unauthenticated kubelet, and the
// login flow itself. Everything else — API, SSE and the static frontend alike —
// requires a session, so there is no unauthenticated surface to reason about.
func (a *Authenticator) publicPath(p string) bool {
	switch p {
	case "/healthz", "/readyz":
		return true
	}
	// callbackPath is usually under /auth/ anyway; it is checked separately
	// because the provider's registered redirect URI decides it, not us.
	return strings.HasPrefix(p, "/auth/") || p == a.callbackPath
}

// Middleware requires a valid session and puts the caller's identity into the
// request context.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.publicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			a.challenge(w, r)
			return
		}
		id, err := a.openSession(c.Value)
		if err != nil {
			// An expired session is routine; anything else means the cookie was
			// truncated, forged, or sealed with a key we no longer have. Clear
			// it either way so the browser stops re-sending a dead cookie.
			if !errors.Is(err, errExpired) {
				log.Printf("auth: rejecting session cookie: %v", err)
			}
			a.clearCookie(w, sessionCookie)
			a.challenge(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// challenge tells an unauthenticated caller how to log in. A browser
// navigation is redirected into the flow; anything else (fetch, EventSource)
// gets a 401 it can react to, because redirecting an XHR to the provider only
// produces an opaque CORS failure.
func (a *Authenticator) challenge(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		http.Redirect(w, r, "/auth/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	fmt.Fprint(w, `{"error":"authentication required"}`)
}

// handleLogin starts the authorization code flow. The per-attempt state, nonce
// and PKCE verifier go into a short-lived sealed cookie rather than server
// memory, so any replica can complete the flow.
func (a *Authenticator) handleLogin(w http.ResponseWriter, r *http.Request) {
	ls := loginState{
		State:    randomToken(),
		Nonce:    randomToken(),
		Verifier: oauth2.GenerateVerifier(),
		Next:     safeNext(r.URL.Query().Get("next")),
		Expires:  time.Now().Add(loginTTL).Unix(),
	}
	tok, err := a.sealer.seal(ls)
	if err != nil {
		log.Printf("auth: sealing login state: %v", err)
		http.Error(w, "login failed", http.StatusInternalServerError)
		return
	}
	a.setCookie(w, loginCookie, tok, loginTTL)
	http.Redirect(w, r, a.oauth.AuthCodeURL(ls.State,
		oidc.Nonce(ls.Nonce),
		oauth2.S256ChallengeOption(ls.Verifier),
	), http.StatusFound)
}

// handleCallback completes the flow: it checks the request against the login
// cookie, exchanges the code, verifies the ID token, and mints a session.
func (a *Authenticator) handleCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(loginCookie)
	if err != nil {
		// Usually a stale bookmark of the callback URL, or a login left open
		// past loginTTL. Send them through the flow again rather than showing
		// an error they can do nothing with.
		http.Redirect(w, r, "/auth/login", http.StatusFound)
		return
	}
	a.clearCookie(w, loginCookie) // single use, whatever happens next

	var ls loginState
	if err := a.sealer.open(c.Value, &ls); err != nil {
		a.loginError(w, "login state is not valid", err)
		return
	}
	if time.Now().Unix() >= ls.Expires {
		http.Redirect(w, r, "/auth/login", http.StatusFound)
		return
	}
	// Comparing the returned state against the cookie is what stops an attacker
	// from having us consume an authorization code they obtained.
	if q := r.URL.Query().Get("state"); q == "" || q != ls.State {
		a.loginError(w, "login state mismatch", fmt.Errorf("state %q does not match", q))
		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		a.loginError(w, "the identity provider refused the login",
			fmt.Errorf("%s: %s", e, r.URL.Query().Get("error_description")))
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		a.loginError(w, "the identity provider returned no authorization code", nil)
		return
	}

	// a.ctx (not r.Context()) carries the provider HTTP client; it also keeps
	// the exchange from being cancelled by a client that navigates away.
	ctx := a.ctx
	tok, err := a.oauth.Exchange(ctx, code, oauth2.VerifierOption(ls.Verifier))
	if err != nil {
		a.loginError(w, "could not complete the login", err)
		return
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok {
		a.loginError(w, "the identity provider returned no ID token", nil)
		return
	}
	idToken, err := a.verifier.Verify(ctx, rawID)
	if err != nil {
		a.loginError(w, "the ID token could not be verified", err)
		return
	}
	// Binding the nonce closes the replay window: an ID token minted for some
	// other login attempt will not carry the nonce we just generated.
	if idToken.Nonce != ls.Nonce {
		a.loginError(w, "the ID token nonce did not match", nil)
		return
	}

	var claims userClaims
	if err := idToken.Claims(&claims); err != nil {
		a.loginError(w, "the ID token claims could not be read", err)
		return
	}
	// A provider is free to put nothing but sub in the ID token and serve the
	// profile claims from UserInfo instead — that is what IdentityServer does
	// unless the client sets AlwaysIncludeUserClaimsInIdToken, while Entra
	// inlines them. Without a name there is nobody to attribute a change to, so
	// fall back rather than depend on one provider's behaviour. Failure here is
	// not fatal: the subject alone still identifies the user.
	if claims.empty() {
		info, err := a.provider.UserInfo(ctx, oauth2.StaticTokenSource(tok))
		if err != nil {
			log.Printf("auth: UserInfo lookup for %s: %v", idToken.Subject, err)
		} else if err := info.Claims(&claims); err != nil {
			log.Printf("auth: reading UserInfo claims for %s: %v", idToken.Subject, err)
		}
	}
	id := claims.identity(idToken.Subject)

	sess, err := a.sealSession(id)
	if err != nil {
		a.loginError(w, "could not start a session", err)
		return
	}
	a.setCookie(w, sessionCookie, sess, a.sessionTTL)
	log.Printf("auth: login for %s", id.Label())
	http.Redirect(w, r, safeNext(ls.Next), http.StatusFound)
}

// userClaims are the identity claims Roadie looks for, from either the ID
// token or UserInfo. Several spellings are accepted because the provider
// decides which it emits: Entra v2 sends preferred_username, v1 and
// IdentityServer-style mocks send upn, and email needs the right scope and
// tenant configuration to appear at all.
type userClaims struct {
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	UPN               string `json:"upn"`
	Email             string `json:"email"`
}

// empty reports whether the claims say nothing about who the user is, which is
// the cue to try UserInfo.
func (c userClaims) empty() bool {
	return c.Name == "" && c.PreferredUsername == "" && c.UPN == "" && c.Email == ""
}

// identity resolves the claims into what Roadie stores, falling back through
// the spellings so a display name is populated whenever anything is known.
func (c userClaims) identity(subject string) Identity {
	email := firstNonEmpty(c.Email, c.PreferredUsername, c.UPN)
	return Identity{
		Subject: subject,
		Name:    firstNonEmpty(c.Name, email),
		Email:   email,
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// handleLogout drops the session cookie. It deliberately does not perform
// RP-initiated logout at the provider: ending the Entra session would sign the
// user out of every other company app too, which is rarely what they meant.
// The cost is that signing back in is a single click with no prompt — which is
// also why we land on a dedicated page rather than on "/", where the login
// redirect would silently re-authenticate and make logout look broken.
func (a *Authenticator) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.clearCookie(w, sessionCookie)
	w.WriteHeader(http.StatusNoContent)
}

// handleSignedOut is a self-contained confirmation page. It cannot use the
// app's stylesheet: that is served behind the middleware, and we have just
// thrown away the session needed to fetch it.
func (a *Authenticator) handleSignedOut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed out · Roadie</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; display: grid; place-content: center;
         min-height: 100vh; margin: 0; color: #1f2430; background: #f6f7f9; }
  .card { background: #fff; padding: 2.5rem 3rem; border-radius: 12px; text-align: center;
          box-shadow: 0 1px 3px rgb(0 0 0 / .1); }
  a { display: inline-block; margin-top: 1rem; padding: .5rem 1.25rem; border-radius: 6px;
      background: #2f6feb; color: #fff; text-decoration: none; }
</style></head>
<body><div class="card"><h1>Signed out</h1>
<p>You have been signed out of Roadie.</p>
<a href="/auth/login">Sign in again</a></div></body></html>`)
}

// loginError reports a failed login to the user in plain language while the
// detail — which may name internal hosts or claim values — goes to the log.
func (a *Authenticator) loginError(w http.ResponseWriter, msg string, err error) {
	if err != nil {
		log.Printf("auth: login failed: %s: %v", msg, err)
	} else {
		log.Printf("auth: login failed: %s", msg)
	}
	http.Error(w, "Login failed: "+msg+". Please try again.", http.StatusForbidden)
}

// setCookie writes a cookie scoped to the whole app.
//
// SameSite=Lax is load-bearing in both directions: it is permissive enough that
// the cookie rides along on the top-level GET navigation the provider redirects
// us back with (Strict would drop it and break the callback), and strict enough
// that it is withheld from cross-site POST/PATCH/DELETE, which is most of
// Roadie's CSRF defence.
func (a *Authenticator) setCookie(w http.ResponseWriter, name, value string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl.Seconds()),
	})
}

func (a *Authenticator) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
