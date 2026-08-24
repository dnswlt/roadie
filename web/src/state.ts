import { DEFAULT_PX_PER_DAY, type SnapMode } from "./timescale";
import { analyzeDependencies, type DependencyAnalysis } from "./deps-graph";
import {
  itemPredicate,
  project,
  type Filter,
  type Projection,
  type SignalFilterKind,
} from "./filter";
import type {
  Contributor,
  Item,
  ItemFull,
  LaneFull,
  Me,
  Milestone,
  Roadmap,
  RoadmapFull,
  Snapshot,
} from "./types";

// Edit-panel width (px). A global view preference, persisted in localStorage
// and adjustable by dragging the panel's left edge.
export const DEFAULT_PANEL_WIDTH = 420;
export const MIN_PANEL_WIDTH = 300;
export const MAX_PANEL_WIDTH = 760;

export interface ItemLocation {
  item: Item;
  lane: LaneFull;
  parent: ItemFull | null;
}

export interface MilestoneLocation {
  milestone: Milestone;
  lane: LaneFull;
}

export type { Filter } from "./filter";

// Which projection is on screen: the timeline chart (render.ts), the WBS
// outline (wbs.ts), or the Jira Recon view (recon.ts). The chart modes render
// the roadmap from this state; only app.ts branches on viewMode. Recon holds
// its tracker data in its own module — none of it is roadmap content.
export type ChartMode = "timeline" | "wbs";
export type ViewMode = ChartMode | "recon";

// AppState is the single source of truth on the client. All views render
// from it; mutations go through actions.ts, which keeps it in sync with
// the server.
class AppState {
  roadmaps: Roadmap[] = [];

  // The open roadmap. Assigning one invalidates everything derived from it, so
  // a reader can never be handed a projection or dependency graph belonging to
  // the roadmap before it; in-place edits are covered by notify().
  private currentValue: RoadmapFull | null = null;

  get current(): RoadmapFull | null {
    return this.currentValue;
  }

  set current(next: RoadmapFull | null) {
    this.currentValue = next;
    this.invalidateDerived();
  }
  // Identity and runtime capabilities from /api/me, fetched once at boot —
  // neither can change without a page load. Visibility decisions still arrive
  // on each roadmap as `visibility`/`owned`; auth mode is not a permission
  // system in the frontend.
  me: Me = { mode: "open", authenticated: false, trackerAvailable: false };
  // The set of selected items. Usually empty or a single item; shift-click
  // builds a multi-selection that drags together (time-shift only). The item
  // and milestone selections are mutually exclusive (item vs. milestone
  // editor). A transient view state, never persisted.
  selectedItemIds = new Set<number>();
  selectedMilestoneId: number | null = null;

  // selectedItemId is the item shown in the edit panel: defined only when
  // exactly one item is selected. A multi-selection (or none) yields null, so
  // the panel hides itself — see panel.ts.
  get selectedItemId(): number | null {
    return this.selectedItemIds.size === 1 ? [...this.selectedItemIds][0]! : null;
  }

  isItemSelected(id: number): boolean {
    return this.selectedItemIds.has(id);
  }

  hasMultiSelection(): boolean {
    return this.selectedItemIds.size > 1;
  }
  pxPerDay = DEFAULT_PX_PER_DAY;
  // Calendar grid a dragged/resized edge snaps to (in addition to always-on
  // item-edge snapping). A global view preference, persisted in localStorage.
  snapMode: SnapMode = "week";
  // Timeline, WBS outline, or Jira Recon. The chart modes are a global view
  // preference like snapMode — a way of working, not a property of any one
  // roadmap — persisted in localStorage (read at boot in app.ts) and toggled
  // by "v" and the topbar button. Recon is a task you visit, not a way of
  // working, so it is never persisted: a reload lands on the chart. It is
  // entered by "r" or its own button, never by the chart cycle.
  viewMode: ViewMode = "timeline";
  // The chart view to return to when leaving Recon.
  private lastChartMode: ChartMode = "timeline";
  panelWidth = DEFAULT_PANEL_WIDTH;
  // The edit rail is a fixture, not a popup: it keeps its width whatever is
  // selected, so the chart never resizes under the pointer mid-task. Collapsing
  // is the only thing that narrows it, and selecting never brings it back — only
  // an explicit edit does (see focusPanelTitle). Persisted in localStorage like
  // panelWidth (read at boot in app.ts).
  panelCollapsed = false;
  // The item filter: when set, chart views show only matching items. A
  // transient "what's relevant right now" view, not persisted. Several labels
  // can be picked at once (matching is OR — an item needs any one of them),
  // but labels and each attention signal stay exclusive: they are one field,
  // not two, since filtering on both at once has no meaning.
  //
  // Assignment invalidates what is derived from it, so no caller has to
  // remember to notify before the next read. Every active filter also becomes
  // the recent filter for `f` (see resetFilter, which forgets it too).
  private filterValue: Filter | null = null;
  private recentFilter: Filter | null = null;

