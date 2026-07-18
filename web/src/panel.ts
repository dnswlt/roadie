// The edit side-panel for the selected item. Values are committed on
// change (blur / Enter / date pick); structural actions (add child,
// delete) go through actions.ts.

import { actions } from "./actions";
import { confirmDialog } from "./dialogs";
import { state } from "./state";
import type { ItemFull } from "./types";

let renderedItemId: number | null = null;

export function renderPanel(panel: HTMLElement): void {
  const id = state.selectedItemId;
  const loc = id !== null ? state.findItem(id) : null;

  if (!loc) {
    panel.classList.remove("open");
    panel.replaceChildren();
    renderedItemId = null;
    return;
  }

  // Don't rebuild under the user's cursor while they are typing.
  if (renderedItemId === loc.item.id && panel.contains(document.activeElement)) {
    return;
  }
  renderedItemId = loc.item.id;
  panel.classList.add("open");
  panel.replaceChildren();

  const { item, lane, parent } = loc;

  const head = document.createElement("div");
  head.className = "panel-head";
  const kind = document.createElement("span");
  kind.className = "panel-kind";
  kind.textContent = parent ? "Child item" : "Item";
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "Close";
  close.textContent = "×";
  close.addEventListener("click", () => {
    state.selectedItemId = null;
    state.notify();
  });
  head.append(kind, close);

  const crumb = document.createElement("div");
  crumb.className = "panel-crumb";
  crumb.textContent = parent ? `${lane.name} › ${parent.title}` : lane.name;

  const title = field("Title", "input");
  (title.control as HTMLInputElement).value = item.title;
  title.control.addEventListener("change", () => {
    const v = (title.control as HTMLInputElement).value.trim();
    if (v && v !== item.title) void actions.updateItem(item.id, { title: v });
  });

  const desc = field("Description", "textarea");
  (desc.control as HTMLTextAreaElement).value = item.description;
  desc.control.addEventListener("change", () => {
    const v = (desc.control as HTMLTextAreaElement).value;
    if (v !== item.description) void actions.updateItem(item.id, { description: v });
  });

  const dates = document.createElement("div");
  dates.className = "panel-row";
  const start = field("Start", "input");
  (start.control as HTMLInputElement).type = "date";
  (start.control as HTMLInputElement).value = item.startDate;
  const end = field("End", "input");
  (end.control as HTMLInputElement).type = "date";
  (end.control as HTMLInputElement).value = item.endDate;
  start.control.addEventListener("change", () => {
    const v = (start.control as HTMLInputElement).value;
    if (v && v !== item.startDate) void actions.updateItem(item.id, { startDate: v });
  });
  end.control.addEventListener("change", () => {
    const v = (end.control as HTMLInputElement).value;
    if (v && v !== item.endDate) void actions.updateItem(item.id, { endDate: v });
  });
  dates.append(start.wrap, end.wrap);

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-actions";
  if (!parent) {
    const addChild = document.createElement("button");
    addChild.className = "btn";
    addChild.textContent = "+ Add child";
    addChild.addEventListener("click", () => void actions.addItem(item.laneId, item.id));
    actionsRow.append(addChild);
  }
  const del = document.createElement("button");
  del.className = "btn btn-danger";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    const children = (item as ItemFull).children;
    const suffix = children && children.length > 0 ? ` and its ${children.length} child item(s)` : "";
    if (await confirmDialog(`Delete "${item.title}"${suffix}?`)) {
      void actions.deleteItem(item.id);
    }
  });
  actionsRow.append(del);

  panel.append(head, crumb, title.wrap, desc.wrap, dates, actionsRow);
}

function field(
  label: string,
  tag: "input" | "textarea",
): { wrap: HTMLElement; control: HTMLInputElement | HTMLTextAreaElement } {
  const wrap = document.createElement("label");
  wrap.className = "panel-field";
  const span = document.createElement("span");
  span.textContent = label;
  const control = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
  wrap.append(span, control);
  return { wrap, control };
}
