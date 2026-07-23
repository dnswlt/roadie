import "./styles.css";
import { actions } from "./actions";
import { LANE_COLOR_ORDER, laneColorValue } from "./colors";
import { confirmDialog, promptDialog } from "./dialogs";
import { initDnd } from "./dnd";
import { icons } from "./icons";
import { LABEL_W } from "./layout";
import { currentScale, renderChart } from "./render";
import { renderPanel } from "./panel";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, state } from "./state";
import { contentRange, MAX_PX_PER_DAY, MIN_PX_PER_DAY, type SnapMode, xOf } from "./timescale";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

const chart = $("chart");
const panel = $("panel");
const panelResize = $("panel-resize");
const rmPicker = $("rm-picker") as HTMLButtonElement;

// Human labels for the drag-snap grids, in menu order.
const SNAP_LABELS: Record<SnapMode, string> = {
  day: "Day",
  week: "Week (Mon)",
  month: "Month (1st)",
  quarter: "Quarter",
};

function render(): void {
  renderTopbar();
  renderChart(chart);
  renderPanel(panel);
}

function renderTopbar(): void {
  // The picker is a button + popover (like every other menu here), so its
  // label is drawn by hand; the list itself is built lazily on open.
  const name = document.createElement("span");
  name.className = "rm-trigger-name";
  name.textContent = state.current?.name ?? "No roadmap";
  rmPicker.replaceChildren(name, icons.chevronDown(14));
  rmPicker.title = state.current?.name ?? "";
  rmPicker.disabled = state.roadmaps.length === 0;
  ($("rm-rename") as HTMLButtonElement).disabled = !state.current;
  ($("rm-duplicate") as HTMLButtonElement).disabled = !state.current;
  ($("rm-export") as HTMLButtonElement).disabled = !state.current;
  ($("rm-delete") as HTMLButtonElement).disabled = !state.current;
  // Surface active focus even while the dropdown is closed.
  $("focus-menu").classList.toggle("active", state.focusLabel !== null);
  $("focus-menu").title = state.focusLabel ? `Focus: ${state.focusLabel}` : "Focus on a label";
  // Highlight the snap button when a calendar grid (not plain Day) is engaged.
  $("snap-menu").classList.toggle("active", state.snapMode !== "day");
  $("snap-menu").title = `Snap to ${SNAP_LABELS[state.snapMode]} (hold Alt to bypass)`;
}

// setZoom keeps the date under the viewport center fixed while zooming.
function setZoom(pxPerDay: number): void {
  const px = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, pxPerDay));
  if (px === state.pxPerDay) return;
  const ratio = px / state.pxPerDay;
  const centerX = chart.scrollLeft + chart.clientWidth / 2 - LABEL_W;
  state.pxPerDay = px;
  localStorage.setItem("roadie.zoom", String(px));
  state.notify();
  chart.scrollLeft = Math.max(0, centerX * ratio - chart.clientWidth / 2 + LABEL_W);
}

// Breathing room left on either side of the framed span by zoomToFit, so the
// first and last bars don't sit flush against the viewport edges.
const FIT_GUTTER_PX = 32;

// zoomToFit frames the items and milestones of the *visible* lanes: it picks
// the largest pxPerDay at which their span fits the viewport, then scrolls to
// the span's start. It deliberately ignores today (unlike the chart's own
// range, which pads out to include it), so a roadmap that lives entirely in
// the future is framed on the work rather than on empty months. MIN_PX_PER_DAY
// still clamps, so a very long roadmap fits as much as it can and no more.
function zoomToFit(): void {
  const lanes = (state.current?.lanes ?? []).filter((l) => !state.isLaneHidden(l.id));
  const range = contentRange(lanes);
  if (!range) return;
  const days = range.endDay - range.startDay + 1; // end dates are inclusive
  const avail = chart.clientWidth - LABEL_W - FIT_GUTTER_PX;
  if (avail <= 0) return;
  const px = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, avail / days));
  state.pxPerDay = px;
  localStorage.setItem("roadie.zoom", String(px));
  // Not setZoom: fitting must re-scroll even when the zoom level is unchanged,
  // so that a second click still recentres after panning away.
  state.notify();
  // Scroll so the span's start lands just right of the lane labels. They are
  // sticky at left: 0 and so overlay the first LABEL_W pixels of the viewport;
  // scrolling to the span's own x would tuck its first bars underneath them.
  chart.scrollLeft = Math.max(0, xOf(currentScale(), range.startDay) - FIT_GUTTER_PX / 2);
}

