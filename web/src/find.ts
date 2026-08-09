// The find popup: a dropdown over the loaded roadmap, opened with "/" or the
// magnifier in the topbar. Matching and ranking live in search.ts (DOM-free
// and unit-tested), the input/list/cursor machine in search-list.ts; this
// module is only the topbar popup — where it sits, when it shows, and what
// picking a row does. Click-away dismissal comes with being a topbar popover
// (the document handler in app.ts).
//
// It deliberately does *not* filter or dim the chart. Picking a row is the
// only thing that changes what you're looking at, and until then nothing is
// selected — a broad query like "whe" is allowed to return hundreds of rows
// without yanking the edit panel onto whichever one happened to sort first.

import { createSearchList, type SearchList } from "./search-list";
import { state } from "./state";

let popEl: HTMLElement | null = null;
let listUI: SearchList | null = null;

function $pop(): HTMLElement {
  popEl ??= document.getElementById("find-pop")!;
  return popEl;
}

function isOpen(): boolean {
  return !$pop().classList.contains("hidden");
}

// The shell is built once and reused across opens, so the input keeps its
// element identity; refresh() on open recomputes the results instead.
function shell(): SearchList {
  listUI ??= createSearchList({
    placeholder: "Find items, milestones, contexts…",
    // Enough rows that scrolling, not the cap, is the limit users notice; the
    // head always reports the true total.
    maxRows: 50,
    emptyHint: "Type to search titles, labels, notes and context names.",
    showCount: true,
    // Close before revealing: a match may have moved or vanished since the
    // list was drawn (an SSE refresh mid-search is not deferred for this
    // popup — events.ts defers only for the edit panel); revealAndSelect
    // resolves against live state and handles both.
    onCommit: (m) => {
      closeFind();
      state.revealAndSelect(m.kind, m.id);
    },
    onDismiss: closeFind,
  });
  $pop().replaceChildren(listUI.el);
  return listUI;
}

export function closeFind(): void {
  $pop().classList.add("hidden");
}

export function openFind(): void {
  if (!state.current) return;
  // Owning the topbar: every other popover closes, the same way opening any
  // of them closes this one (see wireTopbar).
  for (const p of document.querySelectorAll<HTMLElement>(".topbar .menu")) {
    p.classList.add("hidden");
  }
  const ui = shell();
  $pop().classList.remove("hidden");
  // Results are recomputed rather than reused: the roadmap may have changed
  // (an edit, an SSE refresh) since this popup was last open.
  ui.refresh();
  ui.focus();
}

function toggleFind(): void {
  if (isOpen()) closeFind();
  else openFind();
}

export function initFind(): void {
  document.getElementById("find-menu")!.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFind();
  });
}
