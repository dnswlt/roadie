// The find popup: a dropdown over the loaded roadmap, opened with "/" or the
// magnifier in the topbar. Matching and ranking live in search.ts (DOM-free
// and unit-tested), the input/list/cursor machine in search-list.ts; this
// module is only the topbar popup — where it sits, when it shows, and what
// picking a row does. Click-away dismissal, and dismissal by any other popover
// opening, come from registering with popover.ts.
//
// It deliberately does *not* filter or dim the chart. Picking a row is the
// only thing that changes what you're looking at, and until then nothing is
// selected — a broad query like "whe" is allowed to return hundreds of rows
// without yanking the edit panel onto whichever one happened to sort first.

import { openPopover, type PopoverHandle } from "./popover";
import { createSearchList, type SearchList } from "./search-list";
import { state } from "./state";
import { toast } from "./toast";

let popEl: HTMLElement | null = null;
let listUI: SearchList | null = null;
let handle: PopoverHandle | null = null;

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
    showFilterState: true,
    // Close before revealing: a match may have moved or vanished since the
    // list was drawn (an SSE refresh mid-search is not deferred for this
    // popup — events.ts defers only for the edit panel); jumpTo
    // resolves against live state and handles both.
    onCommit: (m) => {
      closeFind();
      // jumpTo drops an active filter when the target is outside it.
      // Reading `filter` across the call says so without a second lookup, and
      // without this popup having to re-derive what "outside" means.
      const wasFiltered = state.filter !== null;
      const revealed = state.jumpTo(m.kind, m.id);
      if (revealed && wasFiltered && state.filter === null) {
        toast(`Filter cleared to show "${m.title || "(untitled)"}"`);
      }
    },
    onDismiss: closeFind,
  });
  $pop().replaceChildren(listUI.el);
  return listUI;
}

// Goes through the handle rather than straight to classList, so the registry
// is never left holding a popup that is already hidden.
export function closeFind(): void {
  handle?.close();
}

export function openFind(): void {
  if (!state.current) return;
  // Find lists chart content, so it is unavailable in the reconciliation view
  // — where renderTopbar hides its button. The "/" shortcut has no such
  // affordance to hide: without this it would clear #find-pop's `hidden` while
  // the wrap is display:none, leaving the popup already open on the next chart
  // view (a click would have closed it, a keystroke does not).
  if (state.viewMode === "recon") return;
  const ui = shell();
  $pop().classList.remove("hidden");
  // Registering is also what closes everything else — including popovers
  // outside the topbar, which the old topbar-only sweep never reached.
  handle = openPopover({
    root: $pop(),
    opener: document.getElementById("find-menu"),
    onDismiss: () => $pop().classList.add("hidden"),
  });
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
  document.getElementById("find-menu")!.addEventListener("click", () => toggleFind());
}
