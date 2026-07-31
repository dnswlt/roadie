import "./styles.css";
import { actions } from "./actions";
import { api } from "./api";
import { LANE_COLOR_ORDER, laneColorValue } from "./colors";
import { confirmDialog, promptDialog } from "./dialogs";
import { initDnd } from "./dnd";
import { initEvents, refreshNow } from "./events";
import { initFind } from "./find";
import { renderHistory } from "./history";
import { icons } from "./icons";
import { initHome, openHome } from "./home";
import { bindings, initKeys } from "./keys";
import { LABEL_W } from "./layout";
import { currentScale, projectSelection, renderChart } from "./render";
import { focusPanelTitle, renderPanel } from "./panel";
import { parseSchedule, serializeSchedule } from "./schedule";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, state } from "./state";
import { contentRange, MAX_PX_PER_DAY, MIN_PX_PER_DAY, type SnapMode, xOf } from "./timescale";
import type { Me } from "./types";
import { readUrl, type UrlTarget } from "./url";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

const chart = $("chart");
const panel = $("panel");
const panelResize = $("panel-resize");
const historyEl = $("history");
const snapshotBanner = $("snapshot-banner");
const rmPicker = $("rm-picker") as HTMLButtonElement;

// Human labels for the drag-snap grids, in menu order.
const SNAP_LABELS: Record<SnapMode, string> = {
  day: "Day",
  week: "Week (Mon)",
  month: "Month (1st)",
  quarter: "Quarter",
  schedule: "Schedule",
};

// hasSchedule reports whether the current roadmap defines a schedule; the
// "schedule" snap mode and band only apply then.
function hasSchedule(): boolean {
  return (state.current?.periods.length ?? 0) > 0;
}

// snapActive reports whether snapping visibly does something, for the magnet
// button highlight: any grid but "day", except "schedule" on a roadmap without
// one (where it degrades to free placement).
function snapActive(): boolean {
  if (state.snapMode === "day") return false;
  if (state.snapMode === "schedule") return hasSchedule();
  return true;
}

function render(): void {
  renderTopbar();
  renderChart(chart);
  renderPanel(panel);
  renderHistory(historyEl, snapshotBanner);
  renderStalePill();
}

// renderStalePill shows/hides the "Updated elsewhere" affordance, raised when a
// remote change arrived while it was unsafe to auto-refresh (see events.ts).
function renderStalePill(): void {
  const existing = document.getElementById("stale-pill");
  if (!state.stale) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const pill = document.createElement("button");
  pill.id = "stale-pill";
  pill.className = "stale-pill";
  pill.textContent = "Updated elsewhere · Refresh";
  pill.addEventListener("click", refreshNow);
  document.body.appendChild(pill);
}

// renderVisibilityItem rebuilds the menu's private/public toggle. It is hidden
// outright unless the roadmap is one you own, which covers three cases with one
// condition and no mention of the auth mode: with auth off nobody owns
// anything, roadmaps predating this feature have no owner, and somebody else's
// roadmap is not yours to lock. The label states the action, not the state —
// the state is already visible as the lock beside the roadmap's name in Home.
function renderVisibilityItem(): void {
  const btn = $("rm-visibility") as HTMLButtonElement;
  const rm = state.current;
  btn.classList.toggle("hidden", !rm?.owned);
  if (!rm?.owned) return;
  const goPrivate = rm.visibility === "public";
  btn.replaceChildren(
    goPrivate ? icons.lock(14) : icons.globe(14),
    document.createTextNode(goPrivate ? "Make private" : "Make public"),
  );
  btn.title = goPrivate
    ? "Only you can see this roadmap"
    : "Everyone can see and edit this roadmap";
}

