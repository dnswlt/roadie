// Version-history browsing UI: a side list of snapshots (live scrub) plus a
// banner shown while a snapshot is being previewed. Kept out of the edit-panel
// code — this owns its own elements and reads only state.history / state.preview.

import { actions } from "./actions";
import { confirmDialog, promptDialog } from "./dialogs";
import { icons } from "./icons";
import { state } from "./state";
import type { Contributor, Snapshot } from "./types";

// relTime renders a compact "how long ago" for recent snapshots; older ones
// fall back to just their absolute date (shown as the primary label).
function relTime(d: Date): string {
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return "";
}

// whenLabel is the absolute timestamp shown as a snapshot's primary line,
// e.g. "24 Jul, 14:32" (British day-first, 24-hour).
function whenLabel(d: Date): string {
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function textSpan(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

// row builds one clickable history row (the "Current" row or a snapshot).
function row(active: boolean, onClick: () => void, lines: HTMLElement[]): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = active ? "history-item is-active" : "history-item";
  const body = document.createElement("span");
  body.className = "history-item-body";
  body.append(...lines);
  const mark = document.createElement("span");
  mark.className = "history-mark";
  if (active) mark.append(icons.check(14));
  b.append(mark, body);
  b.addEventListener("click", onClick);
  return b;
}

// Snapshots are grouped by local calendar day so a long history stays compact.
// The most recent day is expanded by default; older days collapse. `toggledDays`
// holds the days the user has flipped from that default — module-local view
// state that survives re-renders and needs no reset (stale keys never match).
const toggledDays = new Set<string>();

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isDayExpanded(key: string, latestKey: string): boolean {
  const expandedByDefault = key === latestKey;
  return toggledDays.has(key) ? !expandedByDefault : expandedByDefault;
}

// dayLabel is the group header text: "Today" / "Yesterday" for the two most
// recent days, otherwise a British-format date, e.g. "24 Jul 2026".
function dayLabel(d: Date): string {
  const today = new Date();
  if (dayKey(d) === dayKey(today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

interface DayGroup {
  key: string;
  date: Date;
  snaps: Snapshot[];
}

// groupByDay splits the (newest-first) snapshot list into consecutive per-day
// runs, preserving order.
function groupByDay(snaps: Snapshot[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let cur: DayGroup | null = null;
  for (const s of snaps) {
    const d = new Date(s.createdAt);
    const key = dayKey(d);
    if (!cur || cur.key !== key) {
      cur = { key, date: d, snaps: [] };
      groups.push(cur);
    }
    cur.snaps.push(s);
  }
  return groups;
}

// dayHeader is the clickable group header: a chevron, the day label, and the
// count of snapshots that day. Clicking toggles the group open/closed.
function dayHeader(g: DayGroup, expanded: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "history-day";
  b.setAttribute("aria-expanded", String(expanded));
  b.append(
    expanded ? icons.chevronDown(14) : icons.chevronRight(14),
    textSpan("history-day-label", dayLabel(g.date)),
    textSpan("history-day-count", String(g.snaps.length)),
  );
  b.addEventListener("click", () => {
    if (toggledDays.has(g.key)) toggledDays.delete(g.key);
    else toggledDays.add(g.key);
    state.notify();
  });
  return b;
}

// lastEditorLabel describes the live roadmap's most recent edit, e.g. "2h ago
// by Alice Anderson". It is the subtitle of the "Current version" row: that
// row's job is to say how the live roadmap differs from the snapshots under it,
// and who touched it last does that with a fact rather than a slogan. Time
// leads, matching the snapshot rows below, where time is the primary label.
//
// Only the last editor appears here. The full author list is unbounded — a
// long-running roadmap reaches dozens of names — and this sidebar is 280px of
// scrubbing UI, so the complete list with per-author dates lives in the roadmap
// info dialog instead (info.ts).
//
// Returns null when nobody is recorded, which is the normal case with auth off:
// the row then carries no subtitle at all rather than an empty or invented one.
function lastEditorLabel(cs: Contributor[]): string | null {
  if (cs.length === 0) return null;
  // Parse rather than compare the ISO strings: same-instant timestamps can
  // differ in fractional digits, which sorts wrong lexicographically.
  const last = cs.reduce((a, b) => (Date.parse(b.lastSeen) > Date.parse(a.lastSeen) ? b : a));
  const when = new Date(last.lastSeen);
  return `${relTime(when) || whenLabel(when)} by ${last.name}`;
}

function snapshotRow(snap: Snapshot): HTMLButtonElement {
  const d = new Date(snap.createdAt);
  const active = state.preview?.snapshotId === snap.id;
  const lines: HTMLElement[] = [];
  if (snap.name) {
    // A checkpoint leads with the name it was given: that is the thing being
    // recognised, and its timestamp is only how to place it.
    const title = textSpan("history-when", "");
    title.append(icons.tag(12), document.createTextNode(snap.name));
    lines.push(title, textSpan("history-sub", whenLabel(d)));
  } else {
    lines.push(textSpan("history-when", whenLabel(d)));
    const rel = relTime(d);
    if (rel) lines.push(textSpan("history-sub", rel));
  }
  return row(active, () => void actions.viewSnapshot(snap.id, snap.createdAt), lines);
}

// sectionHead labels a run of rows in the list ("Checkpoints", "Auto-saved").
function sectionHead(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "history-section";
  h.textContent = text;
  return h;
}

// renderHistory (re)draws the history side-list and the preview banner from
// state. Called on every full re-render; both elements hide themselves when
// history is closed / no snapshot is previewed.
export function renderHistory(historyEl: HTMLElement, bannerEl: HTMLElement): void {
  const snaps = state.history;
  if (snaps === null) {
    historyEl.classList.remove("open");
    historyEl.replaceChildren();
    renderBanner(bannerEl);
    return;
  }
  historyEl.classList.add("open");

  const head = document.createElement("div");
  head.className = "history-head";
  head.append(textSpan("history-title", "Version history"));
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "Close history";
  close.append(icons.x(16));
  close.addEventListener("click", () => void actions.closeHistory());
  head.append(close);

  const list = document.createElement("div");
  list.className = "history-list";

  // The live roadmap, pinned at the top so scrubbing back to "now" is one click.
  const currentLines = [textSpan("history-when", "Current version")];
  const lastEdit = lastEditorLabel(state.contributors);
  if (lastEdit) currentLines.push(textSpan("history-sub", lastEdit));
  list.append(row(state.preview === null, () => void actions.backToCurrent(), currentLines));

  if (snaps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No earlier versions yet.";
    list.append(empty);
  } else {
    // Checkpoints are pinned above the day groups rather than sitting in them:
    // they exist to be recognised, and one that has to be dug out of a
    // collapsed day is not doing that job. The split is exclusive — a
    // checkpoint appears here and not again below — so the day groups hold the
    // unnamed captures only. Pinning breaks chronology, so the second heading
    // says what those captures are and never that they are older: a checkpoint
    // saved last night sits above automatic ones taken this morning.
    const checkpoints = snaps.filter((s) => s.name);
    const rest = snaps.filter((s) => !s.name);
    if (checkpoints.length > 0) {
      list.append(sectionHead("Checkpoints"));
      for (const snap of checkpoints) list.append(snapshotRow(snap));
    }
    if (rest.length > 0) {
      if (checkpoints.length > 0) list.append(sectionHead("Auto-saved"));
      // Group by day; the most recent day is expanded, older days collapse so a
      // long history reads as a short list of days (snaps are newest-first).
      const latestKey = dayKey(new Date(rest[0]!.createdAt));
      for (const g of groupByDay(rest)) {
        const expanded = isDayExpanded(g.key, latestKey);
        list.append(dayHeader(g, expanded));
        if (expanded) for (const snap of g.snaps) list.append(snapshotRow(snap));
      }
    }
  }

  historyEl.replaceChildren(head, list);
  renderBanner(bannerEl);
}

function renderBanner(bannerEl: HTMLElement): void {
  const preview = state.preview;
  if (!preview) {
    bannerEl.classList.add("hidden");
    bannerEl.replaceChildren();
    return;
  }
  bannerEl.classList.remove("hidden");

  const when = whenLabel(new Date(preview.createdAt));
  // Preview is only ever entered from the list, so the list is loaded whenever
  // this renders and the lookup always finds its row.
  const named = state.history?.find((s) => s.id === preview.snapshotId)?.name ?? null;
  const comparing = preview.compare !== undefined;
  const what = named ? `checkpoint ${named}` : "auto-saved snapshot";
  const lead = textSpan(
    "snapshot-banner-text",
    comparing ? `Changes since ${what} · ${when}` : `Viewing ${what} · ${when}`,
  );

  // The version-diff toggle: swaps the chart for what changed between this
  // snapshot and the live roadmap (diff-view.ts). It sits with the other
  // banner actions because comparing is a way of looking at the previewed
  // version, and scrubbing to another snapshot keeps it on.
  const compare = document.createElement("button");
  compare.className = comparing ? "btn btn-quiet active" : "btn btn-quiet";
  compare.append(icons.diff(14), textSpan("", comparing ? "Hide changes" : "Show changes"));
  compare.addEventListener("click", () => void actions.toggleCompare());

  const restore = document.createElement("button");
  restore.className = "btn btn-primary";
  restore.append(icons.rotateCcw(14), textSpan("", "Restore"));
  restore.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        `Restore this roadmap to its state from ${when}? Your current version is kept in history, so you can undo this.`,
        "Restore",
        "primary",
      );
      if (ok) void actions.restoreSnapshot(preview.snapshotId);
    })();
  });

  // Naming happens here rather than on a list row: you scrub until you
  // recognise a state, and the moment you recognise it is the moment it is
  // worth keeping. Naming an unnamed capture is also what saves it from being
  // pruned, so this is the only way to keep an old auto snapshot.
  const keep = document.createElement("button");
  keep.className = "btn btn-quiet";
  keep.append(
    named ? icons.pencil(14) : icons.tag(14),
    textSpan("", named ? "Rename" : "Save checkpoint"),
  );
  keep.addEventListener("click", () => {
    void (async () => {
      const title = named ? "Rename checkpoint" : "Save checkpoint";
      const next = await promptDialog(title, named ?? "", "Save");
      if (next) void actions.nameSnapshot(preview.snapshotId, next);
    })();
  });

  const remove = document.createElement("button");
  remove.className = "btn btn-quiet danger";
  remove.append(icons.trash(14), textSpan("", "Delete"));
  remove.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        `Delete checkpoint "${named}"? This removes it from version history.`,
        "Delete checkpoint",
      );
      if (ok) void actions.deleteSnapshot(preview.snapshotId);
    })();
  });

  const acts = document.createElement("div");
  acts.className = "snapshot-banner-actions";
  acts.append(compare, keep);
  if (named) acts.append(remove);
  acts.append(restore);

  bannerEl.replaceChildren(lead, acts);
}
