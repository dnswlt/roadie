package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dnswlt/roadie/internal/auth"
)

// These exercise the auth-adjacent middleware and /api/me only, so they build
// their pieces directly rather than going through New and its store.

func TestRequireClientHeader(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		path       string
		clientID   string
		wantServed bool
	}{
		{"mutation with header", "PATCH", "/api/items/1", "tab-1", true},
		{"mutation without header", "PATCH", "/api/items/1", "", false},
		{"create without header", "POST", "/api/roadmaps", "", false},
		{"delete without header", "DELETE", "/api/items/1", "", false},
		// Safe methods change nothing, so there is nothing to forge — and the
		// export link is a plain browser navigation that cannot set headers.
		{"GET without header", "GET", "/api/roadmaps/1/export", "", true},
		// Only the API is guarded; the login flow posts no client id.
		{"logout without header", "POST", "/auth/logout", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			served := false
			h := requireClientHeader(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				served = true
			}))
			r := httptest.NewRequest(tt.method, tt.path, strings.NewReader("{}"))
			if tt.clientID != "" {
				r.Header.Set(clientIDHeader, tt.clientID)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)

			if served != tt.wantServed {
				t.Errorf("served = %v, want %v (status %d)", served, tt.wantServed, w.Code)
			}
			if !tt.wantServed && w.Code != http.StatusForbidden {
				t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
			}
		})
	}
}

// With auth off the frontend must be able to tell that there is no account
// concept at all, so it renders exactly as it always has.
func TestGetMeOpenMode(t *testing.T) {
	s := &Server{}
	w := httptest.NewRecorder()
	s.getMe(w, httptest.NewRequest("GET", "/api/me", nil))

	var got meResponse
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Mode != "open" || got.Authenticated {
		t.Errorf("getMe = %+v, want open and unauthenticated", got)
	}
}

// The tracker's base URL is how the frontend knows a tracker exists at all, and
// also which links belong to it, so an empty one must mean unconfigured and
// nothing else.
func TestGetMeReportsTrackerURL(t *testing.T) {
	s := &Server{tracker: &stubTracker{baseURL: "https://jira.example.test/jira"}}
	w := httptest.NewRecorder()
	s.getMe(w, httptest.NewRequest("GET", "/api/me", nil))

	var got meResponse
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.TrackerURL != "https://jira.example.test/jira" {
		t.Errorf("getMe = %+v, want the tracker base URL", got)
	}
}

func TestGetMeReportsIdentity(t *testing.T) {
	// A non-nil Authenticator is all getMe checks; the middleware that would
	// have populated the context is stubbed by setting the identity here.
	s := &Server{auth: &auth.Authenticator{}}
	r := httptest.NewRequest("GET", "/api/me", nil)
	r = r.WithContext(auth.WithIdentity(r.Context(),
		auth.Identity{Subject: "abc", Name: "Ada Lovelace", Email: "ada@example.com"}))

	w := httptest.NewRecorder()
	s.getMe(w, r)

	var got meResponse
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := meResponse{Mode: "oidc", Authenticated: true, Name: "Ada Lovelace", Email: "ada@example.com"}
	if got != want {
		t.Errorf("getMe = %+v, want %+v", got, want)
	}
}