  get filter(): Filter | null {
    return this.filterValue;
  }

  set filter(next: Filter | null) {
    if (next !== null) this.recentFilter = next;
    this.filterValue = next;
    this.invalidateDerived();
  }

  // resetFilter is selectRoadmap's "leaving this roadmap" call. `f` is a quick
  // toggle for switching views back and forth while working a single roadmap —
  // a filter naming a label or referring to that roadmap's own dependency
  // conflicts has no meaning on a different one, so the memory goes with the
  // switch rather than resurfacing on whatever roadmap is opened next.
  resetFilter(): void {
    this.filterValue = null;
    this.recentFilter = null;
    this.invalidateDerived();
  }
  // Set after loading a roadmap so the chart scrolls to today once.
  scrollToToday = false;
  // Set when a selection should be scrolled into view once (e.g. a deep link
  // opened with #item-/#milestone-). Takes precedence over scrollToToday.
  scrollToSelection = false;
  // Lanes hidden from the chart. Purely a view preference (not part of the
  // data model), persisted per roadmap in localStorage.
  hiddenLanes = new Set<number>();
  // Parent items whose children are folded away. Like hiddenLanes: a view
  // preference, per roadmap, never sent to the server.
  collapsed = new Set<number>();
  // Lanes whose "Milestones" group is folded in the WBS view. Keyed by lane
  // id — the group is a WBS fixture, not an item, so it cannot live in
  // `collapsed` (item ids and lane ids would collide). Same lifecycle as the
  // other two: per roadmap, localStorage, never sent to the server.
  wbsMsCollapsed = new Set<number>();

  // Version-history browsing. `history` holds the loaded snapshot list while
  // the history side-list is open (null = closed). `preview` is set when a
  // specific snapshot is loaded into `current` for read-only viewing. While
  // `preview` is set, every mutation is blocked (actions.ts / dnd.ts) — it is
  // the single source of truth for "am I looking at a snapshot", so no
  // read-only flag has to be threaded through the render/menu code.
  //
  // `compare` is the live roadmap, fetched when the banner's "Show changes"
  // was toggled on; present iff the diff view is on screen (diff-view.ts
  // renders current-vs-compare, i.e. snapshot-vs-live). It rides inside
  // `preview` because comparing without a previewed snapshot has no meaning —
  // dropping preview can never leave a stray diff behind. The copy is as old
  // as the toggle; a remote edit meanwhile raises the usual stale pill.
  history: Snapshot[] | null = null;
  preview: { snapshotId: number; createdAt: string; compare?: RoadmapFull } | null = null;
  // Who has edited this roadmap, loaded alongside `history` and shown above it.
  // Empty when nobody is recorded, which is the normal case with auth off — the
  // header then hides itself. Unlike `history` this needs no null/closed state:
  // it is only ever read while the history side-list is open.
  contributors: Contributor[] = [];

  // Set when an SSE change event arrived while it was unsafe to auto-refresh
  // (a drag, a focused edit field, or a snapshot preview). Drives the "Updated
  // elsewhere · Refresh" pill; cleared once the pending refresh is applied. See
  // events.ts.
  stale = false;

  private listeners: Array<() => void> = [];

  subscribe(fn: () => void): void {
    this.listeners.push(fn);
  }

  // notify() commits a view state rather than only announcing one: what is
  // derived from the model is dropped, selections that fell off screen go with
  // it, then every subscriber redraws. Both steps live here because this is the
  // one boundary meaning "the model or the view prefs changed".
  notify(): void {
    this.invalidateDerived();
    this.pruneSelection();
    for (const fn of this.listeners) fn();
  }

