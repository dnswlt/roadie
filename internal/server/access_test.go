package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/dnswlt/roadie/internal/auth"
	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/store"
)

var (
	owner    = auth.Identity{Subject: "sub-owner", Name: "Ada Lovelace"}
	outsider = auth.Identity{Subject: "sub-outsider", Name: "Grace Hopper"}
)

// privateRoadmap builds a private roadmap owned by `owner`, with one lane, one
// item, one milestone, one dependency and one snapshot, and returns the ids of
// each. Every route that names a roadmap does so through one of these six ids,
// which is what lets the sweep below cover all of them.
type privateFixture struct {
	roadmap, lane, item, milestone, dependency, snapshot, trackerQuery int64
}

func newPrivateFixture(t *testing.T) privateFixture {
	t.Helper()
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), store.Ownership{
		Visibility: model.VisibilityPrivate,
		Owner:      owner.Subject,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })

	lane, err := testStore.CreateLane(ctx, rm.ID, "Backend")
	if err != nil {
		t.Fatal(err)
	}
	start, _ := model.ParseDate("2026-01-01")
	end, _ := model.ParseDate("2026-02-01")
	item, err := testStore.CreateItem(ctx, lane.ID, store.NewItem{
		Title: "Work", StartDate: start, EndDate: end})
	if err != nil {
		t.Fatal(err)
	}
	ms, err := testStore.CreateMilestone(ctx, lane.ID, store.NewMilestone{
		Title: "Launch", Date: end})
	if err != nil {
		t.Fatal(err)
	}
	dep, err := testStore.CreateDependency(ctx, rm.ID,
		model.DependencyRef{Kind: model.DepItem, ID: item.ID},
		model.DependencyRef{Kind: model.DepMilestone, ID: ms.ID})
	if err != nil {
		t.Fatal(err)
	}
	cpName := "checkpoint"
	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, &cpName)
	if err != nil {
		t.Fatal(err)
	}
	tq, err := testStore.CreateTrackerQuery(ctx, rm.ID, "Epics", "type = Epic")
	if err != nil {
		t.Fatal(err)
	}
	// Seeded so the extractor's GET and DELETE have something to hide: on a
	// roadmap with no script both 404 anyway, and the sweep would pass whether
	// or not the guard was there.
	if _, err := testStore.PutTrackerExtractor(ctx, rm.ID,
		"def get_issue_time_range(issue):\n    return None\n"); err != nil {
		t.Fatal(err)
	}
	return privateFixture{rm.ID, lane.ID, item.ID, ms.ID, dep.ID, snap.ID, tq.ID}
}

// apiCall is one route exercised by the sweep: the mux pattern it is registered
// under (so the coverage check below can match them up), and a concrete request
// against the fixture.
type apiCall struct {
	pattern string
	method  string
	path    string
	body    string
}

