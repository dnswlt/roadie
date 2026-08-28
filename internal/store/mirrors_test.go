package store

import (
	"context"
	"fmt"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

// provider is a roadmap publishing one integration milestone; consumer is a
// second roadmap with a lane and an item to hang local work on.
type mirrorFixture struct {
	provider     model.Roadmap
	providerLane model.Lane
	source       model.Milestone
	consumer     model.Roadmap
	consumerLane model.Lane
	work         model.Item
}

func newMirrorFixture(t *testing.T) mirrorFixture {
	t.Helper()
	ctx := context.Background()
	f := mirrorFixture{}

	f.provider = newRoadmapNamed(t, "provider")
	lane, err := testStore.CreateLane(ctx, f.provider.ID, "Platform")
	if err != nil {
		t.Fatal(err)
	}
	f.providerLane = lane
	f.source, err = testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "API available", Description: "v1 of the public API",
		Date: date("2026-05-01"), Tentative: true, Integration: true})
	if err != nil {
		t.Fatal(err)
	}

	f.consumer = newRoadmapNamed(t, "consumer")
	f.consumerLane, err = testStore.CreateLane(ctx, f.consumer.ID, "Apps")
	if err != nil {
		t.Fatal(err)
	}
	f.work, err = testStore.CreateItem(ctx, f.consumerLane.ID, NewItem{
		Title: "Integrate API", StartDate: date("2026-05-02"), EndDate: date("2026-06-01")})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// newRoadmapNamed is newRoadmap with a suffix, for tests needing two roadmaps.
func newRoadmapNamed(t *testing.T, suffix string) model.Roadmap {
	t.Helper()
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name()+"-"+suffix, Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	return rm
}

// mirror adds a mirror of f.source to the consumer's lane.
func (f mirrorFixture) mirror(t *testing.T, title string) model.Milestone {
	t.Helper()
	m, err := testStore.CreateMilestone(context.Background(), f.consumerLane.ID,
		NewMilestone{Title: title, SourceUID: f.source.UID})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// find returns the consumer's stored copy of milestone id from a resolved read.
func (f mirrorFixture) resolved(t *testing.T, id int64) model.Milestone {
	t.Helper()
	ctx := context.Background()
	full, err := testStore.GetRoadmapFull(ctx, f.consumer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.ResolveMirrors(ctx, &full); err != nil {
		t.Fatal(err)
	}
	for _, lane := range full.Lanes {
		for _, ms := range lane.Milestones {
			if ms.ID == id {
				return ms
			}
		}
	}
	t.Fatalf("milestone %d not in consumer roadmap", id)
	return model.Milestone{}
}

func TestMirrorCreation(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)

	m := f.mirror(t, "Partner API ready")
	if !m.IsMirror() || m.Linkage.SourceUID != f.source.UID {
		t.Fatalf("mirror source: got %+v, want a mirror of %q", m.Linkage, f.source.UID)
	}
	if m.Linkage.Source == nil || m.Linkage.Source.MilestoneID != f.source.ID ||
		m.Linkage.Source.RoadmapID != f.provider.ID {
		t.Fatalf("created mirror source is not resolved: %+v", m.Linkage.Source)
	}
	if m.UID == f.source.UID {
		t.Errorf("mirror reused the source UID; it is a row of its own")
	}
	if m.Title != "Partner API ready" {
		t.Errorf("consumer title overwritten: %q", m.Title)
	}
	// The provider owns the schedule. Creation returns its resolved values while
	// the mirror row keeps the date as its fallback cache.
	if !m.Date.Equal(f.source.Date.Time) {
		t.Errorf("cached date: got %v, want %v", m.Date, f.source.Date)
	}
	if !m.Tentative {
		t.Errorf("create response did not project the source's tentative state")
	}
	if m.IsIntegration() {
		t.Errorf("a mirror must not be an integration milestone")
	}

	// An empty title adopts the source's, so bringing a published milestone
	// onto a lane needs nothing but the source.
	bare, err := testStore.CreateMilestone(ctx, f.consumerLane.ID,
		NewMilestone{SourceUID: f.source.UID})
	if !isValidation(err) {
		t.Fatalf("second mirror of the same source: got (%+v, %v), want validation error", bare, err)
	}
	second := newRoadmapNamed(t, "second-consumer")
	lane, err := testStore.CreateLane(ctx, second.ID, "Ops")
	if err != nil {
		t.Fatal(err)
	}
	bare, err = testStore.CreateMilestone(ctx, lane.ID, NewMilestone{SourceUID: f.source.UID})
	if err != nil {
		t.Fatal(err)
	}
	if bare.Title != f.source.Title {
		t.Errorf("untitled mirror: got %q, want the source's %q", bare.Title, f.source.Title)
	}
}

func TestMirrorCreationRejections(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)

	unpublished, err := testStore.CreateMilestone(ctx, f.providerLane.ID,
		NewMilestone{Title: "Internal checkpoint", Date: date("2026-04-01")})
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		lane int64
		n    NewMilestone
	}{
		{"unpublished source", f.consumerLane.ID, NewMilestone{SourceUID: unpublished.UID}},
		{"unknown source", f.consumerLane.ID,
			NewMilestone{SourceUID: "00000000-0000-0000-0000-000000000000"}},
		{"malformed source", f.consumerLane.ID, NewMilestone{SourceUID: "not-a-uuid"}},
		{"own roadmap", f.providerLane.ID, NewMilestone{SourceUID: f.source.UID}},
		{"mirror that publishes", f.consumerLane.ID,
			NewMilestone{SourceUID: f.source.UID, Integration: true}},
	}
	for _, c := range cases {
		if _, err := testStore.CreateMilestone(ctx, c.lane, c.n); !isValidation(err) {
			t.Errorf("%s: got %v, want validation error", c.name, err)
		}
	}
}

