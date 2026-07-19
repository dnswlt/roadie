// Mirrors the JSON payloads of the Go backend (internal/model).

export interface Roadmap {
  id: number;
  name: string;
}

export interface Lane {
  id: number;
  roadmapId: number;
  name: string;
  position: number;
  color: string;
}

export interface LanePatch {
  name?: string;
  color?: string;
}

export interface Item {
  id: number;
  laneId: number;
  parentId: number | null;
  title: string;
  description: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  rank: number; // position within the container (lane / parent), dense 0..n-1
  priority: number | null; // 1..4 (1 = highest); null = unprioritized
  labels: string[]; // free-form tags, shared across the roadmap
}

export interface ItemFull extends Item {
  children: Item[];
}

export interface Milestone {
  id: number;
  laneId: number;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
}

export interface LaneFull extends Lane {
  items: ItemFull[];
  milestones: Milestone[];
}

export interface RoadmapFull extends Roadmap {
  lanes: LaneFull[];
}

// Partial update for PATCH /api/items/{id}. parentId: null explicitly
// detaches an item from its parent.
export interface ItemPatch {
  title?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  laneId?: number;
  parentId?: number | null;
  rank?: number;
  priority?: number | null;
  labels?: string[];
}

export interface NewItem {
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  parentId?: number | null;
}

export interface NewMilestone {
  title: string;
  description: string;
  date: string;
}

export interface MilestonePatch {
  title?: string;
  description?: string;
  date?: string;
}