func (f privateFixture) calls() []apiCall {
	rm := func(suffix string) string { return fmt.Sprintf("/api/roadmaps/%d%s", f.roadmap, suffix) }
	return []apiCall{
		{"GET /api/roadmaps/{id}", "GET", rm(""), ""},
		{"GET /api/roadmaps/{id}/export", "GET", rm("/export"), ""},
		{"GET /api/roadmaps/{id}/contributors", "GET", rm("/contributors"), ""},
		{"GET /api/roadmaps/{id}/snapshots", "GET", rm("/snapshots"), ""},
		{"POST /api/roadmaps/{id}/snapshots", "POST", rm("/snapshots"), `{"name":"v1.0"}`},
		{"GET /api/roadmaps/{id}/events", "GET", rm("/events"), ""},
		{"PATCH /api/roadmaps/{id}", "PATCH", rm(""), `{"name":"Stolen"}`},
		{"PUT /api/roadmaps/{id}/visibility", "PUT", rm("/visibility"), `{"visibility":"public"}`},
		{"DELETE /api/roadmaps/{id}", "DELETE", rm(""), ""},
		{"POST /api/roadmaps/{id}/duplicate", "POST", rm("/duplicate"), `{"name":"Copy"}`},
		{"POST /api/roadmaps/{id}/restore", "POST", rm("/restore"), ""},
		{"DELETE /api/roadmaps/{id}/purge", "DELETE", rm("/purge"), ""},
		{"POST /api/roadmaps/{id}/lanes", "POST", rm("/lanes"), `{"name":"New"}`},
		{"PUT /api/roadmaps/{id}/lane-order", "PUT", rm("/lane-order"), fmt.Sprintf(`{"laneIds":[%d]}`, f.lane)},
		{"PUT /api/roadmaps/{id}/schedule", "PUT", rm("/schedule"), `{"periods":[]}`},

		{"PATCH /api/lanes/{id}", "PATCH", fmt.Sprintf("/api/lanes/%d", f.lane), `{"name":"Stolen"}`},
		{"DELETE /api/lanes/{id}", "DELETE", fmt.Sprintf("/api/lanes/%d", f.lane), ""},
		{"POST /api/lanes/{id}/items", "POST", fmt.Sprintf("/api/lanes/%d/items", f.lane),
			`{"title":"X","startDate":"2026-01-01","endDate":"2026-01-02"}`},
		{"POST /api/lanes/{id}/milestones", "POST", fmt.Sprintf("/api/lanes/%d/milestones", f.lane),
			`{"title":"X","date":"2026-01-01"}`},

		{"PATCH /api/items/{id}", "PATCH", fmt.Sprintf("/api/items/%d", f.item), `{"title":"Stolen"}`},
		{"DELETE /api/items/{id}", "DELETE", fmt.Sprintf("/api/items/%d", f.item), ""},

		{"PATCH /api/milestones/{id}", "PATCH", fmt.Sprintf("/api/milestones/%d", f.milestone), `{"title":"Stolen"}`},
		{"DELETE /api/milestones/{id}", "DELETE", fmt.Sprintf("/api/milestones/%d", f.milestone), ""},

		{"POST /api/roadmaps/{id}/dependencies", "POST", rm("/dependencies"),
			fmt.Sprintf(`{"from":{"kind":"milestone","id":%d},"to":{"kind":"item","id":%d}}`, f.milestone, f.item)},
		{"DELETE /api/dependencies/{id}", "DELETE", fmt.Sprintf("/api/dependencies/%d", f.dependency), ""},

		{"GET /api/snapshots/{id}", "GET", fmt.Sprintf("/api/snapshots/%d", f.snapshot), ""},
		{"PATCH /api/snapshots/{id}", "PATCH", fmt.Sprintf("/api/snapshots/%d", f.snapshot), `{"name":"v1.0"}`},
		{"POST /api/snapshots/{id}/restore", "POST", fmt.Sprintf("/api/snapshots/%d/restore", f.snapshot), ""},
		{"DELETE /api/snapshots/{id}", "DELETE", fmt.Sprintf("/api/snapshots/%d", f.snapshot), ""},

		{"GET /api/roadmaps/{id}/tracker-queries", "GET", rm("/tracker-queries"), ""},
		{"POST /api/roadmaps/{id}/tracker-queries", "POST", rm("/tracker-queries"),
			`{"name":"Stolen","query":"type = Epic"}`},
		{"PATCH /api/tracker-queries/{id}", "PATCH", fmt.Sprintf("/api/tracker-queries/%d", f.trackerQuery), `{"name":"Stolen"}`},
		{"DELETE /api/tracker-queries/{id}", "DELETE", fmt.Sprintf("/api/tracker-queries/%d", f.trackerQuery), ""},

		{"GET /api/roadmaps/{id}/tracker-extractor", "GET", rm("/tracker-extractor"), ""},
		{"PUT /api/roadmaps/{id}/tracker-extractor", "PUT", rm("/tracker-extractor"),
			`{"source":"def get_issue_time_range(issue):\n    return None\n"}`},
		{"DELETE /api/roadmaps/{id}/tracker-extractor", "DELETE", rm("/tracker-extractor"), ""},
		{"POST /api/roadmaps/{id}/tracker-extractor/test", "POST", rm("/tracker-extractor/test"),
			`{"source":"def get_issue_time_range(issue):\n    return None\n","key":"PAY-1"}`},
		{"POST /api/roadmaps/{id}/schedule-check", "POST", rm("/schedule-check"), `{"keys":["PAY-1"]}`},
		{"POST /api/roadmaps/{id}/schedule-check/status", "POST", rm("/schedule-check/status"), `{"keys":["PAY-1"]}`},
	}
}

// callAs is mutateAs with a deadline on the request context. The sweep below
// includes the SSE route, whose handler blocks until its request context ends —
// so if the guard on it ever regressed, the test would hang rather than fail.
// A deadline turns that into a plain failed assertion.
func callAs(t *testing.T, id auth.Identity, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if !id.IsAnonymous() {
		r = r.WithContext(auth.WithIdentity(r.Context(), id))
	}
	w := httptest.NewRecorder()
	testSrv.ServeHTTP(w, r)
	return w
}

