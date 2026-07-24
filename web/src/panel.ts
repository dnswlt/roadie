// The edit side-panel for the selected item. Values are committed on
// change (blur / Enter / date pick); structural actions (add child,
// delete) go through actions.ts.

import { actions } from "./actions";
import { laneColorValue } from "./colors";
import { confirmDialog } from "./dialogs";
import { icons } from "./icons";
import { extractUrls, linkLabel } from "./links";
import { state, type MilestoneLocation } from "./state";
import { toast } from "./toast";
import type { ItemFull } from "./types";
import { selectionLink } from "./url";

// copyLinkButton builds a "copy shareable link" icon button for the panel head.
// The link is generated on demand from the current roadmap + this selection —
// the address bar itself never carries the selection (see url.ts).
function copyLinkButton(kind: "item" | "milestone", id: number): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.title = "Copy link";
  btn.append(icons.link(16));
  btn.addEventListener("click", async () => {
    const roadmapId = state.current?.id;
    if (roadmapId === undefined) return;
    try {
      await navigator.clipboard.writeText(selectionLink(roadmapId, kind, id));
      toast("Link copied");
    } catch {
      toast("Couldn't copy link", true);
    }
  });
  return btn;
}

// Identifies what the panel currently shows, e.g. "item:5" or "ms:3", so a
// re-render can skip rebuilding the panel under the user's cursor.
let renderedKey: string | null = null;

export function renderPanel(panel: HTMLElement): void {
  const msId = state.selectedMilestoneId;
  const msLoc = msId !== null ? state.findMilestone(msId) : null;
  if (msLoc) {
    renderMilestonePanel(panel, msLoc);
    return;
  }

  const id = state.selectedItemId;
  const loc = id !== null ? state.findItem(id) : null;

  if (!loc) {
    panel.classList.remove("open");
    panel.style.width = "";
    panel.replaceChildren();
    renderedKey = null;
    return;
  }

  // Don't rebuild under the user's cursor while they are typing.
  const key = `item:${loc.item.id}`;
  if (renderedKey === key && panel.contains(document.activeElement)) {
    return;
  }
  renderedKey = key;
  panel.classList.add("open");
  panel.style.width = `${state.panelWidth}px`;
  panel.replaceChildren();

  const { item, lane, parent } = loc;
  // Tie the panel's accent (priority chips) to the item's lane color.
  panel.style.setProperty("--c", laneColorValue(lane.color));

  const head = document.createElement("div");
  head.className = "panel-head";
  const kind = document.createElement("span");
  kind.className = "panel-kind";
  kind.textContent = parent ? "Child item" : "Item";
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "Close";
  close.append(icons.x());
  close.addEventListener("click", () => {
    state.clearSelection();
    state.notify();
  });
  const headActions = document.createElement("div");
  headActions.className = "panel-head-actions";
  headActions.append(copyLinkButton("item", item.id), close);
  head.append(kind, headActions);

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

  const linksSection = createLinksSection(desc.control as HTMLTextAreaElement);

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

  // Priority: four chips (P1 highest .. P4 lowest). Clicking the active chip
  // clears the priority back to unset. Chip classes are toggled directly
  // because the panel skips its own rebuild while a chip holds focus.
  const prio = document.createElement("div");
  prio.className = "panel-field";
  const prioLabel = document.createElement("span");
  prioLabel.textContent = "Priority";
  const chips = document.createElement("div");
  chips.className = "prio-chips";
  for (let p = 1; p <= 4; p++) {
    const chip = document.createElement("button");
    chip.className = `prio-chip p${p}`;
    chip.textContent = `P${p}`;
    if (item.priority === p) chip.classList.add("active");
    chip.addEventListener("click", () => {
      const next = item.priority === p ? null : p;
      for (const c of chips.children) c.classList.remove("active");
      if (next !== null) chip.classList.add("active");
      void actions.updateItem(item.id, { priority: next });
    });
    chips.append(chip);
  }
  prio.append(prioLabel, chips);

  const labels = labelsField(item);

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

  panel.append(head, crumb, title.wrap, desc.wrap, linksSection, dates, prio, labels, actionsRow);
}