  // Everything derived from the model and the view prefs, dropped together.
  // Reached three ways — a new roadmap, a new filter, a notify after an
  // in-place edit — so no caller needs to know what the list holds.
  private invalidateDerived(): void {
    this.depAnalysis = null;
    this.proj = null;
  }

  // The roadmap's dependency graph. The timeline, the WBS, the overlay and the
  // conflict filter all want it within one pass, so it is computed once per
  // change rather than once per caller. notifySelection() does not invalidate
  // it: a selection change cannot move a date or an edge.
  private depAnalysis: DependencyAnalysis | null = null;

  dependencyAnalysis(): DependencyAnalysis {
    return (this.depAnalysis ??= analyzeDependencies(this.current));
  }

  // What the chart views draw. Every reader asks here rather than rebuilding
  // the rule from the model, the hidden contexts, the folds and the filter.
  private proj: Projection | null = null;

  projection(): Projection {
    return (this.proj ??= project(this.current?.lanes ?? [], {
      isLaneHidden: (id) => this.isLaneHidden(id),
      isFolded: (id) => this.rendersCollapsed(id),
      match: itemPredicate(this.filter, this.dependencyConflictItemIds()),
    }));
  }

  // Selection is a subset of what is on screen: narrowing the view discards
  // what it removed, and widening never brings it back.
  //
  // Milestones are never filtered, so only a hidden context or a vanished
  // milestone takes one off screen. The WBS milestone fold is view-local — the
  // timeline always draws milestones — so it drops its own selection as it
  // folds (setMilestonesCollapsed) instead of being answered here.
  private pruneSelection(): void {
    const drawn = this.projection().drawnItemIds;
    for (const id of [...this.selectedItemIds]) {
      if (!drawn.has(id)) this.selectedItemIds.delete(id);
    }
    if (this.selectedMilestoneId !== null) {
      const loc = this.findMilestone(this.selectedMilestoneId);
      if (!loc || this.isLaneHidden(loc.lane.id)) this.selectedMilestoneId = null;
    }
  }

  // The narrower of the two invalidation scopes: selection-only changes,
  // projected onto the existing chart DOM instead of rebuilding it (see
  // render.ts projectSelection; rationale in AGENTS.md). notify() is the
  // superset — when in doubt, use it.
  private selectionListeners: Array<() => void> = [];

  subscribeSelection(fn: () => void): void {
    this.selectionListeners.push(fn);
  }

  notifySelection(): void {
    for (const fn of this.selectionListeners) fn();
  }

  findLane(id: number): LaneFull | null {
    return this.current?.lanes.find((l) => l.id === id) ?? null;
  }

  isLaneHidden(id: number): boolean {
    return this.hiddenLanes.has(id);
  }

  private hiddenKey(): string | null {
    return this.current ? `roadie.hidden.${this.current.id}` : null;
  }

