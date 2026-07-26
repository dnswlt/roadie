package auth

import (
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// testAuth builds an Authenticator without OIDC discovery: everything these
// tests exercise (the session cookie, the middleware, the challenge) is
// independent of the provider.
func testAuth(t *testing.T) *Authenticator {
	t.Helper()
	sl, err := newSealer(NewSessionKey())
	if err != nil {
		t.Fatalf("newSealer: %v", err)
	}
	return &Authenticator{
		sealer:       sl,
		sessionTTL:   time.Hour,
		secure:       true,
		callbackPath: "/auth/callback",
	}
}

func TestSessionRoundTrip(t *testing.T) {
	a := testAuth(t)
	want := Identity{Subject: "abc-123", Name: "Ada Lovelace", Email: "ada@example.com"}

	tok, err := a.sealSession(want)
	if err != nil {
		t.Fatalf("sealSession: %v", err)
	}
	got, err := a.openSession(tok)
	if err != nil {
		t.Fatalf("openSession: %v", err)
	}
	if got != want {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
	if got.IsAnonymous() {
		t.Error("a sealed session must not read back as anonymous")
	}
}

// A session must be unreadable and unforgeable to anyone without the key: the
// whole no-session-table design rests on that.
func TestSessionRejectsTamperingAndForeignKeys(t *testing.T) {
	a := testAuth(t)
	tok, err := a.sealSession(Identity{Subject: "abc-123", Name: "Ada"})
	if err != nil {
		t.Fatalf("sealSession: %v", err)
	}

	if strings.Contains(tok, "Ada") {
		t.Error("session token leaks the name in clear text")
	}

	// Flip a byte in the ciphertext.
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw[len(raw)-1] ^= 0x01
	if _, err := a.openSession(base64.RawURLEncoding.EncodeToString(raw)); err == nil {
		t.Error("openSession accepted a tampered token")
	}

	// A token sealed by a different deployment (key rotation, another app).
	other := testAuth(t)
	if _, err := other.openSession(tok); err == nil {
		t.Error("openSession accepted a token sealed with a different key")
	}

	for _, bad := range []string{"", "not base64 !!", "AAAA"} {
		if _, err := a.openSession(bad); err == nil {
			t.Errorf("openSession(%q) accepted a malformed token", bad)
		}
	}
}

func TestSessionExpiry(t *testing.T) {
	a := testAuth(t)
	a.sessionTTL = -time.Second // already over

	tok, err := a.sealSession(Identity{Subject: "abc-123"})
	if err != nil {
		t.Fatalf("sealSession: %v", err)
	}
	_, err = a.openSession(tok)
	if !errors.Is(err, errExpired) {
		t.Errorf("openSession error = %v, want errExpired", err)
	}
}

// A session that decodes to a blank subject would read as anonymous
// downstream, which is a bypass rather than a rejection.
func TestSessionRejectsBlankSubject(t *testing.T) {
	a := testAuth(t)
	tok, err := a.sealer.seal(session{Name: "nobody", Expires: time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if _, err := a.openSession(tok); err == nil {
		t.Error("openSession accepted a session without a subject")
	}
}

func TestSafeNext(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"/roadmap/7", "/roadmap/7"},
		{"/?a=b#c", "/?a=b#c"},
		{"", "/"},
		{"https://evil.example/", "/"},
		{"//evil.example/", "/"},
		{"evil.example", "/"},
	}
	for _, tt := range tests {
		if got := safeNext(tt.in); got != tt.want {
			t.Errorf("safeNext(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestPublicPaths(t *testing.T) {
	a := testAuth(t)
	public := []string{"/healthz", "/readyz", "/auth/login", "/auth/callback", "/auth/signed-out"}
	private := []string{"/", "/app.js", "/api/me", "/api/roadmaps", "/api/roadmaps/1/events"}
	for _, p := range public {
		if !a.publicPath(p) {
			t.Errorf("publicPath(%q) = false, want true", p)
		}
	}
	for _, p := range private {
		if a.publicPath(p) {
			t.Errorf("publicPath(%q) = true, want false", p)
		}
	}

	// A provider-mandated callback outside /auth/ must be public too, or the
	// user completing a login is bounced back into the login they just did.
	custom := &Authenticator{callbackPath: "/callback"}
	if !custom.publicPath("/callback") {
		t.Error("a custom callback path is not public")
	}
	if custom.publicPath("/callbackx") {
		t.Error("publicPath matched a prefix of the callback path")
	}
}

// serve runs a request through the middleware and reports what the wrapped
// handler saw, if it ran at all.
func serve(a *Authenticator, r *http.Request) (*httptest.ResponseRecorder, Identity, bool) {
	var (
		seen   Identity
		called bool
	)
	h := a.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen, called = From(r.Context()), true
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w, seen, called
}

func TestMiddlewareAdmitsValidSession(t *testing.T) {
	a := testAuth(t)
	want := Identity{Subject: "abc-123", Name: "Ada Lovelace", Email: "ada@example.com"}
	tok, err := a.sealSession(want)
	if err != nil {
		t.Fatalf("sealSession: %v", err)
	}

	r := httptest.NewRequest("GET", "/api/roadmaps", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: tok})
	w, seen, called := serve(a, r)

	if !called {
		t.Fatalf("handler not reached, status %d", w.Code)
	}
	if seen != want {
		t.Errorf("identity in context = %+v, want %+v", seen, want)
	}
}

func TestMiddlewarePassesPublicPaths(t *testing.T) {
	a := testAuth(t)
	// No cookie at all: the kubelet scraping /healthz has none.
	_, seen, called := serve(a, httptest.NewRequest("GET", "/healthz", nil))
	if !called {
		t.Fatal("/healthz was not served without a session")
	}
	if !seen.IsAnonymous() {
		t.Errorf("public path saw identity %+v, want anonymous", seen)
	}
}

// A browser navigation goes into the login flow; an XHR or EventSource gets a
// status it can act on, since redirecting those to the provider would only
// surface as an opaque CORS error.
func TestMiddlewareChallengeDependsOnAccept(t *testing.T) {
	a := testAuth(t)

	nav := httptest.NewRequest("GET", "/roadmap/7?x=1", nil)
	nav.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	w, _, called := serve(a, nav)
	if called {
		t.Error("handler ran without a session")
	}
	if w.Code != http.StatusFound {
		t.Errorf("navigation status = %d, want %d", w.Code, http.StatusFound)
	}
	if loc := w.Header().Get("Location"); loc != "/auth/login?next=%2Froadmap%2F7%3Fx%3D1" {
		t.Errorf("navigation Location = %q, want the login flow with the original target", loc)
	}

	for _, r := range []*http.Request{
		httptest.NewRequest("GET", "/api/me", nil),                            // fetch: Accept */*
		httptest.NewRequest("PATCH", "/api/items/1", strings.NewReader("{}")), // mutation
		sseRequest(), // EventSource
	} {
		w, _, called := serve(a, r)
		if called {
			t.Errorf("%s %s: handler ran without a session", r.Method, r.URL.Path)
		}
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want %d", r.Method, r.URL.Path, w.Code, http.StatusUnauthorized)
		}
	}
}

func sseRequest() *http.Request {
	r := httptest.NewRequest("GET", "/api/roadmaps/1/events", nil)
	r.Header.Set("Accept", "text/event-stream")
	return r
}

// A dead cookie must be cleared, or the browser re-sends it on every request
// forever and the log fills with rejections.
func TestMiddlewareClearsUnusableCookie(t *testing.T) {
	a := testAuth(t)
	r := httptest.NewRequest("GET", "/api/me", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "garbage"})

	w, _, called := serve(a, r)
	if called {
		t.Error("handler ran with an unusable session cookie")
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookie || cookies[0].MaxAge >= 0 {
		t.Errorf("response cookies = %+v, want %s cleared", cookies, sessionCookie)
	}
}

// The claim a value came from is now part of the login log, and it is only
// worth logging if it is accurate. These also pin the precedence itself, which
// is the thing most likely to need changing for a new provider.
func TestClaimsIdentityReportsItsSource(t *testing.T) {
	tests := []struct {
		name      string
		claims    userClaims
		wantName  string
		wantEmail string
		wantFrom  string
	}{{
		name:      "full profile prefers name and email",
		claims:    userClaims{Name: "Ada Lovelace", PreferredUsername: "ada@corp.com", Email: "ada@corp.com"},
		wantName:  "Ada Lovelace",
		wantEmail: "ada@corp.com",
		wantFrom:  "name<-name email<-email",
	}, {
		// Entra v2 commonly sends preferred_username and no email claim.
		name:      "no email claim falls back to preferred_username",
		claims:    userClaims{Name: "Ada Lovelace", PreferredUsername: "ada@corp.com"},
		wantName:  "Ada Lovelace",
		wantEmail: "ada@corp.com",
		wantFrom:  "name<-name email<-preferred_username",
	}, {
		name:      "no name claim falls back to the email-ish value",
		claims:    userClaims{UPN: "ada@corp.com"},
		wantName:  "ada@corp.com",
		wantEmail: "ada@corp.com",
		wantFrom:  "name<-upn email<-upn",
	}, {
		// The scenario worth being able to see in a log: the tenant fills name
		// with an object id, so it wins over a perfectly good UPN next to it.
		name:      "an opaque name claim still wins",
		claims:    userClaims{Name: "7f3c1b90-2d44-4f0e-9a11-5c8e6b2d0f77", PreferredUsername: "ada@corp.com"},
		wantName:  "7f3c1b90-2d44-4f0e-9a11-5c8e6b2d0f77",
		wantEmail: "ada@corp.com",
		wantFrom:  "name<-name email<-preferred_username",
	}, {
		name:     "nothing usable reports none, not an empty claim name",
		claims:   userClaims{},
		wantFrom: "name<-none email<-none",
	}}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, from := tt.claims.identity("sub-1")
			if id.Name != tt.wantName || id.Email != tt.wantEmail {
				t.Errorf("identity = {Name:%q Email:%q}, want {Name:%q Email:%q}",
					id.Name, id.Email, tt.wantName, tt.wantEmail)
			}
			if from != tt.wantFrom {
				t.Errorf("source = %q, want %q", from, tt.wantFrom)
			}
			if id.Subject != "sub-1" {
				t.Errorf("subject = %q, want %q", id.Subject, "sub-1")
			}
		})
	}
}

