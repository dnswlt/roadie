import "./styles.css";
import { actions } from "./actions";
import { LANE_COLOR_ORDER, laneColorValue } from "./colors";
import { confirmDialog, promptDialog } from "./dialogs";
import { initDnd } from "./dnd";
import { icons } from "./icons";
import { LABEL_W } from "./layout";
import { renderChart } from "./render";
import { renderPanel } from "./panel";
import { state } from "./state";
import { MAX_PX_PER_DAY, MIN_PX_PER_DAY } from "./timescale";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

const chart = $("chart");
const panel = $("panel");
const rmSelect = $("rm-select") as HTMLSelectElement;

function render(): void {
  renderTopbar();
  renderChart(chart);
  renderPanel(panel);
}

function renderTopbar(): void {
  rmSelect.replaceChildren();
  for (const rm of state.roadmaps) {
    const opt = document.createElement("option");
    opt.value = String(rm.id);
    opt.textContent = rm.name;
    if (state.current?.id === rm.id) opt.selected = true;
    rmSelect.append(opt);
  }
  rmSelect.disabled = state.roadmaps.length === 0;
  ($("rm-rename") as HTMLButtonElement).disabled = !state.current;
  ($("rm-delete") as HTMLButtonElement).disabled = !state.current;
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

function injectIcons(): void {
  $("rm-new").prepend(icons.plus(14));
  $("rm-menu").append(icons.dots(18));
  $("lane-vis-menu").append(icons.eye(18));
  $("rm-rename").prepend(icons.pencil(14));
  $("rm-delete").prepend(icons.trash(14));
  $("zoom-in").append(icons.zoomIn());
  $("zoom-out").append(icons.zoomOut());
}

function wireTopbar(): void {
  const menuPop = $("rm-menu-pop");
  const visPop = $("lane-vis-pop");
  $("rm-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    visPop.classList.add("hidden");
    menuPop.classList.toggle("hidden");
  });
  $("lane-vis-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    menuPop.classList.add("hidden");
    if (visPop.classList.contains("hidden")) buildLaneVisMenu(visPop);
    visPop.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    // Close each popup unless the click landed inside its own menu wrap.
    const wrap = (e.target as HTMLElement).closest(".menu-wrap");
    if (!menuPop.classList.contains("hidden") && !wrap?.contains(menuPop)) {
      menuPop.classList.add("hidden");
    }
    if (!visPop.classList.contains("hidden") && !wrap?.contains(visPop)) {
      visPop.classList.add("hidden");
    }
    closeColorPop(e.target as HTMLElement);
    closeLaneMenu(e.target as HTMLElement);
  });

  rmSelect.addEventListener("change", () => {
    void actions.selectRoadmap(Number(rmSelect.value));
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
  $("rm-delete").addEventListener("click", async () => {
    menuPop.classList.add("hidden");
    if (!state.current) return;
    if (await confirmDialog(`Delete roadmap "${state.current.name}" and everything in it?`)) {
      void actions.deleteRoadmap();
    }
  });
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
    const laneId = Number(laneEl.dataset.laneId);
    const input = document.createElement("input");
    input.className = "lane-name-input";
    input.value = nameEl.textContent ?? "";
    nameEl.replaceWith(input);
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
  });
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

  menu.append(addMs, color, del);
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
