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

// What the focus menu is spotlighting: one label, or the flag. A tagged union
// rather than a bare string, so "flagged" can never collide with a user's own
// label of that name.
export type Focus = { kind: "label"; label: string } | { kind: "flagged" };

// Which projection of the roadmap is on screen: the timeline chart
// (render.ts) or the WBS outline (wbs.ts). Both render from the same state;
// only app.ts branches on this.
export type ViewMode = "timeline" | "wbs";

// AppState is the single source of truth on the client. All views render
// from it; mutations go through actions.ts, which keeps it in sync with
// the server.
class AppState {
  roadmaps: Roadmap[] = [];
  current: RoadmapFull | null = null;
  // Who we are, from /api/me, fetched once at boot — it cannot change without a
  // page load. Only one thing reads it: whether to offer "private" when
  // creating a roadmap, since a private roadmap needs an owner and an anonymous
  // caller cannot be one. Everything else about visibility is decided by the
  // server and arrives as `visibility`/`owned` on the roadmap itself, so the UI
  // never branches on the deployment's auth mode.
  me: Me = { mode: "open", authenticated: false };
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
  // Timeline or WBS outline. A global view preference like snapMode — a way
  // of working, not a property of any one roadmap — persisted in localStorage
  // (read at boot in app.ts), toggled by "v" and the topbar button.
  viewMode: ViewMode = "timeline";
  panelWidth = DEFAULT_PANEL_WIDTH;
  // The edit rail is a fixture, not a popup: it keeps its width whatever is
  // selected, so the chart never resizes under the pointer mid-task. Collapsing
  // is the only thing that narrows it, and selecting never brings it back — only
  // an explicit edit does (see focusPanelTitle). Persisted in localStorage like
  // panelWidth (read at boot in app.ts).
  panelCollapsed = false;
  // Focus mode: when set, items that don't match are dimmed. A transient
  // "what's relevant right now" view, not persisted. The target is either one
  // label or the flag — kept as one exclusive field rather than two, since
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
    const key = this.hiddenKey();
    if (key) localStorage.setItem(key, JSON.stringify([...this.hiddenLanes]));
    this.notify();
  }

  isCollapsed(id: number): boolean {
    return this.collapsed.has(id);
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
      const parents = new Set<number>();
      for (const lane of this.current?.lanes ?? []) {
        for (const item of lane.items) if (item.children.length > 0) parents.add(item.id);
      }
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

  // setViewMode switches between the timeline chart and the WBS outline. Any
  // current selection is scrolled into view after the switch, so toggling
  // reads as re-projecting the same spot of the model, not as jumping to an
  // unrelated page. A selected milestone is always renderable in the WBS:
  // selecting one unfolds its group (see selectMilestone).
  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    localStorage.setItem("roadie.view", mode);
    if (this.selectedItemIds.size > 0 || this.selectedMilestoneId !== null) {
      this.scrollToSelection = true;
    }
    this.notify();
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

  // flaggedCount returns how many items in the current roadmap carry the flag.
  // Drives the focus menu's "Flagged (n)" row, which is both the filter and the
  // only place the total is visible — flags nobody can see never get cleared.
  flaggedCount(): number {
    let n = 0;
    for (const lane of this.current?.lanes ?? []) {
      for (const item of lane.items) {
        if (item.flagged) n++;
        for (const child of item.children) if (child.flagged) n++;
      }
    }
    return n;
  }

  // isDimmed reports whether an item should be grayed out under the current
  // focus (false when no focus is active).
  isDimmed(item: { labels: string[]; flagged: boolean }): boolean {
    if (this.focus === null) return false;
    return this.focus.kind === "flagged" ? !item.flagged : !item.labels.includes(this.focus.label);
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

  snapshot(): RoadmapFull | null {
    return this.current ? (structuredClone(this.current) as RoadmapFull) : null;
  }

  restore(snap: RoadmapFull | null): void {
    this.current = snap;
    this.notify();
  }
}

export const state = new AppState();