// buildRoadmapMenu (re)populates the roadmap picker: one row per roadmap, the
// current one check-marked. Rebuilt on open so it always reflects the list.
function buildRoadmapMenu(pop: HTMLElement): void {
  pop.replaceChildren();
  if (state.roadmaps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No roadmaps yet.";
    pop.append(empty);
    return;
  }
  for (const rm of state.roadmaps) {
    const active = state.current?.id === rm.id;
    const b = document.createElement("button");
    b.className = active ? "menu-item is-active" : "menu-item";
    const mark = document.createElement("span");
    mark.className = "menu-check";
    if (active) mark.append(icons.check(14));
    const name = document.createElement("span");
    name.className = "rm-item-name";
    name.textContent = rm.name;
    name.title = rm.name;
    b.append(mark, name);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.add("hidden");
      if (!active) void actions.selectRoadmap(rm.id);
    });
    pop.append(b);
  }
}

// buildSnapMenu (re)populates the snap-grid popover: one row per mode, the
// active one check-marked. Picking a mode applies it and closes the menu.
function buildSnapMenu(pop: HTMLElement): void {
  pop.replaceChildren();
  const modes: SnapMode[] = ["day", "week", "month", "quarter"];
  for (const mode of modes) {
    const active = state.snapMode === mode;
    const b = document.createElement("button");
    b.className = active ? "menu-item is-active" : "menu-item";
    const mark = document.createElement("span");
    mark.className = "menu-check";
    if (active) mark.append(icons.check(14));
    const name = document.createElement("span");
    name.textContent = SNAP_LABELS[mode];
    b.append(mark, name);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setSnapMode(mode);
      pop.classList.add("hidden");
      renderTopbar();
    });
    pop.append(b);
  }
}

// setSnapMode records the drag-snap grid and persists it globally (like zoom).
// No chart re-render needed: nothing on screen changes until the next drag.
function setSnapMode(mode: SnapMode): void {
  state.snapMode = mode;
  localStorage.setItem("roadie.snap", mode);
}

// wirePanelResize lets the user drag the panel's left edge to set its width.
// The chart is flex:1, so widening the panel just reflows it — no re-render.
// The chosen width is clamped and persisted (globally, like zoom).
function wirePanelResize(): void {
  panelResize.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    panelResize.setPointerCapture(e.pointerId);
    panelResize.classList.add("dragging");
    panel.classList.add("resizing"); // suppress the width transition while dragging
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = (ev: PointerEvent) => {
      // Dragging left (toward the chart) widens the panel.
      const w = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startW + (startX - ev.clientX)));
      panel.style.width = `${w}px`;
    };
    const onUp = (ev: PointerEvent) => {
      panelResize.releasePointerCapture(ev.pointerId);
      panelResize.classList.remove("dragging");
      panel.classList.remove("resizing");
      panelResize.removeEventListener("pointermove", onMove);
      panelResize.removeEventListener("pointerup", onUp);
      state.panelWidth = panel.offsetWidth;
      localStorage.setItem("roadie.panelWidth", String(state.panelWidth));
    };
    panelResize.addEventListener("pointermove", onMove);
    panelResize.addEventListener("pointerup", onUp);
  });
}

function injectIcons(): void {
  $("rm-new").prepend(icons.plus(14));
  $("rm-menu").append(icons.dots(18));
  $("lane-vis-menu").append(icons.eye(18));
  $("focus-menu").append(icons.tag(18));
  $("rm-rename").prepend(icons.pencil(14));
  $("rm-duplicate").prepend(icons.copy(14));
  $("rm-export").prepend(icons.download(14));
  $("rm-import").prepend(icons.upload(14));
  $("rm-delete").prepend(icons.trash(14));
  $("snap-menu").append(icons.magnet(18));
  $("zoom-fit").append(icons.zoomFit());
  $("zoom-in").append(icons.zoomIn());
  $("zoom-out").append(icons.zoomOut());
}