func TestMirrorIsPlannedByItsSource(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")

	rejected := []struct {
		name  string
		patch MilestonePatch
	}{
		{"date", MilestonePatch{Date: model.Opt[model.Date]{Set: true, Value: date("2026-09-01")}}},
		{"tentative", MilestonePatch{Tentative: model.Opt[bool]{Set: true, Value: true}}},
		{"integration", MilestonePatch{Integration: model.Opt[bool]{Set: true, Value: true}}},
	}
	for _, c := range rejected {
		if _, err := testStore.UpdateMilestone(ctx, m.ID, c.patch); !isValidation(err) {
			t.Errorf("patch mirror %s: got %v, want validation error", c.name, err)
		}
	}

	// Lane, title and description stay the consumer's to change.
	renamed, err := testStore.UpdateMilestone(ctx, m.ID, MilestonePatch{
		Title:       model.Opt[string]{Set: true, Value: "Vendor API"},
		Description: model.Opt[string]{Set: true, Value: "what we integrate against"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Title != "Vendor API" || renamed.Description != "what we integrate against" {
		t.Errorf("consumer-owned fields not applied: %+v", renamed)
	}
	if renamed.Linkage.Source == nil || renamed.Linkage.Source.MilestoneID != f.source.ID ||
		!renamed.Date.Equal(f.source.Date.Time) || !renamed.Tentative {
		t.Errorf("updated mirror is not resolved: %+v", renamed)
	}
}

func TestMirrorEdgeRules(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")

	local, err := testStore.CreateMilestone(ctx, f.consumerLane.ID,
		NewMilestone{Title: "Integration ready", Date: date("2026-06-01")})
	if err != nil {
		t.Fatal(err)
	}

	// Items import: the mirror is the prerequisite of local work.
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), itemRef(f.work.ID)); err != nil {
		t.Fatalf("mirror -> item: %v", err)
	}
	// ... and that local work is what the consumer's own milestone hangs off.
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, itemRef(f.work.ID), msRef(local.ID)); err != nil {
		t.Fatalf("item -> milestone: %v", err)
	}
	// A milestone must not chain straight off another roadmap's milestone, and
	// a mirror must not depend on anything at all.
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), msRef(local.ID)); !isValidation(err) {
		t.Errorf("mirror -> milestone: got %v, want validation error", err)
	}
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, itemRef(f.work.ID), msRef(m.ID)); !isValidation(err) {
		t.Errorf("item -> mirror: got %v, want validation error", err)
	}
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(local.ID), msRef(m.ID)); !isValidation(err) {
		t.Errorf("milestone -> mirror: got %v, want validation error", err)
	}
}

func TestNewMirrorEdgeNeedsALivePromise(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")

	// The provider withdraws the promise.
	if _, err := testStore.UpdateMilestone(ctx, f.source.ID, MilestonePatch{
		Integration: model.Opt[bool]{Set: true, Value: false}}); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), itemRef(f.work.ID)); !isValidation(err) {
		t.Errorf("edge from an unpublished source: got %v, want validation error", err)
	}
}