  // Loads the hidden-lane set for the current roadmap from localStorage.
  // Call after `current` is set. Prunes ids for lanes that no longer exist.
  loadHiddenLanes(): void {
    this.hiddenLanes = new Set();
    const key = this.hiddenKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const ids = JSON.parse(raw) as number[];
      for (const id of ids) {
        if (this.current?.lanes.some((l) => l.id === id)) this.hiddenLanes.add(id);
      }
    } catch {
      // Corrupt entry — ignore and treat all lanes as visible.
    }
  }

  setLaneHidden(id: number, hidden: boolean): void {
    if (hidden) this.hiddenLanes.add(id);
    else this.hiddenLanes.delete(id);
    this.persistHiddenLanes();
    this.notify();
  }

  // isolateLane hides every lane but this one (the eye menu's Alt-click). It
  // only ever narrows; "Show all contexts" — showAllLanes — is the way back.
  isolateLane(id: number): void {
    const lanes = this.current?.lanes ?? [];
    this.hiddenLanes = new Set(lanes.filter((l) => l.id !== id).map((l) => l.id));
    this.persistHiddenLanes();
    this.notify();
  }

  showAllLanes(): void {
    this.hiddenLanes = new Set();
    this.persistHiddenLanes();
    this.notify();
  }

  private persistHiddenLanes(): void {
    const key = this.hiddenKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.hiddenLanes]));
  }

  // rendersCollapsed is the fold state the views actually draw, as opposed to
  // isCollapsed's saved preference. An active filter forces every retained
  // parent open: each surviving child is a direct match, and folding one away
  // would drop it from the result the user asked for. Every renderer and the
  // snap-target collector ask this one, so none can answer it differently.
  rendersCollapsed(id: number): boolean {
    return this.filter === null && this.isCollapsed(id);
  }

  isCollapsed(id: number): boolean {
    return this.collapsed.has(id);
  }

  // Every item that has children, in roadmap order. The one definition of
  // "parent" the fold code works from: what can fold, what `collapsed` may
  // legally hold, and what a bulk fold acts on are all this list.
  private parentItems(): ItemFull[] {
    return (this.current?.lanes ?? []).flatMap((lane) =>
      lane.items.filter((item) => item.children.length > 0),
    );
  }

  // Whether the toolbar's next bulk fold action is Expand. False also covers
  // a roadmap with no parents; the caller disables the control in that case.
  allParentsCollapsed(): boolean {
    const parents = this.parentItems();
    return parents.length > 0 && parents.every((item) => this.collapsed.has(item.id));
  }

  hasParentItems(): boolean {
    return this.parentItems().length > 0;
  }

  private collapsedKey(): string | null {
    return this.current ? `roadie.collapsed.${this.current.id}` : null;
  }

  // Loads the collapsed-parent set for the current roadmap. Call after
  // `current` is set. Prunes ids that are no longer parents, so an item that
  // lost its children comes back expanded rather than staying folded forever.
  loadCollapsed(): void {
    this.collapsed = new Set();
    const key = this.collapsedKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parents = new Set(this.parentItems().map((item) => item.id));
      for (const id of JSON.parse(raw) as number[]) {
        if (parents.has(id)) this.collapsed.add(id);
      }
    } catch {
      // Corrupt entry — ignore and treat every parent as expanded.
    }
  }

  // setCollapsed folds or unfolds one parent. The full notification reconciles
  // any selected child the fold removes from both chart projections.
  setCollapsed(id: number, collapsed: boolean): void {
    if (collapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
    const key = this.collapsedKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.collapsed]));
    this.notify();
  }

  // Fold or unfold every parent in one saved state change and full render.
  setAllParentsCollapsed(collapsed: boolean): void {
    const parents = this.parentItems();
    this.collapsed = collapsed ? new Set(parents.map((item) => item.id)) : new Set();
    const key = this.collapsedKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.collapsed]));
    this.notify();
  }

  // The chart view "on deck": viewMode itself while a chart is on screen,
  // otherwise the one Recon was entered from.
  get chartMode(): ChartMode {
    return this.viewMode === "recon" ? this.lastChartMode : this.viewMode;
  }

  // Whether Recon can be shown at all: the server has a tracker configured and
  // a roadmap is open. The topbar button expresses the two separately (hidden,
  // then disabled); the "r" shortcut has no such affordance, so it asks here.
  get canShowRecon(): boolean {
    return this.me.trackerAvailable && this.current !== null;
  }

  // setViewMode switches what the main area shows. Any current selection is
  // scrolled into view after the switch, so toggling between chart views reads
  // as re-projecting the same spot of the model, not as jumping to an
  // unrelated page. A selected milestone is always renderable in the WBS:
  // selecting one unfolds its group (see selectMilestone).
  setViewMode(mode: ViewMode): void {
    // Picking a view while the diff is on screen means "show me that view":
    // the comparison closes rather than silently overriding the choice
    // (render() draws the diff whenever `compare` is set, whatever viewMode
    // says). Same-mode calls exit too — pressing the active view's button is
    // that same request.
    const comparing = this.preview?.compare !== undefined;
    if (comparing) delete this.preview!.compare;
    if (mode === this.viewMode) {
      if (comparing) this.notify();
      return;
    }
    const from = this.viewMode;
    this.viewMode = mode;
    if (mode === "recon") {
      // Captured on the way in rather than assumed to have been recorded
      // earlier: boot restores a persisted view by assigning viewMode directly.
      // `from` cannot be "recon" — mode is, and the two differ.
      this.lastChartMode = from as ChartMode;
    } else {
      this.lastChartMode = mode;
    }
    localStorage.setItem("roadie.view", mode);
    if (this.selectedItemIds.size > 0 || this.selectedMilestoneId !== null) {
      this.scrollToSelection = true;
    }
    this.notify();
  }

  // toggleChartView backs the "v" shortcut and the topbar view button: it
  // alternates between the two chart views, and from Recon returns to the one
  // last shown — Recon is never a stop in the cycle; only its own button
  // enters it.
  toggleChartView(): void {
    this.setViewMode(
      this.viewMode === "recon" ? this.chartMode : this.viewMode === "wbs" ? "timeline" : "wbs",
    );
  }

  // toggleReconView backs the "r" shortcut: into Recon from a chart view, back
  // out to the chart view it was entered from. Leaving works even where Recon
  // could not be entered, so the shortcut can never strand the user there.
  toggleReconView(): void {
    if (this.viewMode === "recon") this.setViewMode(this.chartMode);
    else if (this.canShowRecon) this.setViewMode("recon");
  }

  isMilestonesCollapsed(laneId: number): boolean {
    return this.wbsMsCollapsed.has(laneId);
  }

  private wbsMsKey(): string | null {
    return this.current ? `roadie.wbsMs.${this.current.id}` : null;
  }

  // Loads the folded-milestone-group set for the current roadmap. Call after
  // `current` is set. Prunes lanes that no longer exist or lost their last
  // milestone, so an emptied group comes back expanded rather than staying
  // folded forever (the same rule loadCollapsed applies to parents).
  loadWbsMsCollapsed(): void {
    this.wbsMsCollapsed = new Set();
    const key = this.wbsMsKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      for (const id of JSON.parse(raw) as number[]) {
        if (this.current?.lanes.some((l) => l.id === id && l.milestones.length > 0)) {
          this.wbsMsCollapsed.add(id);
        }
      }
    } catch {
      // Corrupt entry — ignore and treat every group as expanded.
    }
  }

  private saveWbsMsCollapsed(): void {
    const key = this.wbsMsKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.wbsMsCollapsed]));
  }

  // setMilestonesCollapsed folds or unfolds one lane's WBS milestone group.
  // This deselection must stay local: the fold hides milestones only in WBS;
  // timeline still renders their diamonds, so the view-independent full-render
  // reconciliation can only enforce their lane visibility.
  setMilestonesCollapsed(laneId: number, collapsed: boolean): void {
    if (collapsed) this.wbsMsCollapsed.add(laneId);
    else this.wbsMsCollapsed.delete(laneId);
    this.saveWbsMsCollapsed();
    if (collapsed && this.selectedMilestoneId !== null) {
      const loc = this.findMilestone(this.selectedMilestoneId);
      if (loc?.lane.id === laneId) this.selectedMilestoneId = null;
    }
    this.notify();
  }

  findItem(id: number): ItemLocation | null {
    if (!this.current) return null;
    for (const lane of this.current.lanes) {
      for (const item of lane.items) {
        if (item.id === id) return { item, lane, parent: null };
        for (const child of item.children) {
          if (child.id === id) return { item: child, lane, parent: item };
        }
      }
    }
    return null;
  }

  // allLabels returns the distinct labels in use across the current roadmap,
  // sorted — the source for the filter dropdown and the editor's autocomplete.
  allLabels(): string[] {
    const set = new Set<string>();
    for (const lane of this.current?.lanes ?? []) {
      for (const item of lane.items) {
        for (const l of item.labels) set.add(l);
        for (const child of item.children) for (const l of child.labels) set.add(l);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // countItems counts the items in the current roadmap satisfying pred,
  // children included.
  private countItems(pred: (item: Item) => boolean): number {
    let n = 0;
    for (const lane of this.current?.lanes ?? []) {
      for (const item of lane.items) {
        if (pred(item)) n++;
        for (const child of item.children) if (pred(child)) n++;
      }
    }
    return n;
  }

  // These drive the filter menu's signal rows, each both the filter and the
  // only place its total is visible — a mark nobody can see never gets dealt
  // with.
  flaggedCount(): number {
    return this.countItems((i) => i.flagged);
  }

  atRiskCount(): number {
    return this.countItems((i) => i.atRisk);
  }

  // Both item ends of every conflicting edge, which is the rule itself: the
  // contradiction belongs to the pair (deps-graph.ts). A milestone end is
  // skipped rather than missing — milestones are never filtered.
  private dependencyConflictItemIds(): Set<number> {
    const { conflictingEdges } = this.dependencyAnalysis();
    const ids = new Set<number>();
    for (const d of this.current?.dependencies ?? []) {
      if (!conflictingEdges.has(d.id)) continue;
      if (d.from.kind === "item") ids.add(d.from.id);
      if (d.to.kind === "item") ids.add(d.to.id);
    }
    return ids;
  }

  dependencyConflictCount(): number {
    return this.dependencyConflictItemIds().size;
  }

  toggleFilterSignal(kind: SignalFilterKind): void {
    this.filter = this.filter?.kind === kind ? null : { kind };
  }

  // `f` is a quick toggle within one roadmap, not a saved preference: it does
  // not survive switching roadmaps (resetFilter) or a reload. Before restoring
  // it, resolve it against the live roadmap: a label deleted or a signal
  // resolved while it was off silently discards a now-useless memory instead
  // of opening an empty view.
  toggleRecentFilter(): void {
    if (!this.current || this.viewMode === "recon") return;
    if (this.filter !== null) {
      this.filter = null;
      this.notify();
      return;
    }
    const recent = this.recentFilter;
    if (!recent) return;
    const match = itemPredicate(recent, this.dependencyConflictItemIds());
    if (match === null || this.countItems(match) === 0) {
      this.recentFilter = null;
      return;
    }
    this.filter = recent;
    this.notify();
  }

  // Whether an item matches the filter directly, which is stricter than being
  // on screen: a non-matching parent is retained as a breadcrumb. Find and
  // revealAndSelect want the strict answer.
  matchesFilter(item: Item): boolean {
    return this.projection().matches(item);
  }

  isFilterLabel(label: string): boolean {
    return this.filter?.kind === "labels" && this.filter.labels.includes(label);
  }

  // toggleFilterLabel adds or removes one label from the filter. Picking a label
  // while a signal is picked replaces it — labels and signals are exclusive
  // (see `filter`). Removing the last label clears the filter entirely.
  toggleFilterLabel(label: string): void {
    const current = this.filter?.kind === "labels" ? this.filter.labels : [];
    const next = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];
    this.filter = next.length > 0 ? { kind: "labels", labels: next } : null;
  }

  // isolateFilterLabel drops the rest of the selection for this one label (the
  // filter menu's Alt-click). Like isolateLane it only narrows; "Show all items"
  // is the way back.
  isolateFilterLabel(label: string): void {
    this.filter = { kind: "labels", labels: [label] };
  }

  findMilestone(id: number): MilestoneLocation | null {
    if (!this.current) return null;
    for (const lane of this.current.lanes) {
      for (const milestone of lane.milestones) {
        if (milestone.id === id) return { milestone, lane };
      }
    }
    return null;
  }

  // Selection is exclusive: selecting an item clears any milestone selection
  // and vice versa; the panel shows whichever is set. Selecting an item
  // collapses any multi-selection down to just that item.
  selectItem(id: number | null): void {
    this.selectedItemIds = id === null ? new Set() : new Set([id]);
    this.selectedMilestoneId = null;
  }

  // toggleItem adds or removes one item from the selection (shift-click),
  // building or shrinking a multi-selection. Clears any milestone selection.
  //
  // A parent and its child are never both selected: a parent already carries
  // its children (they travel with it on a group drag, and a delete cascades),
  // so co-selecting a child adds nothing. Selecting a parent therefore drops
  // any of its selected children, and shift-clicking a child whose parent is
  // already selected is a no-op.
  toggleItem(id: number): void {
    this.selectedMilestoneId = null;
    if (this.selectedItemIds.has(id)) {
      this.selectedItemIds.delete(id);
      return;
    }
    const loc = this.findItem(id);
    if (loc?.parent && this.selectedItemIds.has(loc.parent.id)) return; // covered by parent
    this.selectedItemIds.add(id);
    if (loc && loc.parent === null) {
      for (const c of (loc.item as ItemFull).children) this.selectedItemIds.delete(c.id);
    }
  }

  // deselectItem drops one item from the selection, if present (e.g. after it
  // is deleted). Leaves the rest of a multi-selection intact.
  deselectItem(id: number): void {
    this.selectedItemIds.delete(id);
  }

  // Selecting a milestone also unfolds its lane's WBS milestone group: the
  // selection may come from find or a deep link, and the panel must never
  // edit a row that isn't on screen. When the group is already open (a click
  // on a visible row) this is a no-op — exactly the case where callers may
  // follow with notifySelection() alone; every path that actually unfolds
  // (find, boot, the view toggle) ends in a full notify.
  selectMilestone(id: number | null): void {
    this.selectedMilestoneId = id;
    this.selectedItemIds = new Set();
    if (id !== null) {
      const loc = this.findMilestone(id);
      if (loc && this.wbsMsCollapsed.delete(loc.lane.id)) this.saveWbsMsCollapsed();
    }
  }

  // singleSelection is the one selected entity, or null when nothing or several
  // are selected. The URL names a single target, and a multi-selection has no
  // honest one — so it carries none rather than an arbitrary member. Item and
  // milestone selection are mutually exclusive (see selectItem/selectMilestone).
  singleSelection(): { kind: "item" | "milestone"; id: number } | null {
    if (this.selectedMilestoneId !== null) {
      return { kind: "milestone", id: this.selectedMilestoneId };
    }
    if (this.selectedItemIds.size !== 1) return null;
    const [id] = this.selectedItemIds;
    return { kind: "item", id: id! };
  }

  clearSelection(): boolean {
    if (this.selectedItemIds.size === 0 && this.selectedMilestoneId === null) return false;
    this.selectedItemIds = new Set();
    this.selectedMilestoneId = null;
    return true;
  }

  // revealAndSelect makes an item or milestone visible and selects it, marked
  // to be scrolled into view — the shared body behind every jump to an entity
  // from somewhere else (the find popup, a dependency row, a link opened at
  // boot). Resolving against live state first matters: the caller's reference
  // may be stale (an SSE refresh between building a list and clicking it), and
  // revealing before resolving would let a stale row unhide a lane on its way
  // to finding nothing. Reveal must then precede selection: selecting something
  // unrendered scrolls nowhere, so a hidden lane is unhidden and a folded
  // parent unfolded.
  // An active item filter is the third way a target can be off-screen, and it
  // is cleared for the same reason a lane is unhidden: every caller here means
  // "take me to this". A parent retained only as a matching child's breadcrumb
  // is still a non-match, so it clears the filter too — navigation lands on one
  // coherent chart rather than an exception. Callers that want to report the
  // clearing compare `filter` across the call (find.ts). Milestones are never
  // filtered, so only items can trigger it. Returns false if the target no
  // longer exists.
  //
  // Deliberately does not render: the scope is the caller's to choose, and boot
  // has one render of its own at the end. Anything jumping *during* a session
  // wants jumpTo below.
  revealAndSelect(kind: "item" | "milestone", id: number): boolean {
    const itemLoc = kind === "item" ? this.findItem(id) : null;
    const loc = kind === "item" ? itemLoc : this.findMilestone(id);
    if (!loc) return false;
    if (itemLoc && !this.matchesFilter(itemLoc.item)) this.filter = null;
    if (this.isLaneHidden(loc.lane.id)) this.setLaneHidden(loc.lane.id, false);
    if ("parent" in loc && loc.parent && this.isCollapsed(loc.parent.id)) {
      this.setCollapsed(loc.parent.id, false);
    }
    if (kind === "item") this.selectItem(id);
    else this.selectMilestone(id);
    this.scrollToSelection = true;
    return true;
  }

  // jumpTo is revealAndSelect plus a full notify — revealing changes geometry,
  // and only a full render honours the scroll request. This is what every
  // in-session "take me to this" calls.
  jumpTo(kind: "item" | "milestone", id: number): boolean {
    if (!this.revealAndSelect(kind, id)) return false;
    this.notify();
    return true;
  }

  snapshot(): RoadmapFull | null {
    return this.current ? (structuredClone(this.current) as RoadmapFull) : null;
  }

  restore(snap: RoadmapFull | null): void {
    this.current = snap;
    this.notify();
  }
}

export const state = new AppState();
