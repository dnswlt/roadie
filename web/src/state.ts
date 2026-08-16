import { DEFAULT_PX_PER_DAY, type SnapMode } from "./timescale";
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

// What the focus menu is spotlighting: a set of labels, or the flag. A tagged
// union rather than a bare list of strings, so "flagged" can never collide with
// a user's own label of that name. `labels` is non-empty and duplicate-free —
// an empty selection is `focus === null`, not a labels focus of nothing, so
// "is anything focused" stays a single null check everywhere.
export type Focus =
  | { kind: "labels"; labels: string[] }
  | { kind: "flagged" }
  | { kind: "atRisk" };

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
  current: RoadmapFull | null = null;
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
  // Focus mode: when set, items that don't match are dimmed. A transient
  // "what's relevant right now" view, not persisted. Several labels can be
  // focused at once (matching is OR — an item needs any one of them), but
  // labels and the flag stay exclusive: they are one field, not two, since
  // focusing on both at once has no meaning.
  focus: Focus | null = null;
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
  history: Snapshot[] | null = null;
  preview: { snapshotId: number; createdAt: string } | null = null;
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

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  // The narrower of the two invalidation scopes: selection-only changes,
  // projected onto the existing chart DOM instead of rebuilding it (see
  // render.ts projectSelection; rationale in CLAUDE.md). notify() is the
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

  // setCollapsed folds or unfolds one parent. Collapsing hides the selected
  // item when it is one of the folded children, so the panel never edits
  // something that isn't on screen.
  setCollapsed(id: number, collapsed: boolean): void {
    if (collapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
    const key = this.collapsedKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.collapsed]));
    if (collapsed) {
      // Drop any selected item that is a child of the just-folded parent, so
      // the panel never edits something that isn't on screen.
      for (const selId of [...this.selectedItemIds]) {
        if (this.findItem(selId)?.parent?.id === id) this.selectedItemIds.delete(selId);
      }
    }
    this.notify();
  }

  // Fold or unfold every parent in one state change. Collapsing also drops
  // selected children, exactly as setCollapsed does for one parent, but saves
  // and renders once rather than once per parent.
  setAllParentsCollapsed(collapsed: boolean): void {
    const parents = this.parentItems();
    this.collapsed = collapsed ? new Set(parents.map((item) => item.id)) : new Set();
    const key = this.collapsedKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.collapsed]));
    if (collapsed) {
      const childIDs = new Set(parents.flatMap((item) => item.children.map((child) => child.id)));
      for (const id of [...this.selectedItemIds]) {
        if (childIDs.has(id)) this.selectedItemIds.delete(id);
      }
    }
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
  // selecting one unfolds its group (see selectMilestone). Recon is not
  // persisted (see viewMode), so localStorage only ever holds a chart mode.
  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    const from = this.viewMode;
    this.viewMode = mode;
    if (mode === "recon") {
      // Captured on the way in rather than assumed to have been recorded
      // earlier: boot restores a persisted WBS by assigning viewMode directly.
      // `from` cannot be "recon" — mode is, and the two differ.
      this.lastChartMode = from as ChartMode;
    } else {
      this.lastChartMode = mode;
      localStorage.setItem("roadie.view", mode);
    }
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
  // Folding deselects a selected milestone of that lane — the setCollapsed
  // rule: the panel never edits something that isn't on screen.
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
  // sorted — the source for the focus dropdown and the editor's autocomplete.
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

  // These drive the focus menu's "Flagged (n)" and "At risk (n)" rows, each
  // both the filter and the only place its total is visible — a mark nobody
  // can see never gets dealt with.
  flaggedCount(): number {
    return this.countItems((i) => i.flagged);
  }

  atRiskCount(): number {
    return this.countItems((i) => i.atRisk);
  }

  // isDimmed reports whether an item should be grayed out under the current
  // focus (false when no focus is active). Several focused labels match as OR:
  // the menu is a "show me these" pick list, and AND would make each extra pick
  // shrink the result, which is the opposite of what adding one reads as.
  isDimmed(item: { labels: string[]; flagged: boolean; atRisk: boolean }): boolean {
    if (this.focus === null) return false;
    if (this.focus.kind === "flagged") return !item.flagged;
    if (this.focus.kind === "atRisk") return !item.atRisk;
    return !this.focus.labels.some((l) => item.labels.includes(l));
  }

  isFocusedLabel(label: string): boolean {
    return this.focus?.kind === "labels" && this.focus.labels.includes(label);
  }

  // toggleFocusLabel adds or removes one label from the focus. Picking a label
  // while the flag is focused replaces it — labels and the flag are exclusive
  // (see `focus`). Removing the last label clears the focus entirely.
  toggleFocusLabel(label: string): void {
    const current = this.focus?.kind === "labels" ? this.focus.labels : [];
    const next = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];
    this.focus = next.length > 0 ? { kind: "labels", labels: next } : null;
  }

  // isolateFocusLabel drops the rest of the selection for this one label (the
  // focus menu's Alt-click). Like isolateLane it only narrows; "Show all items"
  // is the way back.
  isolateFocusLabel(label: string): void {
    this.focus = { kind: "labels", labels: [label] };
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

  clearSelection(): boolean {
    if (this.selectedItemIds.size === 0 && this.selectedMilestoneId === null) return false;
    this.selectedItemIds = new Set();
    this.selectedMilestoneId = null;
    return true;
  }

  // revealAndSelect makes an item or milestone visible and selects it,
  // scrolled into view — the one way to jump to an entity from somewhere else
  // (the find popup, a dependency row). Resolving against live state first
  // matters: the caller's reference may be stale (an SSE refresh between
  // building a list and clicking it), and revealing before resolving would let
  // a stale row unhide a lane on its way to finding nothing. Reveal must then
  // precede selection: selecting something unrendered scrolls nowhere, so a
  // hidden lane is unhidden and a folded parent unfolded. Ends in a full
  // notify — revealing changes geometry, and only a full render honours the
  // scroll request. Returns false if the target no longer exists.
  revealAndSelect(kind: "item" | "milestone", id: number): boolean {
    const loc = kind === "item" ? this.findItem(id) : this.findMilestone(id);
    if (!loc) return false;
    if (this.isLaneHidden(loc.lane.id)) this.setLaneHidden(loc.lane.id, false);
    if ("parent" in loc && loc.parent && this.isCollapsed(loc.parent.id)) {
      this.setCollapsed(loc.parent.id, false);
    }
    if (kind === "item") this.selectItem(id);
    else this.selectMilestone(id);
    this.scrollToSelection = true;
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