// TestPrivateRoadmapIsUnreachable is the security property, stated once and
// checked against every route that can name a private roadmap — directly or via
// one of its lanes, items, milestones or snapshots.
//
// 404 rather than 403 throughout: a roadmap you may not see reads exactly like
// one that does not exist, so nobody can probe for other people's roadmaps by
// watching status codes. This mirrors how a trashed roadmap already behaves.
func TestPrivateRoadmapIsUnreachable(t *testing.T) {
	f := newPrivateFixture(t)
	for _, c := range f.calls() {
		for _, who := range []auth.Identity{outsider, {}} {
			name := c.pattern
			if who.IsAnonymous() {
				name += " (anonymous)"
			}
			t.Run(name, func(t *testing.T) {
				w := callAs(t, who, c.method, c.path, c.body)
				if w.Code != http.StatusNotFound {
					t.Errorf("status = %d, want %d; body %s", w.Code, http.StatusNotFound, w.Body)
				}
			})
		}
	}

	// Nothing above was allowed to take effect: the roadmap is still there,
	// still named what it was, and still private.
	rm, err := testStore.GetRoadmapFull(context.Background(), f.roadmap)
	if err != nil {
		t.Fatalf("the roadmap did not survive the sweep: %v", err)
	}
	if rm.Name != "test-"+t.Name() || rm.Visibility != model.VisibilityPrivate {
		t.Errorf("roadmap = %q/%s, want the original name and private", rm.Name, rm.Visibility)
	}
}

// The positive control for the sweep above: the same routes are not simply
// broken for everyone. Read-only, since the point is only to show the wrapper
// admits the owner.
func TestOwnerReachesOwnPrivateRoadmap(t *testing.T) {
	f := newPrivateFixture(t)
	for _, path := range []string{
		fmt.Sprintf("/api/roadmaps/%d", f.roadmap),
		fmt.Sprintf("/api/roadmaps/%d/export", f.roadmap),
		fmt.Sprintf("/api/roadmaps/%d/contributors", f.roadmap),
		fmt.Sprintf("/api/roadmaps/%d/snapshots", f.roadmap),
		fmt.Sprintf("/api/snapshots/%d", f.snapshot),
	} {
		t.Run(path, func(t *testing.T) {
			if w := mutateAs(t, owner, "GET", path, ""); w.Code != http.StatusOK {
				t.Errorf("status = %d, want 200; body %s", w.Code, w.Body)
			}
		})
	}
}

// Owned is what the client keys the visibility control off, and it is per
// requester rather than a property of the roadmap.
func TestGetRoadmapReportsOwnership(t *testing.T) {
	f := newPrivateFixture(t)
	path := fmt.Sprintf("/api/roadmaps/%d", f.roadmap)

	if got := decodeRoadmap(t, mutateAs(t, owner, "GET", path, "")); !got.Owned {
		t.Error("the owner's own roadmap came back unowned")
	}

	// Public, so the outsider can read it — but still not theirs.
	if _, err := testStore.SetRoadmapVisibility(context.Background(), f.roadmap,
		model.VisibilityPublic, owner.Subject); err != nil {
		t.Fatal(err)
	}
	if got := decodeRoadmap(t, mutateAs(t, outsider, "GET", path, "")); got.Owned {
		t.Error("a roadmap somebody else created came back as owned")
	}
}

// Only the owner may change visibility, and a roadmap nobody owns can never
// change at all — which is every roadmap created before this feature, and every
// roadmap created with auth off.
func TestPutVisibilityRequiresOwnership(t *testing.T) {
	f := newPrivateFixture(t)
	path := fmt.Sprintf("/api/roadmaps/%d/visibility", f.roadmap)

	if w := mutateAs(t, owner, "PUT", path, `{"visibility":"public"}`); w.Code != http.StatusOK {
		t.Fatalf("owner: status %d, body %s", w.Code, w.Body)
	}
	// Now readable by the outsider — who still may not change it.
	if w := mutateAs(t, outsider, "PUT", path, `{"visibility":"private"}`); w.Code != http.StatusNotFound {
		t.Errorf("outsider: status %d, want 404; body %s", w.Code, w.Body)
	}

	unowned := seedRoadmap(t, "test-"+t.Name()+"-unowned") // created with no identity
	w := mutateAs(t, owner, "PUT", fmt.Sprintf("/api/roadmaps/%d/visibility", unowned),
		`{"visibility":"private"}`)
	if w.Code != http.StatusNotFound {
		t.Errorf("unowned roadmap: status %d, want 404; body %s", w.Code, w.Body)
	}
}

