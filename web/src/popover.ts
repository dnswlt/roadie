// One popover at a time, app-wide. Every dropdown, menu and picker registers
// here on open; opening any of them dismisses whatever was open, wherever it
// lived. This exists because the obvious per-surface implementation does not
// compose: each opener had to swallow its own click (stopPropagation) so its
// own click-away handler would not immediately close it, and that swallowed
// click then blinded every *other* surface's handler — so each new dropdown
// broke dismissal of the ones already there, N pairs at a time.
//
// The fix is the phase. This module's single listener runs in the **capture**
// phase on document, which precedes any listener on a descendant. So on a
// click that opens something: dismiss-the-old runs first, then the opener's
// own handler runs and registers the new popover — which therefore never sees
// the click that opened it. Openers need no stopPropagation, and must not use
// it: swallowing a click here only re-creates the original bug.
//
// Scope is lifecycle only. Positioning (placePopover), content, search
// behaviour, and whether dismissal removes a transient node or just hides a
// persistent one all stay with the feature, which supplies onDismiss.
//
// Deliberately not owned here: Escape. search-list swallows it per instance,
// keys.ts reserves it for finishing panel edits, and the topbar menus ignore
// it — reconciling those three is a separate question, so this module answers
// clicks only.
//
// Dismissal is bound to `click`, not `pointerdown`, which keeps today's
// behaviour exactly: a WBS row drag preventDefaults its pointerdown and so
// produces no click at all, leaving an open popover alone.

// An element, or a way to find it. The lazy form is for surfaces whose DOM is
// rebuilt underneath them while open — the reconciliation view re-renders
// wholesale, so a captured node reference there goes stale and its popover
// would start treating clicks on its own rebuilt body as outside clicks.
export type PopoverAnchor = Element | (() => Element | null);

export interface PopoverSpec {
  // The popover's own element. A click inside it is never a dismissal.
  root: PopoverAnchor;
  // The control that opens it. Also exempt, so the opener's handler decides
  // what a click on it means (typically toggling) without this listener having
  // closed the popover out from under it first.
  opener?: PopoverAnchor | null;
  // Put the surface back in its closed state: remove a transient node, or add
  // `hidden` to a persistent one. Called exactly once per handle, whether
  // dismissal came from a click, from another popover opening, or from the
  // owner calling close().
  //
  // It must touch only this popover's own DOM. Dismissal runs in the capture
  // phase — before the handler of whatever was clicked — so a re-render here
  // detaches that element first, and the click then lands on a node that is no
  // longer in the document. A full view repaint belongs to the code that
  // decided to close, never to onDismiss.
  onDismiss: () => void;
}

export interface PopoverHandle {
  // Idempotent, and identity-checked against the registry: a handle that has
  // already been superseded can never dismiss the popover that replaced it.
  close(): void;
  // Whether this handle is the one currently registered.
  isOpen(): boolean;
}

let current: PopoverHandle | null = null;
let spec: PopoverSpec | null = null;
let wired = false;

// Owners call the returned handle rather than their own teardown function, so
// the registry cannot be left holding a popover that is already gone.
export function openPopover(next: PopoverSpec): PopoverHandle {
  wire();
  current?.close();
  const handle: PopoverHandle = {
    close(): void {
      if (current !== handle) return; // already closed, or superseded
      current = null;
      spec = null;
      next.onDismiss();
    },
    isOpen: () => current === handle,
  };
  current = handle;
  spec = next;
  return handle;
}

// closeAnyPopover dismisses whatever is open, if anything. For callers that
// want a clean slate without holding a handle (a view switch, a re-render that
// is about to replace the DOM a popover lives in).
export function closeAnyPopover(): void {
  current?.close();
}

// dismissesOn reports whether a click on `target` should close the open
// popover: only when it landed outside both the popover and its opener.
// Exported for the lifecycle test, which has no DOM to click.
export function dismissesOn(target: Node | null): boolean {
  if (!spec) return false;
  if (target === null) return true;
  if (resolve(spec.root)?.contains(target)) return false;
  return !resolve(spec.opener)?.contains(target);
}

function resolve(anchor: PopoverAnchor | null | undefined): Element | null {
  if (!anchor) return null;
  return typeof anchor === "function" ? anchor() : anchor;
}

function wire(): void {
  if (wired) return;
  wired = true;
  // Capture: this must run before the opener handler that may register a new
  // popover on the same click. See the header.
  document.addEventListener(
    "click",
    (e) => {
      if (dismissesOn(e.target as Node | null)) current?.close();
    },
    true,
  );
}