func TestMirrorResolution(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")

	got := f.resolved(t, m.ID)
	if got.Linkage.Source == nil {
		t.Fatalf("source not resolved")
	}
	if got.Linkage.Source.RoadmapID != f.provider.ID || got.Linkage.Source.Title != f.source.Title {
		t.Errorf("provenance: %+v", got.Linkage.Source)
	}
	if got.Title != "Partner API ready" {
		t.Errorf("source title overwrote the mirror's: %q", got.Title)
	}

	// The provider reschedules and marks the date an estimate: both reach the
	// consumer, and the cache follows so a later break lands on the new date.
	if _, err := testStore.UpdateMilestone(ctx, f.source.ID, MilestonePatch{
		Date:      model.Opt[model.Date]{Set: true, Value: date("2026-07-15")},
		Tentative: model.Opt[bool]{Set: true, Value: true},
	}); err != nil {
		t.Fatal(err)
	}
	got = f.resolved(t, m.ID)
	if !got.Date.Equal(date("2026-07-15").Time) || !got.Tentative {
		t.Errorf("provider reschedule not reflected: date=%v tentative=%v", got.Date, got.Tentative)
	}

	// Deleting the source leaves a broken mirror at the last date it knew,
	// which is the refreshed one rather than the one it was created with.
	if err := testStore.DeleteMilestone(ctx, f.source.ID); err != nil {
		t.Fatal(err)
	}
	got = f.resolved(t, m.ID)
	if got.Linkage.Source != nil {
		t.Fatalf("deleted source still resolves: %+v", got.Linkage.Source)
	}
	if !got.Date.Equal(date("2026-07-15").Time) {
		t.Errorf("broken mirror moved: got %v, want the cached 2026-07-15", got.Date)
	}
	if got.Tentative {
		t.Errorf("broken mirror reports a tentative state nobody owns")
	}
}

func TestBrokenMirrorKeepsItsDependencies(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), itemRef(f.work.ID)); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteMilestone(ctx, f.source.ID); err != nil {
		t.Fatal(err)
	}
	full, err := testStore.GetRoadmapFull(ctx, f.consumer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Dependencies) != 1 {
		t.Fatalf("dependencies after the source vanished: %+v", full.Dependencies)
	}

	// Removing the mirror is what removes them: a dependency on an external
	// source cannot outlive the mirror that stands for it.
	if err := testStore.DeleteMilestone(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	full, err = testStore.GetRoadmapFull(ctx, f.consumer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Dependencies) != 0 {
		t.Errorf("edges outlived their mirror: %+v", full.Dependencies)
	}
}

func TestIntegrationMilestoneUsage(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")

	usedBy := func() int {
		t.Helper()
		full, err := testStore.GetRoadmapFull(ctx, f.provider.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := testStore.ResolveMirrors(ctx, &full); err != nil {
			t.Fatal(err)
		}
		for _, lane := range full.Lanes {
			for _, ms := range lane.Milestones {
				if ms.ID == f.source.ID {
					return ms.Linkage.UsedBy
				}
			}
		}
		t.Fatal("source milestone missing from its own roadmap")
		return 0
	}

	// The count is "how many roadmaps carry this", not "how many formally
	// depend on it": deleting the source breaks a mirror either way, so a
	// mirror held only to watch the date still counts.
	if n := usedBy(); n != 1 {
		t.Errorf("usedBy with a bare mirror: got %d, want 1", n)
	}
	updated, err := testStore.UpdateMilestone(ctx, f.source.ID, MilestonePatch{
		Title: model.Opt[string]{Set: true, Value: "API available soon"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Linkage == nil || updated.Linkage.UsedBy != 1 {
		t.Errorf("updated integration milestone usage: got %+v, want usedBy 1", updated.Linkage)
	}
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), itemRef(f.work.ID)); err != nil {
		t.Fatal(err)
	}
	if n := usedBy(); n != 1 {
		t.Errorf("usedBy once that mirror also depends on it: got %d, want 1", n)
	}

	// A second consuming roadmap is a second count.
	other := newRoadmapNamed(t, "other-consumer")
	lane, err := testStore.CreateLane(ctx, other.ID, "Ops")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{SourceUID: f.source.UID}); err != nil {
		t.Fatal(err)
	}
	if n := usedBy(); n != 2 {
		t.Errorf("usedBy with two consuming roadmaps: got %d, want 2", n)
	}
}

func TestIntegrationMilestoneSearch(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)

	// Terms are ANDed across title, roadmap and description. "provider" comes
	// from the roadmap name and "public" from the milestone description.
	list, err := testStore.SearchIntegrationMilestones(ctx, f.consumer.ID, "PROVIDER public")
	if err != nil {
		t.Fatal(err)
	}
	found := func() *model.IntegrationMilestone {
		for i := range list {
			if list[i].UID == f.source.UID {
				return &list[i]
			}
		}
		return nil
	}
	got := found()
	if got == nil {
		t.Fatalf("published milestone missing from the picker")
	}
	if got.RoadmapID != f.provider.ID {
		t.Errorf("picker entry: %+v", got)
	}

	f.mirror(t, "Partner API ready")
	list, err = testStore.SearchIntegrationMilestones(ctx, f.consumer.ID, "API")
	if err != nil {
		t.Fatal(err)
	}
	if got = found(); got != nil {
		t.Errorf("already-mirrored source was offered again: %+v", got)
	}

	// A roadmap never offers its own milestones: mirroring one locally is not a
	// cross-roadmap sync point.
	list, err = testStore.SearchIntegrationMilestones(ctx, f.provider.ID, "API")
	if err != nil {
		t.Fatal(err)
	}
	if found() != nil {
		t.Errorf("provider offered its own milestone")
	}
}