function wireTopbar(): void {
  const rmPop = $("rm-pop");
  const menuPop = $("rm-menu-pop");
  const visPop = $("lane-vis-pop");
  const focusPop = $("focus-pop");
  const snapPop = $("snap-pop");
  const allPops = [rmPop, menuPop, visPop, focusPop, snapPop];
  // Close every top-bar popover except the one being opened.
  const closeOthers = (keep: HTMLElement): void => {
    for (const p of allPops) if (p !== keep) p.classList.add("hidden");
  };
  rmPicker.addEventListener("click", (e) => {
    e.stopPropagation();
    closeOthers(rmPop);
    if (rmPop.classList.contains("hidden")) buildRoadmapMenu(rmPop);
    rmPop.classList.toggle("hidden");
  });
  $("rm-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    closeOthers(menuPop);
    menuPop.classList.toggle("hidden");
  });
  $("lane-vis-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    closeOthers(visPop);
    if (visPop.classList.contains("hidden")) buildLaneVisMenu(visPop);
    visPop.classList.toggle("hidden");
  });
  $("focus-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    closeOthers(focusPop);
    if (focusPop.classList.contains("hidden")) buildFocusMenu(focusPop);
    focusPop.classList.toggle("hidden");
  });
  $("snap-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    closeOthers(snapPop);
    if (snapPop.classList.contains("hidden")) buildSnapMenu(snapPop);
    snapPop.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    // Close each popup unless the click landed inside its own menu wrap.
    const wrap = (e.target as HTMLElement).closest(".menu-wrap");
    for (const p of allPops) {
      if (!p.classList.contains("hidden") && !wrap?.contains(p)) p.classList.add("hidden");
    }
    closeColorPop(e.target as HTMLElement);
    closeLaneMenu(e.target as HTMLElement);
  });

  $("rm-new").addEventListener("click", async () => {
    const name = await promptDialog("New roadmap", "", "Create");
    if (name) void actions.createRoadmap(name);
  });
  $("rm-rename").addEventListener("click", async () => {
    menuPop.classList.add("hidden");
    if (!state.current) return;
    const name = await promptDialog("Rename roadmap", state.current.name, "Rename");
    if (name) void actions.renameRoadmap(name);
  });
  $("rm-duplicate").addEventListener("click", async () => {
    menuPop.classList.add("hidden");
    if (!state.current) return;
    // Prefill a distinct name so the copy is deliberately named, not "(2)".
    const name = await promptDialog("Duplicate roadmap", `${state.current.name} (copy)`, "Duplicate");
    if (name) void actions.duplicateRoadmap(name);
  });
  $("rm-export").addEventListener("click", () => {
    menuPop.classList.add("hidden");
    actions.exportRoadmap();
  });
  const importFile = $("rm-import-file") as HTMLInputElement;
  $("rm-import").addEventListener("click", () => {
    menuPop.classList.add("hidden");
    importFile.click();
  });
  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    importFile.value = ""; // allow re-selecting the same file later
    if (file) void actions.importRoadmap(file);
  });
  $("rm-delete").addEventListener("click", async () => {
    menuPop.classList.add("hidden");
    if (!state.current) return;
    if (await confirmDialog(`Delete roadmap "${state.current.name}" and everything in it?`)) {
      void actions.deleteRoadmap();
    }
  });
  $("zoom-fit").addEventListener("click", () => zoomToFit());
  $("zoom-in").addEventListener("click", () => setZoom(state.pxPerDay * 1.4));
  $("zoom-out").addEventListener("click", () => setZoom(state.pxPerDay / 1.4));
  chart.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(state.pxPerDay * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false },
  );
}

function wireChart(): void {
  chart.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    if (t.closest("#empty-create")) {
      void (async () => {
        const name = await promptDialog("New roadmap", "", "Create");
        if (name) void actions.createRoadmap(name);
      })();
      return;
    }
    if (t.closest("#add-lane")) {
      void (async () => {
        const name = await promptDialog("New context (swimlane)", "", "Add");
        if (name) void actions.addLane(name);
      })();
      return;
    }
    // A parent's fold chevron: toggles its children, never selects the item.
    const disc = t.closest<HTMLElement>(".disclosure");
    if (disc) {
      e.stopPropagation();
      const id = Number(disc.dataset.itemId);
      state.setCollapsed(id, !state.isCollapsed(id));
      return;
    }

    const milestoneEl = t.closest<HTMLElement>(".milestone");
    if (milestoneEl) {
      state.selectMilestone(Number(milestoneEl.dataset.milestoneId));
      state.notify();
      return;
    }

    const laneEl = t.closest<HTMLElement>(".lane");
    if (laneEl) {
      const laneId = Number(laneEl.dataset.laneId);
      if (t.closest(".lane-add")) {
        void actions.addItem(laneId, null);
        return;
      }
      const menuBtn = t.closest<HTMLElement>(".lane-menu-btn");
      if (menuBtn) {
        // Keep this click away from the document-level close handler.
        e.stopPropagation();
        toggleLaneMenu(menuBtn, laneId);
        return;
      }
    }
    // Click on empty chart space clears the selection.
    if (!t.closest(".bar, .child-bar, .milestone, .lane-label") && state.clearSelection()) {
      state.notify();
    }
  });

  // Double-click a lane name to rename it inline.
  chart.addEventListener("dblclick", (e) => {
    const nameEl = (e.target as HTMLElement).closest<HTMLElement>(".lane-name");
    const laneEl = (e.target as HTMLElement).closest<HTMLElement>(".lane");
    if (!nameEl || !laneEl) return;
    startLaneRename(nameEl, Number(laneEl.dataset.laneId));
  });
}

