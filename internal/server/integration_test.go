package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/store"
)

// seedProviderConsumer builds a roadmap publishing one integration milestone
// and a second roadmap with a lane and an item to depend on it.
func seedProviderConsumer(t *testing.T) (source model.Milestone, consumerLane int64, work int64, providerRM, consumerRM int64) {
	t.Helper()
	ctx := context.Background()
	mk := func(suffix string) (int64, int64) {
		rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name()+"-"+suffix, store.Ownership{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
		lane, err := testStore.CreateLane(ctx, rm.ID, suffix)
		if err != nil {
			t.Fatal(err)
		}
		return rm.ID, lane.ID
	}
	providerRM, providerLane := mk("provider")
	consumerRM, consumerLane = mk("consumer")

	msdate, _ := model.ParseDate("2026-05-01")
	source, err := testStore.CreateMilestone(ctx, providerLane, store.NewMilestone{
		Title: "API available", Date: msdate, Tentative: true, AtRisk: true, Integration: true})
	if err != nil {
		t.Fatal(err)
	}
	start, _ := model.ParseDate("2026-05-02")
	end, _ := model.ParseDate("2026-06-01")
	it, err := testStore.CreateItem(ctx, consumerLane, store.NewItem{
		Title: "Integrate API", StartDate: start, EndDate: end})
	if err != nil {
		t.Fatal(err)
	}
	return source, consumerLane, it.ID, providerRM, consumerRM
}

// TestIntegrationMilestoneAPI walks the whole consumer gesture through the
// public API: find what can be mirrored, bring it onto a lane through the
// ordinary milestones collection, then depend on it through the ordinary
// dependencies collection.
func TestIntegrationMilestoneAPI(t *testing.T) {
	source, consumerLane, work, _, consumerRM := seedProviderConsumer(t)

	w := do(t, http.MethodGet, "/api/roadmaps/"+itoa(consumerRM)+"/integration-milestones?q=API", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("picker status: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	offered := decode[[]model.IntegrationMilestone](t, w)
	var picked *model.IntegrationMilestone
	for i := range offered {
		if offered[i].UID == source.UID {
			picked = &offered[i]
		}
	}
	if picked == nil {
		t.Fatalf("picker entry for the published milestone: %+v", picked)
	}
	if !picked.Tentative || !picked.AtRisk {
		t.Fatalf("picker entry lost planning signals: %+v", picked)
	}

	w = do(t, http.MethodPost, "/api/lanes/"+itoa(consumerLane)+"/milestones", map[string]any{
		"title": "Vendor API ready", "sourceUid": source.UID,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create mirror: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	mirror := decode[model.Milestone](t, w)
	if !mirror.IsMirror() || mirror.Linkage.SourceUID != source.UID {
		t.Fatalf("created milestone is not a mirror of the source: %+v", mirror.Linkage)
	}
	if mirror.Linkage.Source == nil || mirror.Linkage.Source.MilestoneID != source.ID ||
		mirror.Linkage.Source.RoadmapID == 0 || !mirror.Tentative || !mirror.AtRisk {
		t.Fatalf("created mirror is not resolved: %+v", mirror)
	}

	w = do(t, http.MethodPatch, "/api/milestones/"+itoa(mirror.ID), map[string]any{
		"title": "Vendor API milestone",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("patch mirror: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	patched := decode[model.Milestone](t, w)
	if patched.Linkage.Source == nil || patched.Linkage.Source.MilestoneID != source.ID ||
		!patched.Date.Equal(source.Date.Time) || !patched.Tentative || !patched.AtRisk {
		t.Fatalf("patched mirror is not resolved: %+v", patched)
	}

	w = do(t, http.MethodPost, "/api/roadmaps/"+itoa(consumerRM)+"/dependencies", map[string]any{
		"from": map[string]any{"kind": "milestone", "id": mirror.ID},
		"to":   map[string]any{"kind": "item", "id": work},
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("depend on mirror: want 201, got %d (%s)", w.Code, w.Body.String())
	}

	// The consumer's roadmap read carries the resolved provider side.
	w = do(t, http.MethodGet, "/api/roadmaps/"+itoa(consumerRM), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("read consumer: want 200, got %d", w.Code)
	}
	full := decode[model.RoadmapFull](t, w)
	got := full.Lanes[0].Milestones[0]
	if got.Linkage.Source == nil || got.Linkage.Source.Title != source.Title {
		t.Fatalf("resolved source in the payload: %+v", got.Linkage.Source)
	}
	if !got.Date.Equal(source.Date.Time) {
		t.Errorf("mirror date: got %v, want the source's %v", got.Date, source.Date)
	}

	// A mirror is planned by its source, so the consumer cannot reschedule it.
	w = do(t, http.MethodPatch, "/api/milestones/"+itoa(mirror.ID), map[string]any{
		"date": "2026-12-01"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("reschedule mirror: want 400, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestIntegrationMilestoneUsageAPI pins what the owning roadmap is shown before
// it withdraws a promise: how many roadmaps carry this milestone.
func TestIntegrationMilestoneUsageAPI(t *testing.T) {
	source, consumerLane, work, providerRM, consumerRM := seedProviderConsumer(t)

	linkage := func() model.MilestoneLinkage {
		t.Helper()
		w := do(t, http.MethodGet, "/api/roadmaps/"+itoa(providerRM), nil)
		if w.Code != http.StatusOK {
			t.Fatalf("read provider: want 200, got %d", w.Code)
		}
		full := decode[model.RoadmapFull](t, w)
		return *full.Lanes[0].Milestones[0].Linkage
	}
	if got := linkage(); got.UsedBy != 0 || len(got.Consumers) != 0 {
		t.Fatalf("usage before anything mirrors it: got %+v, want none", got)
	}

	w := do(t, http.MethodPost, "/api/lanes/"+itoa(consumerLane)+"/milestones", map[string]any{
		"sourceUid": source.UID})
	if w.Code != http.StatusCreated {
		t.Fatalf("create mirror: got %d (%s)", w.Code, w.Body.String())
	}
	mirror := decode[model.Milestone](t, w)
	got := linkage()
	if got.UsedBy != 1 || len(got.Consumers) != 1 {
		t.Fatalf("usage with a mirror held for context: got %+v, want one consumer", got)
	}
	consumer := got.Consumers[0]
	if consumer.RoadmapID != consumerRM || consumer.MilestoneID != mirror.ID ||
		consumer.RoadmapName == "" || consumer.Title != mirror.Title {
		t.Errorf("consumer reference in API payload: %+v", consumer)
	}

	w = do(t, http.MethodPost, "/api/roadmaps/"+itoa(consumerRM)+"/dependencies", map[string]any{
		"from": map[string]any{"kind": "milestone", "id": mirror.ID},
		"to":   map[string]any{"kind": "item", "id": work},
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("depend on mirror: got %d (%s)", w.Code, w.Body.String())
	}
	if got := linkage(); got.UsedBy != 1 || len(got.Consumers) != 1 {
		t.Errorf("usage once that mirror also depends on it: got %+v, want one consumer", got)
	}
}
