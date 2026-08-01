package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

const immutable = "public, max-age=31536000, immutable"

// The policy is one rule, so the test is one table — run through a real server
// rather than the middleware alone, which would pass even if New forgot to wire
// it in.
func TestCacheHeaders(t *testing.T) {
	srv := New(testStore, fstest.MapFS{
		"index.html":              &fstest.MapFile{Data: []byte("<!doctype html>")},
		"assets/app-AB12.js":      &fstest.MapFile{Data: []byte("// bundle")},
		"assets/favicon-CD34.svg": &fstest.MapFile{Data: []byte("<svg/>")},
	})

	tests := []struct {
		name string
		path string
		want string
	}{
		{"hashed asset is immutable", "/assets/app-AB12.js", immutable},
		{"the favicon is hashed too, so it is cached like any other asset", "/assets/favicon-CD34.svg", immutable},
		{"index.html names the hashes, so it must not be stored", "/", "no-store"},
		{"api data is never stored", "/api/roadmaps", "no-store"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, httptest.NewRequest("GET", tt.path, nil))
			if got := w.Header().Get("Cache-Control"); got != tt.want {
				t.Errorf("Cache-Control = %q, want %q", got, tt.want)
			}
		})
	}
}

// Why cacheHeaders wraps the auth middleware rather than sitting under it: the
// redirect into the login flow carries a Set-Cookie and never reaches the mux.
// Covers the middleware, not the wiring — the auth routes only exist with auth
// configured, which this package's test server is not.
func TestRedirectIsNotStored(t *testing.T) {
	h := cacheHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/auth/login", http.StatusFound)
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/roadmaps", nil))

	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-store")
	}
}
