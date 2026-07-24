import { DEFAULT_PX_PER_DAY, type SnapMode } from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone, Roadmap, RoadmapFull } from "./types";

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

// AppState is the single source of truth on the client. All views render
// from it; mutations go through actions.ts, which keeps it in sync with
// the server.
class AppState {
  roadmaps: Roadmap[] = [];
  current: RoadmapFull | null = null;
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
  panelWidth = DEFAULT_PANEL_WIDTH;
  // Focus mode: when set, items lacking this label are dimmed. A transient
  // "what's relevant right now" view, not persisted.
  focusLabel: string | null = null;
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

  private listeners: Array<() => void> = [];

  subscribe(fn: () => void): void {
    this.listeners.push(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
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

  // isDimmed reports whether an item should be grayed out under the current
  // focus label (false when no focus is active).
  isDimmed(labels: string[]): boolean {
    return this.focusLabel !== null && !labels.includes(this.focusLabel);
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

  selectMilestone(id: number | null): void {
    this.selectedMilestoneId = id;
    this.selectedItemIds = new Set();
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