func TestIntegrationMilestoneSearchIsBounded(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	needle := fmt.Sprintf("limitneedle-%d", f.provider.ID)
	for i := 0; i <= integrationMilestoneSearchLimit; i++ {
		if _, err := testStore.CreateMilestone(ctx, f.providerLane.ID, NewMilestone{
			Title: fmt.Sprintf("%s %02d", needle, i), Date: date("2026-06-01"), Integration: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	list, err := testStore.SearchIntegrationMilestones(ctx, f.consumer.ID, needle)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != integrationMilestoneSearchLimit {
		t.Fatalf("search returned %d milestones, want the %d-result bound", len(list), integrationMilestoneSearchLimit)
	}
	if list[len(list)-1].Title != fmt.Sprintf("%s 49", needle) {
		t.Errorf("bounded search order ends at %q", list[len(list)-1].Title)
	}
}

// TestCrossRoadmapLinksNeedTwoPublicRoadmaps pins the rule that makes every
// other query here caller-independent. Publishing to an audience you have
// restricted is a contradiction, and a private consumer would leave the provider
// unable to name who depends on it.
func TestCrossRoadmapLinksNeedTwoPublicRoadmaps(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)

	private := func(suffix string) model.Roadmap {
		t.Helper()
		rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name()+"-"+suffix, Ownership{
			Visibility: model.VisibilityPrivate, Owner: "sub-owner"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
		return rm
	}

	// A private roadmap cannot publish.
	provider := private("provider")
	providerLane, err := testStore.CreateLane(ctx, provider.ID, "Secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateMilestone(ctx, providerLane.ID, NewMilestone{
		Title: "Regulatory approval", Date: date("2026-08-01"), Integration: true}); !isValidation(err) {
		t.Errorf("publish from a private roadmap: got %v, want validation error", err)
	}
	hidden, err := testStore.CreateMilestone(ctx, providerLane.ID, NewMilestone{
		Title: "Regulatory approval", Date: date("2026-08-01")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.UpdateMilestone(ctx, hidden.ID, MilestonePatch{
		Integration: model.Opt[bool]{Set: true, Value: true}}); !isValidation(err) {
		t.Errorf("publish by patch from a private roadmap: got %v, want validation error", err)
	}

	// A private roadmap cannot consume either, and is offered nothing.
	consumer := private("consumer")
	consumerLane, err := testStore.CreateLane(ctx, consumer.ID, "Apps")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateMilestone(ctx, consumerLane.ID,
		NewMilestone{SourceUID: f.source.UID}); !isValidation(err) {
		t.Errorf("mirror into a private roadmap: got %v, want validation error", err)
	}
	list, err := testStore.SearchIntegrationMilestones(ctx, consumer.ID, "approval")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("private roadmap offered %d integration milestones", len(list))
	}
}

// TestGoingPrivateBreaksTheLink pins what happens after the fact: nothing is
// blocked or deleted, the views simply follow the current state — the same way
// they do when a source is unpublished or deleted.
func TestGoingPrivateBreaksTheLink(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), itemRef(f.work.ID)); err != nil {
		t.Fatal(err)
	}
	// Ownership is what allows the flip, so the provider needs an owner.
	owned, err := testStore.CreateRoadmap(ctx, "test-"+t.Name()+"-owned", Ownership{Owner: "sub-owner"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), owned.ID) })
	lane, err := testStore.CreateLane(ctx, owned.ID, "Platform")
	if err != nil {
		t.Fatal(err)
	}
	src, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Infrastructure ready", Date: date("2026-05-01"), Integration: true})
	if err != nil {
		t.Fatal(err)
	}
	mirror, err := testStore.CreateMilestone(ctx, f.consumerLane.ID, NewMilestone{SourceUID: src.UID})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.resolved(t, mirror.ID); got.Linkage.Source == nil {
		t.Fatalf("source not resolved while public")
	}

	if _, err := testStore.SetRoadmapVisibility(ctx, owned.ID, model.VisibilityPrivate, "sub-owner"); err != nil {
		t.Fatal(err)
	}
	got := f.resolved(t, mirror.ID)
	if got.Linkage.Source != nil {
		t.Errorf("private source still resolves: %+v", got.Linkage.Source)
	}
	if !got.Date.Equal(src.Date.Time) {
		t.Errorf("broken mirror moved off its cached date: %v", got.Date)
	}

	// Once private, provider edits no longer propagate into public consumers.
	// The mirror stays at the last date the provider exposed publicly.
	if _, err := testStore.UpdateMilestone(ctx, src.ID, MilestonePatch{
		Date: model.Opt[model.Date]{Set: true, Value: date("2026-09-01")},
	}); err != nil {
		t.Fatal(err)
	}
	got = f.resolved(t, mirror.ID)
	if got.Linkage.Source != nil {
		t.Errorf("private source resolved after a schedule edit: %+v", got.Linkage.Source)
	}
	if !got.Date.Equal(src.Date.Time) {
		t.Errorf("private source edit changed the cached date: got %v, want %v", got.Date, src.Date)
	}
}

