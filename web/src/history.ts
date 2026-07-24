// Version-history browsing UI: a side list of snapshots (live scrub) plus a
// banner shown while a snapshot is being previewed. Kept out of the edit-panel
// code — this owns its own elements and reads only state.history / state.preview.

import { actions } from "./actions";
import { confirmDialog } from "./dialogs";
import { icons } from "./icons";
import { state } from "./state";
import type { Snapshot } from "./types";

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
// e.g. "Jul 24, 14:32".
function whenLabel(d: Date): string {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
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

function snapshotRow(snap: Snapshot): HTMLButtonElement {
  const d = new Date(snap.createdAt);
  const active = state.preview?.snapshotId === snap.id;
  const lines: HTMLElement[] = [];
  if (snap.name) {
    lines.push(textSpan("history-when", snap.name));
    lines.push(textSpan("history-sub", whenLabel(d)));
  } else {
    lines.push(textSpan("history-when", whenLabel(d)));
    const rel = relTime(d);
    if (rel) lines.push(textSpan("history-sub", rel));
  }
  return row(active, () => void actions.viewSnapshot(snap.id, snap.createdAt), lines);
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
  list.append(
    row(state.preview === null, () => void actions.backToCurrent(), [
      textSpan("history-when", "Current version"),
      textSpan("history-sub", "Live — unsaved edits appear here"),
    ]),
  );

  if (snaps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No earlier versions yet.";
    list.append(empty);
  } else {
    for (const snap of snaps) list.append(snapshotRow(snap));
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
  const lead = document.createElement("span");
  lead.className = "snapshot-banner-lead";
  lead.append(
    icons.eye(16),
    textSpan("snapshot-banner-text", `Viewing a snapshot from ${when} — read only`),
  );

  const restore = document.createElement("button");
  restore.className = "btn";
  restore.append(icons.rotateCcw(14), textSpan("", "Restore this version"));
  restore.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        `Restore this roadmap to its state from ${when}? Your current version is kept in history, so you can undo this.`,
        "Restore this version",
        false,
      );
      if (ok) void actions.restoreSnapshot(preview.snapshotId);
    })();
  });

  const back = document.createElement("button");
  back.className = "btn";
  back.textContent = "Back to current";
  back.addEventListener("click", () => void actions.backToCurrent());

  const acts = document.createElement("div");
  acts.className = "snapshot-banner-actions";
  acts.append(back, restore);

  bannerEl.replaceChildren(lead, acts);
}