// An anonymous caller cannot create a private roadmap, because a private
// roadmap with no owner is one nobody could ever open. This is the only rule in
// the system that depends on who is asking rather than on what they are asking
// about — and even it is a check on the identity, not on the server's mode.
func TestAnonymousCannotCreatePrivateRoadmap(t *testing.T) {
	w := mutateAs(t, auth.Identity{}, "POST", "/api/roadmaps",
		`{"name":"test-`+t.Name()+`","visibility":"private"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", w.Code, w.Body)
	}

	// The same request from a signed-in user is fine.
	w = mutateAs(t, owner, "POST", "/api/roadmaps",
		`{"name":"test-`+t.Name()+`-ok","visibility":"private"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("authenticated private create: status %d, body %s", w.Code, w.Body)
	}
	got := decodeRoadmap(t, w)
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), got.ID) })
	if got.Visibility != model.VisibilityPrivate || !got.Owned {
		t.Errorf("created %+v, want private and owned", got)
	}
}

// Visibility is accepted only where it is honoured. readJSON rejects unknown
// fields, so this is really a guard on the request types staying separate: if
// createRoadmap's body type were ever merged back into the shared nameReq,
// these would start returning 200/201 and silently ignore the field — an API
// that swallows something it does not act on.
func TestVisibilityRejectedOnUnrelatedRoutes(t *testing.T) {
	f := newPrivateFixture(t)
	for _, c := range []apiCall{
		{"PATCH /api/roadmaps/{id}", "PATCH", fmt.Sprintf("/api/roadmaps/%d", f.roadmap),
			`{"name":"Renamed","visibility":"public"}`},
		{"POST /api/roadmaps/{id}/lanes", "POST", fmt.Sprintf("/api/roadmaps/%d/lanes", f.roadmap),
			`{"name":"Lane","visibility":"public"}`},
		{"POST /api/roadmaps/{id}/duplicate", "POST", fmt.Sprintf("/api/roadmaps/%d/duplicate", f.roadmap),
			`{"name":"Copy","visibility":"public"}`},
	} {
		t.Run(c.pattern, func(t *testing.T) {
			if w := callAs(t, owner, c.method, c.path, c.body); w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body %s", w.Code, w.Body)
			}
		})
	}
}

// A new roadmap is public unless asked otherwise, which is what keeps an open
// deployment behaving exactly as it always has.
func TestCreateRoadmapDefaultsToPublic(t *testing.T) {
	w := mutateAs(t, owner, "POST", "/api/roadmaps", `{"name":"test-`+t.Name()+`"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	got := decodeRoadmap(t, w)
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), got.ID) })
	if got.Visibility != model.VisibilityPublic {
		t.Errorf("visibility = %q, want public", got.Visibility)
	}
}

// TestEveryAPIRouteIsClassified is what stops authorization from being lost by
// omission. The check in guard/snap only protects the routes it is wrapped
// around, and nothing in the type system says a new route must be wrapped —
// the trash got that for free by living in the store, and this feature cannot
// (see the comment in store/access.go).
//
// So the routes are read back out of server.go and each /api/ one must be
// accounted for: either it is exercised by the sweep above, or it is listed
// here as needing no roadmap-scoped check, with the reason. Adding a route
// without doing one or the other fails this test.
func TestEveryAPIRouteIsClassified(t *testing.T) {
	// Routes that name no roadmap, and so have nothing to authorize against.
	// Each filters or decides internally instead.
	exempt := map[string]string{
		"GET /api/me":                 "reports the caller's own identity",
		"POST /api/tracker/search":    "deployment-wide external search; contains no roadmap data",
		"GET /api/roadmaps":           "a listing has no id; filtered in SQL by ListRoadmaps",
		"GET /api/roadmaps/trash":     "same, via ListTrashedRoadmaps",
		"POST /api/roadmaps":          "nothing exists yet to authorize",
		"POST /api/roadmaps/import":   "same; the importer becomes the owner",
		"POST /api/roadmaps/transfer": "same; the file names the roadmap, and it must not already exist",
	}

	covered := map[string]bool{}
	for _, c := range (privateFixture{}).calls() {
		covered[c.pattern] = true
	}

	src, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	patterns := regexp.MustCompile(`HandleFunc\("([A-Z]+ /[^"]*)"`).FindAllStringSubmatch(string(src), -1)
	if len(patterns) < 20 {
		t.Fatalf("found only %d routes; the pattern scan is broken, not the routing", len(patterns))
	}
	for _, m := range patterns {
		pattern := m[1]
		if !strings.Contains(pattern, " /api/") {
			continue // /healthz, /readyz and the static handler
		}
		if _, ok := exempt[pattern]; ok {
			continue
		}
		if !covered[pattern] {
			t.Errorf("route %q is not covered by TestPrivateRoadmapIsUnreachable and is not listed as exempt.\n"+
				"Wrap it in guard or snap and add it to privateFixture.calls, or add it to `exempt` with the reason.",
				pattern)
		}
	}
}

func decodeRoadmap(t *testing.T, w *httptest.ResponseRecorder) model.Roadmap {
	t.Helper()
	return decode[model.Roadmap](t, w)
}
