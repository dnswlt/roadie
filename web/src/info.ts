// The "Roadmap info" dialog: roadmap-level facts that have nowhere else to
// live, plus the full author list. It owns its own DOM (like history.ts) rather
// than going through dialogs.ts, which holds generic prompt/confirm primitives.
//
// Everything except the authors comes from state.current, which the client
// already has — only the contributor list is fetched, and only when the dialog
// is opened. Contributors are deliberately not part of the roadmap payload (see
// internal/store/contributors.go), so this is the one extra request.

import { api } from "./api";
import { state } from "./state";
import { toast } from "./toast";
import { contentRange, formatDay } from "./timescale";
import type { Contributor, RoadmapFull } from "./types";

// stamp renders an ISO timestamp in the app's British day-first, 24-hour
// convention, with the year — unlike the history sidebar, this dialog shows
// dates that can be years apart, so the year is never redundant.
function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// countContents totals what the roadmap holds. Children count as items: they
// are items, and a total that skipped them would disagree with what the chart
// visibly contains.
function countContents(rm: RoadmapFull): { items: number; milestones: number } {
  let items = 0;
  let milestones = 0;
  for (const lane of rm.lanes) {
    for (const item of lane.items) items += 1 + item.children.length;
    milestones += lane.milestones.length;
  }
  return { items, milestones };
}

function factRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "info-row";
  const l = document.createElement("span");
  l.className = "info-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "info-value";
  v.textContent = value;
  row.append(l, v);
  return row;
}

// authorsTable lists everyone who has edited the roadmap with the window over
// which they did. Rows arrive alphabetically from the server and stay that way:
// ordering by activity would read as a ranking of who contributed most, which
// is not a claim this data supports.
function authorsTable(cs: Contributor[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "info-authors";

  const head = document.createElement("tr");
  for (const h of ["Author", "First edit", "Last edit"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  table.append(head);

  for (const c of cs) {
    const tr = document.createElement("tr");
    for (const text of [c.name, stamp(c.firstSeen), stamp(c.lastSeen)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    table.append(tr);
  }
  return table;
}

function sectionTitle(text: string): HTMLElement {
  const h = document.createElement("h4");
  h.className = "info-section";
  h.textContent = text;
  return h;
}

// openRoadmapInfo shows the dialog for the currently open roadmap. The
// contributor fetch is awaited before showing anything, so the dialog never
// appears and then reflows as the author list lands.
export async function openRoadmapInfo(): Promise<void> {
  const rm = state.current;
  if (!rm) return;

  let authors: Contributor[] = [];
  try {
    authors = await api.listContributors(rm.id);
  } catch (e) {
    // The facts below are worth showing even if attribution is unavailable, so
    // a failed fetch degrades to the no-authors case rather than no dialog.
    toast(e instanceof Error ? e.message : String(e), true);
  }

  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = rm.name;

  const facts = document.createElement("div");
  facts.className = "info-facts";
  // No "last updated" row: roadmaps.updated_at is only written when the roadmap
  // row itself is (a rename or a restore), so it says nothing about edits to the
  // lanes, items and milestones the roadmap actually consists of. The authors
  // table below carries the real answer.
  facts.append(factRow("Created", stamp(rm.createdAt)));

  const { items, milestones } = countContents(rm);
  facts.append(factRow("Contexts", String(rm.lanes.length)));
  facts.append(factRow("Items", String(items)));
  facts.append(factRow("Milestones", String(milestones)));

  const range = contentRange(rm.lanes);
  facts.append(
    factRow("Timespan", range ? `${formatDay(range.startDay)} – ${formatDay(range.endDay)}` : "—"),
  );
  facts.append(
    factRow(
      "Schedule",
      rm.periods.length > 0 ? `${rm.periods.length} periods` : "None",
    ),
  );

  dlg.append(h, facts);

  // With auth off nobody is ever recorded, so the whole section disappears
  // rather than showing an empty table.
  if (authors.length > 0) {
    // Scroll the author list rather than the dialog. A modal <dialog> gets
    // `overflow: auto` and a viewport-relative max-height from the UA
    // stylesheet, so a long list would otherwise scroll the whole dialog and
    // take the roadmap name and the Close button with it.
    const scroller = document.createElement("div");
    scroller.className = "info-authors-scroll";
    scroller.append(authorsTable(authors));
    dlg.append(sectionTitle(authors.length === 1 ? "Author" : "Authors"), scroller);
  }

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const close = document.createElement("button");
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  row.append(close);
  dlg.append(row);

  dlg.showModal();
}