// With nothing but sub, Label falls back to the subject -- the "user shows up
// as a GUID" case. empty() must report true so UserInfo is consulted first.
func TestClaimsEmptyTriggersUserInfoFallback(t *testing.T) {
	if !(userClaims{}).empty() {
		t.Error("no claims at all must count as empty, so UserInfo is tried")
	}
	if (userClaims{UPN: "ada@corp.com"}).empty() {
		t.Error("a upn-only profile is not empty; UserInfo would be a wasted call")
	}
	id, _ := (userClaims{}).identity("sub-only")
	if id.Label() != "sub-only" {
		t.Errorf("Label with no claims = %q, want the subject", id.Label())
	}
}

// logClaims is the -auth-debug escape hatch: when a provider puts the display
// name somewhere Roadie does not parse, this dump is the only place it shows
// up. Worth a test, because a silent no-op here would only be discovered during
// the incident it exists for.
func TestLogClaimsDumpsEverythingOnlyWhenDebugging(t *testing.T) {
	claims := func(v any) error {
		*(v.(*map[string]any)) = map[string]any{
			"sub":                "7f3c1b90",
			"oid":                "7f3c1b90",
			"name":               "Ada Lovelace",
			"preferred_username": "ada@corp.com",
			// A claim Roadie does not parse: the whole reason for the dump.
			"employeeid": "E-4471",
		}
		return nil
	}

	var buf strings.Builder
	old := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(old) })

	// Off by default: claim values are personal data.
	(&Authenticator{}).logClaims("id_token", "7f3c1b90", claims)
	if buf.String() != "" {
		t.Fatalf("claims logged with debug off: %s", buf.String())
	}

	(&Authenticator{debug: true}).logClaims("id_token", "7f3c1b90", claims)
	got := buf.String()
	for _, want := range []string{
		"id_token claims for 7f3c1b90",
		"employeeid=E-4471", // the unparsed claim must survive
		"name=Ada Lovelace",
		"preferred_username=ada@corp.com",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("dump missing %q; got: %s", want, got)
		}
	}
	// Sorted, so two logins can be diffed against each other.
	if !strings.Contains(got, "employeeid=E-4471 name=Ada Lovelace oid=") {
		t.Errorf("claims not in sorted order: %s", got)
	}
}

// A provider that hands back something undecodable must say so rather than
// leaving a silent gap in the log.
func TestLogClaimsReportsUnreadableClaims(t *testing.T) {
	var buf strings.Builder
	old := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(old) })

	(&Authenticator{debug: true}).logClaims("userinfo", "sub-1", func(any) error {
		return errors.New("boom")
	})
	if !strings.Contains(buf.String(), "cannot read userinfo claims for sub-1: boom") {
		t.Errorf("unreadable claims not reported; got: %s", buf.String())
	}
}