function renderTopbar(): void {
  // The name button drops the actions menu for the roadmap it names, so it is
  // disabled when nothing is open — Home stays reachable via the house button,
  // which is never disabled (with no roadmaps, Home is where New/Import live).
  const name = document.createElement("span");
  name.className = "rm-trigger-name";
  name.textContent = state.current?.name ?? "No roadmap";
  rmPicker.replaceChildren(name, icons.chevronDown(14));
  rmPicker.title = state.current?.name ?? "";
  rmPicker.disabled = !state.current;
  ($("rm-rename") as HTMLButtonElement).disabled = !state.current;
  ($("rm-duplicate") as HTMLButtonElement).disabled = !state.current;
  ($("rm-history") as HTMLButtonElement).disabled = !state.current;
  ($("rm-schedule") as HTMLButtonElement).disabled = !state.current;
  ($("rm-export") as HTMLButtonElement).disabled = !state.current;
  ($("rm-delete") as HTMLButtonElement).disabled = !state.current;
  // Find searches the loaded roadmap, so it has nothing to do without one.
  ($("find-menu") as HTMLButtonElement).disabled = !state.current;
  renderVisibilityItem();
  // Surface active focus even while the dropdown is closed.
  $("focus-menu").classList.toggle("active", state.focus !== null);
  $("focus-menu").title =
    state.focus === null
      ? "Focus on a label or on flagged items"
      : state.focus.kind === "flagged"
        ? "Focus: flagged items"
        : `Focus: ${state.focus.label}`;
  // Highlight the snap button when a grid (not plain Day) is actually engaged.
  $("snap-menu").classList.toggle("active", snapActive());
  const snapLabel = snapActive() ? SNAP_LABELS[state.snapMode] : "Day";
  $("snap-menu").title = `Snap to ${snapLabel} — see Help (?) for modifier keys`;
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

// buildSnapMenu (re)populates the snap-grid popover: one row per mode, the
// active one check-marked. Picking a mode applies it and closes the menu. The
// "Schedule" row is disabled until the roadmap defines a schedule (edited from
// the roadmap menu, since the schedule is roadmap data, not a snap setting).
function buildSnapMenu(pop: HTMLElement): void {
  pop.replaceChildren();
  const modes: SnapMode[] = ["day", "week", "month", "quarter", "schedule"];
  const scheduleReady = hasSchedule();
  for (const mode of modes) {
    const disabled = mode === "schedule" && !scheduleReady;
    const active = state.snapMode === mode && !disabled;
    const b = document.createElement("button");
    b.className = active ? "menu-item is-active" : "menu-item";
    const mark = document.createElement("span");
    mark.className = "menu-check";
    if (active) mark.append(icons.check(14));
    const name = document.createElement("span");
    name.textContent = SNAP_LABELS[mode];
    b.append(mark, name);
    if (disabled) {
      b.disabled = true;
      b.title = "Define a schedule first (roadmap menu → Edit schedule)";
    } else {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setSnapMode(mode);
        pop.classList.add("hidden");
        renderTopbar();
      });
    }
    pop.append(b);
  }
}

// openHelpDialog shows a centered modal with a small reference card. Start with
// snapping (the most modal, least discoverable gesture); add sections here as
// needed. Escape / Close dismiss it (native <dialog>).
function openHelpDialog(): void {
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Help";

  const body = document.createElement("div");
  body.className = "help-body";

  const section = document.createElement("div");
  section.className = "help-section";
  const sh = document.createElement("h4");
  sh.textContent = "Snapping";
  const p = document.createElement("p");
  p.textContent =
    "Dragging or resizing an item snaps to the grid you pick in the magnet menu (Day, Week, Month, Quarter, or Schedule) and to nearby item edges, milestones, and today. Moving an item aligns its start to the grid, keeping its duration; either edge still clicks onto a nearby item edge, milestone, or today. Resizing snaps the edge you grabbed.";
  section.append(sh, p);

  const keys = document.createElement("dl");
  keys.className = "help-keys";
  const addKey = (key: string, desc: string): void => {
    const dt = document.createElement("dt");
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    dt.append(kbd);
    const dd = document.createElement("dd");
    dd.textContent = desc;
    keys.append(dt, dd);
  };
  addKey("Shift", "Snap to the selected grid only — steadier for coarse grids like Quarter or Schedule.");
  addKey("Alt", "Turn snapping off for free, day-by-day placement.");
  section.append(keys);
  body.append(section);

  // Shortcuts are listed straight from the binding table (keys.ts), so adding
  // one there documents it here.
  const shortcuts = document.createElement("div");
  shortcuts.className = "help-section";
  const kh = document.createElement("h4");
  kh.textContent = "Shortcuts";
  const kl = document.createElement("dl");
  kl.className = "help-keys";
  for (const b of bindings) {
    const dt = document.createElement("dt");
    const kbd = document.createElement("kbd");
    kbd.textContent = b.label;
    dt.append(kbd);
    const dd = document.createElement("dd");
    dd.textContent = b.description;
    kl.append(dt, dd);
  }
  shortcuts.append(kh, kl);
  body.append(shortcuts);

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  row.append(close);

  dlg.append(h, body, row);
  dlg.showModal();
}

