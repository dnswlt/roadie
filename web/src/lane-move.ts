// Builds the replacement popover used to choose a context's saved position.
// A context row means "place above this context"; the bottom action represents
// the only slot that cannot be named by another context. Hidden contexts remain
// destinations because visibility is a view preference, not part of the order.

import { laneColorValue } from "./colors";
import { icons } from "./icons";
import { state } from "./state";

function currentMarker(): HTMLElement {
  const current = document.createElement("span");
  current.className = "lane-move-current";
  current.textContent = "Current";
  return current;
}

function separator(): HTMLElement {
  const separator = document.createElement("div");
  separator.className = "menu-sep";
  return separator;
}

function orderBefore(laneId: number, beforeId: number | null): number[] | null {
  if (!state.current) return null;
  const current = state.current.lanes.map((lane) => lane.id);
  if (!current.includes(laneId)) return null;
  const next = current.filter((id) => id !== laneId);
  if (beforeId === null) {
    next.push(laneId);
  } else {
    const index = next.indexOf(beforeId);
    if (index < 0) return null;
    next.splice(index, 0, laneId);
  }
  return next.some((id, index) => id !== current[index]) ? next : null;
}

export function buildLaneMoveMenu(
  laneId: number,
  move: (laneIds: number[]) => void,
): HTMLElement | null {
  const lanes = state.current?.lanes ?? [];
  const lane = lanes.find((candidate) => candidate.id === laneId);
  if (!lane || lanes.length < 2) return null;

  const menu = document.createElement("div");
  menu.className = "menu lane-menu lane-move-menu";
  menu.dataset.laneId = String(laneId);

  const head = document.createElement("div");
  head.className = "menu-head";
  const title = document.createElement("strong");
  title.textContent = `Move “${lane.name}” above…`;
  title.title = title.textContent;
  head.append(title);
  menu.append(head);

  const currentIndex = lanes.findIndex((candidate) => candidate.id === laneId);
  const currentBeforeId = lanes[currentIndex + 1]?.id ?? null;
  const select = (beforeId: number | null): void => {
    const laneIds = orderBefore(laneId, beforeId);
    if (laneIds) move(laneIds);
  };

  for (const target of lanes) {
    if (target.id === laneId) continue;
    const hidden = state.isLaneHidden(target.id);
    const row = document.createElement("button");
    row.className = hidden
      ? "menu-item lane-move-item is-hidden"
      : "menu-item lane-move-item";
    row.disabled = target.id === currentBeforeId;

    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = laneColorValue(target.color);
    const name = document.createElement("span");
    name.className = "lane-move-name";
    name.textContent = target.name;
    row.append(dot, name);

    if (hidden || row.disabled) {
      const status = document.createElement("span");
      status.className = "lane-move-status";
      if (hidden) {
        status.title = "Hidden context";
        status.append(icons.eyeOff(14));
      }
      if (row.disabled) status.append(currentMarker());
      row.append(status);
    }
    row.addEventListener("click", () => select(target.id));
    menu.append(row);
  }

  menu.append(separator());
  const bottom = document.createElement("button");
  bottom.className = "menu-item";
  bottom.disabled = currentBeforeId === null;
  bottom.append(icons.moveBottom(16), "Move to bottom");
  if (bottom.disabled) bottom.append(currentMarker());
  bottom.addEventListener("click", () => select(null));
  menu.append(bottom);
  return menu;
}