// labelsField is a tag editor: removable chips for the item's labels plus an
// input to add more (Enter/comma commits; a datalist autocompletes existing
// labels). Like the priority chips, it mutates its own DOM on add/remove and
// commits through actions — the panel skips its own rebuild while focused.
function labelsField(item: { id: number; labels: string[] }): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel-field";
  const label = document.createElement("span");
  label.textContent = "Labels";

  const editor = document.createElement("div");
  editor.className = "label-editor";
  const chips = document.createElement("div");
  chips.className = "label-chips";
  const input = document.createElement("input");
  input.className = "label-input";
  input.placeholder = "Add label…";
  input.setAttribute("list", "label-suggestions");

  const datalist = document.createElement("datalist");
  datalist.id = "label-suggestions";
  for (const l of state.allLabels()) {
    const opt = document.createElement("option");
    opt.value = l;
    datalist.append(opt);
  }

  let labels = [...item.labels];
  const commit = () => void actions.updateItem(item.id, { labels: [...labels] });

  const renderChips = () => {
    chips.replaceChildren();
    for (const l of labels) {
      const chip = document.createElement("span");
      chip.className = "label-chip";
      const text = document.createElement("span");
      text.textContent = l;
      const x = document.createElement("button");
      x.className = "label-x";
      x.title = "Remove";
      x.append(icons.x(12));
      x.addEventListener("click", () => {
        labels = labels.filter((v) => v !== l);
        renderChips();
        commit();
      });
      chip.append(text, x);
      chips.append(chip);
    }
  };

  const add = () => {
    const v = input.value.trim();
    input.value = "";
    if (!v || labels.includes(v)) return;
    labels.push(v);
    renderChips();
    commit();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && input.value === "" && labels.length > 0) {
      labels.pop();
      renderChips();
      commit();
    }
  });
  input.addEventListener("blur", add); // commit a typed-but-unentered label

  renderChips();
  editor.append(chips, input, datalist);
  wrap.append(label, editor);
  return wrap;
}

function renderMilestonePanel(panel: HTMLElement, loc: MilestoneLocation): void {
  const { milestone, lane } = loc;
  const key = `ms:${milestone.id}`;
  // Don't rebuild under the user's cursor while they are typing.
  if (renderedKey === key && panel.contains(document.activeElement)) {
    return;
  }
  renderedKey = key;
  panel.classList.add("open");
  panel.style.width = `${state.panelWidth}px`;
  panel.replaceChildren();
  panel.style.setProperty("--c", laneColorValue(lane.color));

  const head = document.createElement("div");
  head.className = "panel-head";
  const kind = document.createElement("span");
  kind.className = "panel-kind";
  kind.textContent = "Milestone";
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "Close";
  close.append(icons.x());
  close.addEventListener("click", () => {
    state.clearSelection();
    state.notify();
  });
  const headActions = document.createElement("div");
  headActions.className = "panel-head-actions";
  headActions.append(copyLinkButton("milestone", milestone.id), close);
  head.append(kind, headActions);

  const crumb = document.createElement("div");
  crumb.className = "panel-crumb";
  crumb.textContent = lane.name;

  const title = field("Title", "input");
  (title.control as HTMLInputElement).value = milestone.title;
  title.control.addEventListener("change", () => {
    const v = (title.control as HTMLInputElement).value.trim();
    if (v && v !== milestone.title) void actions.updateMilestone(milestone.id, { title: v });
  });

  const dateField = field("Date", "input");
  (dateField.control as HTMLInputElement).type = "date";
  (dateField.control as HTMLInputElement).value = milestone.date;
  dateField.control.addEventListener("change", () => {
    const v = (dateField.control as HTMLInputElement).value;
    if (v && v !== milestone.date) void actions.updateMilestone(milestone.id, { date: v });
  });

  const desc = field("Description", "textarea");
  (desc.control as HTMLTextAreaElement).value = milestone.description;
  desc.control.addEventListener("change", () => {
    const v = (desc.control as HTMLTextAreaElement).value;
    if (v !== milestone.description) void actions.updateMilestone(milestone.id, { description: v });
  });

  const linksSection = createLinksSection(desc.control as HTMLTextAreaElement);

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-actions";
  const del = document.createElement("button");
  del.className = "btn btn-danger";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (await confirmDialog(`Delete milestone "${milestone.title}"?`)) {
      void actions.deleteMilestone(milestone.id);
    }
  });
  actionsRow.append(del);

  panel.append(head, crumb, title.wrap, dateField.wrap, desc.wrap, linksSection, actionsRow);
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

// createLinksSection shows the URLs found in a description as clickable chips.
// It reads the live textarea and re-renders on input, so links track edits
// before they are committed.
function createLinksSection(descControl: HTMLTextAreaElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "links-section";

  const render = () => {
    wrap.replaceChildren();
    const urls = extractUrls(descControl.value);
    wrap.style.display = urls.length === 0 ? "none" : "block";
    if (urls.length === 0) return;

    const label = document.createElement("span");
    label.className = "panel-field-label";
    label.textContent = "External links";

    const chips = document.createElement("div");
    chips.className = "links-chips";
    for (const url of urls) {
      const chip = document.createElement("a");
      chip.className = "link-chip";
      chip.href = url;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.textContent = linkLabel(url);
      chip.title = url;
      chips.append(chip);
    }
    wrap.append(label, chips);
  };

  render();
  descControl.addEventListener("input", render);
  return wrap;
}
