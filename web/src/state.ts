import { DEFAULT_PX_PER_DAY } from "./timescale";
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
  // At most one of these is set at a time (item vs. milestone editor).
  selectedItemId: number | null = null;
  selectedMilestoneId: number | null = null;
  pxPerDay = DEFAULT_PX_PER_DAY;
  panelWidth = DEFAULT_PANEL_WIDTH;
  // Focus mode: when set, items lacking this label are dimmed. A transient
  // "what's relevant right now" view, not persisted.
  focusLabel: string | null = null;
  // Set after loading a roadmap so the chart scrolls to today once.
  scrollToToday = false;
  // Lanes hidden from the chart. Purely a view preference (not part of the
  // data model), persisted per roadmap in localStorage.
  hiddenLanes = new Set<number>();

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
  // and vice versa; the panel shows whichever is set.
  selectItem(id: number | null): void {
    this.selectedItemId = id;
    this.selectedMilestoneId = null;
  }

  selectMilestone(id: number | null): void {
    this.selectedMilestoneId = id;
    this.selectedItemId = null;
  }

  clearSelection(): boolean {
    if (this.selectedItemId === null && this.selectedMilestoneId === null) return false;
    this.selectedItemId = null;
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