// openScheduleEditor shows the roadmap's schedule in a textarea (one period per
// line, START END LABEL) and saves it as a full replace. Parse errors are shown
// inline and keep the dialog open; a server rejection (e.g. overlap) toasts and
// also keeps it open, so nothing typed is lost.
async function openScheduleEditor(): Promise<void> {
  const rm = state.current;
  if (!rm) return;
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Edit schedule";
  const help = document.createElement("p");
  help.className = "dialog-help";
  help.textContent =
    "One period per line: START END LABEL. Dates are YYYY-MM-DD, end inclusive. Blank lines and # comments are ignored. An empty list clears the schedule.";
  const ta = document.createElement("textarea");
  ta.className = "schedule-editor";
  ta.rows = 10;
  ta.spellcheck = false;
  ta.value = serializeSchedule(rm.periods);
  ta.placeholder = "2026-01-05 2026-01-16 Sprint 1";
  const errBox = document.createElement("div");
  errBox.className = "dialog-errors";

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn btn-primary";
  ok.textContent = "Save";
  row.append(cancel, ok);
  dlg.append(h, help, ta, errBox, row);

  cancel.addEventListener("click", () => dlg.close());
  ok.addEventListener("click", async () => {
    const { periods, errors } = parseSchedule(ta.value);
    if (errors.length > 0) {
      errBox.textContent = errors.join("\n");
      return;
    }
    errBox.textContent = "";
    ok.disabled = true;
    const saved = await actions.replaceSchedule(periods);
    ok.disabled = false;
    if (saved) dlg.close();
  });

  dlg.showModal();
  ta.focus();
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

// renderAccount fills in the account menu, and reveals it at all, only on an
// authenticated deployment. Called once from boot rather than from render():
// who we are cannot change without a page load.
function renderAccount(me: Me): void {
  if (me.mode === "open") return;
  $("account-wrap").classList.remove("hidden");
  const who = $("account-who");
  const name = document.createElement("strong");
  name.textContent = me.name || "Signed in";
  who.replaceChildren(name);
  // The email is worth showing only when it adds something to the display name.
  if (me.email && me.email !== me.name) who.append(me.email);
  $("account-menu").title = me.name ? `Signed in as ${me.name}` : "Account";
}

function injectIcons(): void {
  $("home-btn").prepend(icons.house(16));
  $("find-menu").append(icons.search(18));
  $("lane-vis-menu").append(icons.eye(18));
  $("focus-menu").append(icons.tag(18));
  $("rm-rename").prepend(icons.pencil(14));
  $("rm-duplicate").prepend(icons.copy(14));
  $("rm-history").prepend(icons.history(14));
  $("rm-schedule").prepend(icons.calendar(14));
  $("rm-export").prepend(icons.download(14));
  $("rm-delete").prepend(icons.trash(14));
  $("snap-menu").append(icons.magnet(18));
  $("zoom-fit").append(icons.zoomFit());
  $("zoom-in").append(icons.zoomIn());
  $("zoom-out").append(icons.zoomOut());
  $("help-menu").append(icons.help(18));
  $("account-menu").append(icons.user(18));
  $("account-signout").prepend(icons.signOut(14));
}

function wireTopbar(): void {
  const menuPop = $("rm-menu-pop");
  const visPop = $("lane-vis-pop");
  const focusPop = $("focus-pop");
  const snapPop = $("snap-pop");
  const accountPop = $("account-pop");
  const findPop = $("find-pop");
  const allPops = [menuPop, visPop, focusPop, snapPop, accountPop, findPop];
  // Close every top-bar popover except the one being opened.
  const closeOthers = (keep: HTMLElement): void => {
    for (const p of allPops) if (p !== keep) p.classList.add("hidden");
  };
  $("home-btn").addEventListener("click", () => void openHome());
  rmPicker.addEventListener("click", (e) => {
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
  $("help-menu").addEventListener("click", () => openHelpDialog());
  $("account-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    closeOthers(accountPop);
    accountPop.classList.toggle("hidden");
  });
  $("account-signout").addEventListener("click", () => {
    // Land on the dedicated signed-out page, not "/": going home would hit the
    // login redirect and, with the provider session still alive, sign us
    // straight back in — making the button look broken.
    void api.logout().then(
      () => location.assign("/auth/signed-out"),
      () => location.assign("/auth/signed-out"),
    );
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
  $("rm-visibility").addEventListener("click", async () => {
    menuPop.classList.add("hidden");
    if (!state.current) return;
    // Both directions confirm. Publishing obviously has to — it exposes the
    // roadmap to everyone — but so does locking down, for a different reason:
    // it is easy to undo yet just as easy to hit by accident and not notice,
    // and a roadmap that silently vanished from everyone else's list is a
    // problem nobody knows to look for. Neither is destructive, so both use the
    // neutral confirm button rather than the red one.
    const goPrivate = state.current.visibility === "public";
    const ok = await confirmDialog(
      goPrivate
        ? `Make "${state.current.name}" private? Only you will be able to see it.`
        : `Make "${state.current.name}" public? Everyone will be able to see and edit it.`,
      goPrivate ? "Make private" : "Make public",
      false,
    );
    if (ok) void actions.setVisibility(goPrivate ? "private" : "public");
  });
  $("rm-history").addEventListener("click", () => {
    menuPop.classList.add("hidden");
    void actions.openHistory();
  });
  $("rm-schedule").addEventListener("click", () => {
    menuPop.classList.add("hidden");
    void openScheduleEditor();
  });
  $("rm-export").addEventListener("click", () => {
    menuPop.classList.add("hidden");
    actions.exportRoadmap();
  });
  $("rm-delete").addEventListener("click", async () => {
    menuPop.classList.add("hidden");
    if (!state.current) return;
    // Name the trash: the reassurance is the whole point of it, and it is worth
    // nothing if the confirm still reads like the end of the world.
    const ok = await confirmDialog(
      `Delete roadmap "${state.current.name}"? You can restore it from the trash.`,
    );
    if (ok) void actions.deleteRoadmap();
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
      state.notifySelection();
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
      state.notifySelection();
    }
  });

  // Double-click a lane name to rename it inline; double-click a milestone to
  // rename it in the panel. Real dblclick events, possible because neither
  // pointerdown is preventDefault-ed and selection no longer rebuilds the
  // chart between the clicks. Bars get theirs from dnd.ts instead (CLAUDE.md).
  chart.addEventListener("dblclick", (e) => {
    const t = e.target as HTMLElement;
    const nameEl = t.closest<HTMLElement>(".lane-name");
    const laneEl = t.closest<HTMLElement>(".lane");
    if (nameEl && laneEl) {
      startLaneRename(nameEl, Number(laneEl.dataset.laneId));
      return;
    }
    if (t.closest(".milestone")) focusPanelTitle();
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
    if (ev.key === "Escape") {
      // This editor owns the Escape. Without stopping it here the global
      // binding fires too (it is one of the few that run inside text fields),
      // so cancelling a rename would also clear the selection and close the
      // edit panel. Panel fields are the deliberate exception — see keys.ts.
      ev.stopPropagation();
      commit(false);
    }
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

// placePopover positions a body-level, position:fixed popover against its
// anchor. It opens downwards, but **flips above the anchor** when there isn't
// room below — without that, the last context's menu hangs off the bottom of
// the window and its lower rows can't be reached at all (the popover is fixed,
// so the page cannot be scrolled to them). Both axes are clamped to the
// viewport as a last resort, for a window too short to fit the menu either way.
//
// The element must already be in the DOM: its measured size decides both the
// flip and the right-alignment.
function placePopover(el: HTMLElement, anchor: HTMLElement, align: "left" | "right"): void {
  const GAP = 6; // breathing room between anchor and popover
  const EDGE = 8; // keep this far clear of the viewport edges
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = el;

  const wanted = align === "right" ? r.right - w : r.left;
  const maxLeft = Math.max(EDGE, window.innerWidth - w - EDGE);
  el.style.left = `${Math.min(Math.max(EDGE, wanted), maxLeft)}px`;

  const below = r.bottom + GAP;
  const above = r.top - GAP - h;
  const fitsBelow = below + h <= window.innerHeight - EDGE;
  el.style.top = `${fitsBelow || above < EDGE ? Math.min(below, window.innerHeight - h - EDGE) : above}px`;
}

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

  menu.append(addMs, color, rename, del);
  document.body.append(menu);
  // Right-aligned under the button, which keeps it clear of the right edge.
  placePopover(menu, anchor, "right");
}

function text(s: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = s;
  return span;
}

// Focus menu: pick a label — or the flag — to spotlight. Selecting one dims
// every item that doesn't match (see state.isDimmed / render.ts); "Show all
// items" clears the focus. Rebuilt after each pick so the active row stays
// checked while open.
//
// Flagged is pinned above the labels rather than sorted among them: it isn't
// one tag of many, and its count is the only place the total is visible.
function buildFocusMenu(pop: HTMLElement): void {
  pop.replaceChildren();
  const labels = state.allLabels();
  const flagged = state.flaggedCount();
  if (labels.length === 0 && flagged === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "Nothing to focus on yet — flag an item (!) or give it a label.";
    pop.append(empty);
    return;
  }

  const row = (
    labelText: string,
    active: boolean,
    onPick: () => void,
    icon?: Node,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = active ? "menu-item is-active" : "menu-item";
    const mark = document.createElement("span");
    mark.className = "menu-check";
    if (active) mark.append(icons.check(14));
    const name = document.createElement("span");
    name.className = "focus-label-name";
    name.textContent = labelText;
    b.append(mark);
    if (icon) b.append(icon);
    b.append(name);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick();
      state.notify();
      buildFocusMenu(pop);
    });
    return b;
  };

  pop.append(
    row("Show all items", state.focus === null, () => {
      state.focus = null;
    }),
  );
  if (flagged > 0) {
    const active = state.focus?.kind === "flagged";
    pop.append(
      row(
        `Flagged (${flagged})`,
        active,
        () => {
          state.focus = active ? null : { kind: "flagged" };
        },
        icons.flag(14),
      ),
    );
    if (labels.length > 0) {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      pop.append(sep);
    }
  }
  for (const l of labels) {
    const active = state.focus?.kind === "label" && state.focus.label === l;
    pop.append(
      row(l, active, () => {
        state.focus = active ? null : { kind: "label", label: l };
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
  // Append before placing: placePopover measures the element to decide whether
  // it still fits below the anchor.
  document.body.append(pop);
  placePopover(pop, anchor, "left");
}

// applySelection restores a deep-linked item/milestone selection after its
// roadmap is loaded. It expands a collapsed parent so the target is on screen,
// and asks the next render to scroll it into view. It does not notify — boot
// does, once, at the end.
function applySelection(sel: UrlTarget["selection"]): void {
  if (!sel) return;
  if (sel.kind === "item") {
    const loc = state.findItem(sel.id);
    if (!loc) return;
    if (loc.parent) state.setCollapsed(loc.parent.id, false);
    state.selectItem(sel.id);
  } else if (!state.findMilestone(sel.id)) {
    return;
  } else {
    state.selectMilestone(sel.id);
  }
  state.scrollToSelection = true;
}

async function boot(): Promise<void> {
  state.subscribe(render);
  // Selection scope: project onto the chart, re-render only the panel (which
  // guards itself against rebuilding under a focused field).
  state.subscribeSelection(() => {
    projectSelection(chart);
    renderPanel(panel);
  });
  injectIcons();
  wireTopbar();
  initHome();
  initFind();
  wireChart();
  wirePanelResize();
  initDnd(chart);
  initEvents(panel);
  initKeys();

  const storedZoom = Number(localStorage.getItem("roadie.zoom"));
  if (storedZoom) {
    state.pxPerDay = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, storedZoom));
  }
  const storedSnap = localStorage.getItem("roadie.snap");
  if (
    storedSnap === "day" ||
    storedSnap === "week" ||
    storedSnap === "month" ||
    storedSnap === "quarter" ||
    storedSnap === "schedule"
  ) {
    state.snapMode = storedSnap;
  }
  const storedWidth = Number(localStorage.getItem("roadie.panelWidth"));
  if (storedWidth) {
    state.panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, storedWidth));
  }

  // Capture the deep link before anything can rewrite the address bar.
  const target = readUrl();

  // First call of the session, and on an authenticated deployment also the
  // gate: reaching the app with an expired session gets a 401 here, and the
  // api layer navigates to the login flow instead of returning.
  state.me = await api.me();
  renderAccount(state.me);

  await actions.loadRoadmaps();

  let initial = target.roadmapId !== null
    ? state.roadmaps.find((r) => r.id === target.roadmapId)
    : undefined;
  if (!initial) {
    const stored = Number(localStorage.getItem("roadie.roadmap"));
    initial = state.roadmaps.find((r) => r.id === stored) ?? state.roadmaps[0];
  }

  if (initial) {
    await actions.selectRoadmap(initial.id);
    // Only honour the hash selection if we actually landed on its roadmap;
    // a stale/foreign roadmap id would point the selection at the wrong chart.
    if (initial.id === target.roadmapId) applySelection(target.selection);
  }

  state.notify();
}

void boot();
