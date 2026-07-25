package auth

import (
	"encoding/base64"
	"errors"
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