func TestMirrorsSurviveCopyRestoreAndTransfer(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	m := f.mirror(t, "Partner API ready")
	if _, err := testStore.CreateDependency(ctx, f.consumer.ID, msRef(m.ID), itemRef(f.work.ID)); err != nil {
		t.Fatal(err)
	}

	// A duplicate is an independent roadmap, so its mirror is a new row — but
	// of the same source, or it would be a mirror of nothing.
	copyRM, err := testStore.DuplicateRoadmap(ctx, f.consumer.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), copyRM.ID) })
	copied := onlyMirror(t, copyRM.ID)
	if copied.Linkage.SourceUID != f.source.UID {
		t.Errorf("copied mirror source: got %q, want %q", copied.Linkage.SourceUID, f.source.UID)
	}
	if copied.UID == m.UID {
		t.Errorf("copied mirror kept the original's own UID")
	}
	copyFull, err := testStore.GetRoadmapFull(ctx, copyRM.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(copyFull.Dependencies) != 1 {
		t.Errorf("copied edges: %+v", copyFull.Dependencies)
	}

	// A restore puts back the same logical mirror, identity included.
	snap, err := testStore.CreateSnapshot(ctx, f.consumer.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteMilestone(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	restored := onlyMirror(t, f.consumer.ID)
	if restored.ID != m.ID || restored.UID != m.UID || restored.Linkage.SourceUID != f.source.UID {
		t.Errorf("restored mirror: got %+v, want id/uid/source of %+v", restored, m)
	}

	// A transfer moves the same logical roadmap, so both identities survive.
	exported, err := testStore.GetRoadmapFull(ctx, copyRM.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The copy has to go before its identity can come back: a transfer refuses
	// to bring in a roadmap or milestone UID that is already here.
	if err := testStore.DeleteRoadmap(ctx, copyRM.ID); err != nil {
		t.Fatal(err)
	}
	moved, err := testStore.ImportRoadmap(ctx, exported, Ownership{}, ImportTransfer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), moved.ID) })
	transferred := onlyMirror(t, moved.ID)
	if transferred.UID != copied.UID || transferred.Linkage.SourceUID != f.source.UID {
		t.Errorf("transferred mirror: got %+v, want uid %q", transferred, copied.UID)
	}
}

