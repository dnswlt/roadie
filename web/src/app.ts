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
import { openHelpDialog } from "./help";
import { copyText } from "./clipboard";
import { bindings, initKeys } from "./keys";
import { projectSelection, renderChart } from "./render";
import { projectWbsSelection, renderWbs } from "./wbs";
import { initWbsDnd } from "./wbs-dnd";
import { laneMarkdown, roadmapMarkdown } from "./markdown";
import { focusPanelTitle, renderPanel } from "./panel";
import { parseSchedule, serializeSchedule } from "./schedule";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, state } from "./state";
import { type SnapMode } from "./timescale";
import type { Me } from "./types";
import { readUrl, type UrlTarget } from "./url";
import { restoreZoom, setZoom, zoomToFit } from "./zoom";

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
  if (state.viewMode === "wbs") renderWbs(chart);
  else renderChart(chart);
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
  ($("rm-copy-md") as HTMLButtonElement).disabled = !state.current;
  ($("rm-delete") as HTMLButtonElement).disabled = !state.current;
  // Find searches the loaded roadmap, so it has nothing to do without one.
  ($("find-menu") as HTMLButtonElement).disabled = !state.current;
  // Bulk folding follows the action-label convention: when every parent is
  // folded it offers Expand; otherwise it offers Collapse. No child items
  // means there is no operation, so the control stays visible but disabled.
  const foldAll = $("fold-all") as HTMLButtonElement;
  const expandAll = state.allParentsCollapsed();
  foldAll.replaceChildren(expandAll ? icons.expandAll(18) : icons.collapseAll(18));
  foldAll.title = expandAll ? "Expand all child items" : "Collapse all child items";
  foldAll.disabled = !state.hasParentItems();
  renderVisibilityItem();
  // Surface active focus even while the dropdown is closed.
  $("focus-menu").classList.toggle("active", state.focus !== null);
  $("focus-menu").title =
    state.focus === null
      ? "Focus on labels or on flagged items"
      : state.focus.kind === "flagged"
        ? "Focus: flagged items"
        : `Focus: ${state.focus.labels.join(", ")}`;
  // Highlight the snap button when a grid (not plain Day) is actually engaged.
  $("snap-menu").classList.toggle("active", snapActive());
  const snapLabel = snapActive() ? SNAP_LABELS[state.snapMode] : "Day";
  $("snap-menu").title = `Snap to ${snapLabel} — see Help (?) for modifier keys`;
  // The view toggle shows the view it switches TO (like rm-visibility: the
  // label states the action). Snap and zoom act on the time axis, which the
  // WBS projects away, so they hide rather than sit around disabled.
  const wbs = state.viewMode === "wbs";
  const viewBtn = $("view-toggle");
  viewBtn.replaceChildren(wbs ? icons.ganttChart(18) : icons.listTree(18));
  viewBtn.title = wbs ? "Switch to timeline view (v)" : "Switch to WBS view (v)";
  $("snap-wrap").classList.toggle("hidden", wbs);
  $("zoom-controls").classList.toggle("hidden", wbs);
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
  $("rm-copy-md").prepend(icons.copy(14));
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
  $("help-menu").addEventListener("click", () => openHelpDialog(bindings));
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
  // Export downloads the JSON that import and snapshots round-trip; this copies
  // the same roadmap as prose, for pasting somewhere that reads rather than
  // restores it.
  $("rm-copy-md").addEventListener("click", () => {
    menuPop.classList.add("hidden");
    if (state.current) void copyText(roadmapMarkdown(state.current), "Markdown");
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
  $("view-toggle").addEventListener("click", () => {
    state.setViewMode(state.viewMode === "wbs" ? "timeline" : "wbs");
  });
  $("fold-all").addEventListener("click", () => {
    state.setAllParentsCollapsed(!state.allParentsCollapsed());
  });
  $("zoom-fit").addEventListener("click", () => zoomToFit());
  $("zoom-in").addEventListener("click", () => setZoom(state.pxPerDay * 1.4));
  $("zoom-out").addEventListener("click", () => setZoom(state.pxPerDay / 1.4));
  chart.addEventListener(
    "wheel",
    (e) => {
      if (state.viewMode !== "timeline") return; // zoom is a time-axis concept
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

    // WBS view. The milestone group's fold header toggles like a disclosure.
    const msHead = t.closest<HTMLElement>(".wbs-ms-head");
    if (msHead) {
      const laneId = Number(msHead.dataset.laneId);
      state.setMilestonesCollapsed(laneId, !state.isMilestonesCollapsed(laneId));
      return;
    }
    // WBS item rows are wbs-dnd.ts territory (their pointerdown is
    // preventDefault-ed, so no click ever arrives here); milestone rows are
    // not draggable and keep their native click.
    const wbsMs = t.closest<HTMLElement>(".wbs-milestone");
    if (wbsMs) {
      state.selectMilestone(Number(wbsMs.dataset.milestoneId));
      state.notifySelection();
      return;
    }

    const laneEl = t.closest<HTMLElement>(".lane");
    if (laneEl) {
      const laneId = Number(laneEl.dataset.laneId);
      if (t.closest(".lane-add")) {
        // The mouse twin of "n": create, then drop the cursor in the new title
        // (which reveals the rail if it was collapsed). Without this, clicking +
        // and pressing "n" would leave you in two different places.
        void actions.addItem(laneId, null).then((item) => {
          if (item) focusPanelTitle();
        });
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
    // Click on empty chart space clears the selection. (.wbs-row is listed
    // for its link-icon clicks — the only row clicks that reach here, since
    // wbs-dnd.ts lets the anchor's pointerdown through.)
    if (
      !t.closest(".bar, .child-bar, .milestone, .lane-label, .wbs-row, .wbs-milestone") &&
      state.clearSelection()
    ) {
      state.notifySelection();
    }
  });

  // Double-click a lane name to rename it inline; double-click a milestone
  // (either view's) to rename it in the panel. Real dblclick events, possible
  // because neither pointerdown is preventDefault-ed and selection no longer
  // rebuilds the chart between the clicks. Bars get theirs from dnd.ts, WBS
  // item rows from wbs-dnd.ts (CLAUDE.md).
  chart.addEventListener("dblclick", (e) => {
    const t = e.target as HTMLElement;
    const nameEl = t.closest<HTMLElement>(".lane-name");
    const laneEl = t.closest<HTMLElement>(".lane");
    if (nameEl && laneEl) {
      startLaneRename(nameEl, Number(laneEl.dataset.laneId));
      return;
    }
    if (t.closest(".milestone, .wbs-milestone")) focusPanelTitle();
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
      // This editor owns Escape: here it means discard the inline rename,
      // whereas panel fields let the global binding blur and save them.
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
//
// Alt-click isolates ("show only this one") — hiding the other five a row at a
// time was the common case doing the most work. The way back out is the "Show
// all contexts" row, not a second meaning for Alt-click: the focus menu already
// has that row, and one entry that always widens beats a modifier whose
// direction depends on what is hidden.
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

  const showAll = document.createElement("button");
  showAll.className = "menu-item";
  showAll.append(icons.eye(16), text("Show all contexts"));
  showAll.disabled = state.hiddenLanes.size === 0;
  showAll.addEventListener("click", (e) => {
    e.stopPropagation();
    state.showAllLanes();
    buildLaneVisMenu(pop);
  });
  const sep = document.createElement("div");
  sep.className = "menu-sep";
  pop.append(showAll, sep);

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
      if (e.altKey) state.isolateLane(lane.id);
      else state.setLaneHidden(lane.id, !state.isLaneHidden(lane.id));
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
    // Same as the lane's + button: the milestone is created selected, so put
    // the cursor in its title rather than leaving it named "New milestone".
    void actions.addMilestone(laneId).then(() => focusPanelTitle());
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

  const copyMd = document.createElement("button");
  copyMd.className = "menu-item";
  copyMd.append(icons.copy(16), text("Copy as Markdown"));
  copyMd.addEventListener("click", () => {
    closeLaneMenu();
    if (state.current) void copyText(laneMarkdown(state.current, lane), "Markdown");
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

  menu.append(addMs, color, copyMd, rename, del);
  document.body.append(menu);
  // Right-aligned under the button, which keeps it clear of the right edge.
  placePopover(menu, anchor, "right");
}

function text(s: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = s;
  return span;
}

// Focus menu: pick labels — or the flag — to spotlight. Anything that matches
// none of the picks is dimmed (see state.isDimmed / render.ts); "Show all
// items" clears the focus. Rebuilt after each pick so the checks stay current
// while the menu is open.
//
// Labels are a multi-select: a click toggles one, and several focused labels
// match as OR. Alt-click is the shortcut back to a single label (isolateClick),
// which is what a plain click used to do — so the eye menu and this one now
// read the same way: click toggles, Alt-click isolates.
//
// Flagged is pinned above the labels rather than sorted among them: it isn't
// one tag of many, and its count is the only place the total is visible. It
// stays single-pick, because focus holds either labels or the flag.
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
    onPick: (e: MouseEvent) => void,
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
      onPick(e);
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
    pop.append(
      row(l, state.isFocusedLabel(l), (e) => {
        if (e.altKey) state.isolateFocusLabel(l);
        else state.toggleFocusLabel(l);
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
    if (name === lane.color) sw.append(icons.check(14));
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
    if (state.viewMode === "wbs") projectWbsSelection(chart);
    else projectSelection(chart);
    renderPanel(panel);
  });
  injectIcons();
  wireTopbar();
  initHome();
  initFind();
  wireChart();
  wirePanelResize();
  initDnd(chart);
  initWbsDnd(chart);
  initEvents(panel);
  initKeys();

  restoreZoom();
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
  // Timeline is the default; only the other value is worth reading back.
  if (localStorage.getItem("roadie.view") === "wbs") state.viewMode = "wbs";
  const storedWidth = Number(localStorage.getItem("roadie.panelWidth"));
  if (storedWidth) {
    state.panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, storedWidth));
  }
  state.panelCollapsed = localStorage.getItem("roadie.panelCollapsed") === "1";

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