// startLaneRename swaps a lane's name span for an input, committing on Enter or
// blur and reverting on Escape. Shared by the double-click shortcut and the
// lane menu's Rename entry, so there is one editor rather than two.
function startLaneRename(nameEl: HTMLElement, laneId: number): void {
  const input = document.createElement("input");
  input.className = "lane-name-input";
  input.value = nameEl.textContent ?? "";
  nameEl.replaceWith(input);
  // focus() before select(): entering from the menu leaves focus on a button
  // that is about to be removed, so selection alone would not put the caret here.
  input.focus();
  input.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(nameEl);
    if (save && v && v !== nameEl.textContent) void actions.renameLane(laneId, v);
  };
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") commit(true);
    if (ev.key === "Escape") commit(false);
  });
}

// laneNameEl finds a lane's name span in the rendered chart.
function laneNameEl(laneId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.lane[data-lane-id="${laneId}"] .lane-name`);
}

// Lane visibility menu: one toggle row per context. Visibility is a view
// preference held in state (persisted per roadmap), not a data mutation, so
// toggling doesn't go through actions. The menu is rebuilt after each toggle
// to reflect the new eye state while staying open.
function buildLaneVisMenu(pop: HTMLElement): void {
  pop.replaceChildren();
  const lanes = state.current?.lanes ?? [];
  if (lanes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No contexts yet.";
    pop.append(empty);
    return;
  }
  for (const lane of lanes) {
    const hidden = state.isLaneHidden(lane.id);
    const row = document.createElement("button");
    row.className = hidden ? "menu-item lane-vis-item is-hidden" : "menu-item lane-vis-item";
    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = laneColorValue(lane.color);
    const name = document.createElement("span");
    name.className = "lane-vis-name";
    name.textContent = lane.name;
    row.append(hidden ? icons.eyeOff(16) : icons.eye(16), dot, name);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      state.setLaneHidden(lane.id, !state.isLaneHidden(lane.id));
      buildLaneVisMenu(pop);
    });
    pop.append(row);
  }
}

// Lane actions dropdown: a fixed-position menu anchored to the lane's dots
// button (appended to body so it isn't clipped by the chart's scroll area).
// Holds the less-frequent per-lane actions to keep the lane toolbar short.

function closeLaneMenu(target?: HTMLElement): void {
  const menu = document.querySelector<HTMLElement>(".lane-menu");
  if (menu && (!target || !target.closest(".lane-menu"))) menu.remove();
}

function toggleLaneMenu(anchor: HTMLElement, laneId: number): void {
  const existing = document.querySelector<HTMLElement>(".lane-menu");
  const wasOpenHere = existing?.dataset.laneId === String(laneId);
  closeLaneMenu();
  closeColorPop();
  if (wasOpenHere) return;

  const lane = state.findLane(laneId);
  if (!lane) return;
  const menu = document.createElement("div");
  menu.className = "menu lane-menu";
  menu.dataset.laneId = String(laneId);

  // The discoverable route into the same inline editor that double-clicking
  // the lane name opens.
  const rename = document.createElement("button");
  rename.className = "menu-item";
  rename.append(icons.pencil(16), text("Rename context"));
  rename.addEventListener("click", () => {
    closeLaneMenu();
    const nameEl = laneNameEl(laneId);
    if (nameEl) startLaneRename(nameEl, laneId);
  });

  const addMs = document.createElement("button");
  addMs.className = "menu-item";
  addMs.append(icons.flag(16), text("Add milestone"));
  addMs.addEventListener("click", () => {
    closeLaneMenu();
    void actions.addMilestone(laneId);
  });

  const color = document.createElement("button");
  color.className = "menu-item";
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.background = laneColorValue(lane.color);
  color.append(dot, text("Lane color"));
  color.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLaneMenu();
    toggleColorPop(anchor, laneId);
  });

  const del = document.createElement("button");
  del.className = "menu-item menu-danger";
  del.append(icons.trash(16), text("Delete context"));
  del.addEventListener("click", () => {
    closeLaneMenu();
    void (async () => {
      const n = lane.items.length;
      const suffix = n > 0 ? ` and its ${n} item(s)` : "";
      if (await confirmDialog(`Delete context "${lane.name}"${suffix}?`)) {
        void actions.deleteLane(laneId);
      }
    })();
  });

  menu.append(rename, addMs, color, del);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  // Right-align the menu under the button so it doesn't run off-screen.
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
  menu.style.top = `${r.bottom + 6}px`;
}

function text(s: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = s;
  return span;
}

// Focus menu: pick a label to spotlight. Selecting one dims every item that
// lacks it (see state.isDimmed / render.ts); "Show all items" clears the
// focus. Rebuilt after each pick so the active row stays checked while open.
function buildFocusMenu(pop: HTMLElement): void {
  pop.replaceChildren();
  const labels = state.allLabels();
  if (labels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No labels yet — add some to an item.";
    pop.append(empty);
    return;
  }

  const row = (labelText: string, active: boolean, onPick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = active ? "menu-item is-active" : "menu-item";
    const mark = document.createElement("span");
    mark.className = "menu-check";
    if (active) mark.append(icons.check(14));
    const name = document.createElement("span");
    name.className = "focus-label-name";
    name.textContent = labelText;
    b.append(mark, name);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick();
      state.notify();
      buildFocusMenu(pop);
    });
    return b;
  };

  pop.append(
    row("Show all items", state.focusLabel === null, () => {
      state.focusLabel = null;
    }),
  );
  for (const l of labels) {
    pop.append(
      row(l, state.focusLabel === l, () => {
        state.focusLabel = state.focusLabel === l ? null : l;
      }),
    );
  }
}

// Lane color picker popover: a row of swatches anchored to the color button.

function closeColorPop(target?: HTMLElement): void {
  const pop = document.querySelector<HTMLElement>(".color-pop");
  if (pop && (!target || !target.closest(".color-pop"))) pop.remove();
}

function toggleColorPop(anchor: HTMLElement, laneId: number): void {
  const existing = document.querySelector<HTMLElement>(".color-pop");
  const wasOpenHere = existing?.dataset.laneId === String(laneId);
  closeColorPop();
  if (wasOpenHere) return;

  const lane = state.findLane(laneId);
  if (!lane) return;
  const pop = document.createElement("div");
  pop.className = "color-pop";
  pop.dataset.laneId = String(laneId);
  for (const name of LANE_COLOR_ORDER) {
    const sw = document.createElement("button");
    sw.className = "swatch";
    sw.title = name;
    sw.style.background = laneColorValue(name);
    if (name === lane.color) sw.append(icons.check(12));
    sw.addEventListener("click", () => {
      closeColorPop();
      if (name !== lane.color) void actions.setLaneColor(laneId, name);
    });
    pop.append(sw);
  }
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 6}px`;
  document.body.append(pop);
}

async function boot(): Promise<void> {
  state.subscribe(render);
  injectIcons();
  wireTopbar();
  wireChart();
  wirePanelResize();
  initDnd(chart);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.clearSelection()) {
      state.notify();
    }
  });

  const storedZoom = Number(localStorage.getItem("roadie.zoom"));
  if (storedZoom) {
    state.pxPerDay = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, storedZoom));
  }
  const storedSnap = localStorage.getItem("roadie.snap");
  if (storedSnap === "day" || storedSnap === "week" || storedSnap === "month" || storedSnap === "quarter") {
    state.snapMode = storedSnap;
  }
  const storedWidth = Number(localStorage.getItem("roadie.panelWidth"));
  if (storedWidth) {
    state.panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, storedWidth));
  }

  await actions.loadRoadmaps();
  const stored = Number(localStorage.getItem("roadie.roadmap"));
  const initial = state.roadmaps.find((r) => r.id === stored) ?? state.roadmaps[0];
  if (initial) {
    await actions.selectRoadmap(initial.id);
  } else {
    state.notify();
  }
}

void boot();