// onlyMirror returns the single mirror milestone of a roadmap.
func onlyMirror(t *testing.T, roadmapID int64) model.Milestone {
	t.Helper()
	full, err := testStore.GetRoadmapFull(context.Background(), roadmapID)
	if err != nil {
		t.Fatal(err)
	}
	var found []model.Milestone
	for _, lane := range full.Lanes {
		for _, ms := range lane.Milestones {
			if ms.IsMirror() {
				found = append(found, ms)
			}
		}
	}
	if len(found) != 1 {
		t.Fatalf("roadmap %d: got %d mirrors, want 1", roadmapID, len(found))
	}
	return found[0]
}

func TestImportRejectsMalformedMirrors(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)
	f.mirror(t, "Partner API ready")

	base, err := testStore.GetRoadmapFull(ctx, f.consumer.ID)
	if err != nil {
		t.Fatal(err)
	}

	bad := func(mutate func(*model.RoadmapFull)) model.RoadmapFull {
		src := base
		src.Lanes = append([]model.LaneFull(nil), base.Lanes...)
		for i := range src.Lanes {
			src.Lanes[i].Milestones = append([]model.Milestone(nil), base.Lanes[i].Milestones...)
			// Linkage is a pointer, so a shallow milestone copy would let one
			// case's mutation leak into the next.
			for j := range src.Lanes[i].Milestones {
				if l := src.Lanes[i].Milestones[j].Linkage; l != nil {
					copied := *l
					src.Lanes[i].Milestones[j].Linkage = &copied
				}
			}
		}
		mutate(&src)
		return src
	}
	mirrorAt := func(src *model.RoadmapFull) *model.Milestone {
		for li := range src.Lanes {
			for mi := range src.Lanes[li].Milestones {
				if src.Lanes[li].Milestones[mi].IsMirror() {
					return &src.Lanes[li].Milestones[mi]
				}
			}
		}
		t.Fatal("fixture has no mirror")
		return nil
	}

	cases := []struct {
		name   string
		mutate func(*model.RoadmapFull)
	}{
		{"mirror that publishes", func(src *model.RoadmapFull) { mirrorAt(src).Linkage.Integration = true }},
		{"malformed source", func(src *model.RoadmapFull) { mirrorAt(src).Linkage.SourceUID = "nope" }},
		{"two mirrors of one source", func(src *model.RoadmapFull) {
			orig := mirrorAt(src)
			dup := *orig
			dup.ID, dup.UID = 0, ""
			linkage := *orig.Linkage
			dup.Linkage = &linkage
			src.Lanes[0].Milestones = append(src.Lanes[0].Milestones, dup)
		}},
	}
	for _, c := range cases {
		rm, err := testStore.ImportRoadmap(ctx, bad(c.mutate), Ownership{}, ImportCopy)
		if err == nil {
			testStore.DeleteRoadmap(ctx, rm.ID)
			t.Errorf("%s: import accepted", c.name)
			continue
		}
		if !isValidation(err) {
			t.Errorf("%s: got %v, want validation error", c.name, err)
		}
	}
}

// A mirror source must be external in the payload itself. Import rejects a file
// that names one of its own milestones regardless of how the chosen mode would
// rewrite that milestone's UID.
func TestImportRejectsSelfMirror(t *testing.T) {
	ctx := context.Background()
	f := newMirrorFixture(t)

	src, err := testStore.GetRoadmapFull(ctx, f.provider.ID)
	if err != nil {
		t.Fatal(err)
	}
	src.Lanes[0].Milestones = append(src.Lanes[0].Milestones, model.Milestone{
		UID:   "11111111-2222-3333-4444-555555555555",
		Title: "Mirror of our own promise",
		Date:  date("2026-05-01"),
		Linkage: &model.MilestoneLinkage{
			SourceUID: f.source.UID,
		},
	})
	// Transfer refuses identities that are already here, so remove the original
	// before exercising both import modes against the same malformed file.
	if err := testStore.DeleteRoadmap(ctx, f.provider.ID); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []ImportMode{ImportCopy, ImportTransfer} {
		rm, err := testStore.ImportRoadmap(ctx, src, Ownership{}, mode)
		if err == nil {
			testStore.DeleteRoadmap(ctx, rm.ID)
			t.Errorf("%s accepted a roadmap mirroring its own milestone", mode)
			continue
		}
		if !isValidation(err) {
			t.Errorf("%s: got %v, want validation error", mode, err)
		}
	}
}
