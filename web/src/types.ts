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
}

export interface ItemFull extends Item {
  children: Item[];
}

export interface LaneFull extends Lane {
  items: ItemFull[];
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
}

export interface NewItem {
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  parentId?: number | null;
}
