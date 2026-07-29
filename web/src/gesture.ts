// Pointer-gesture recognizers, DOM-free so they can be unit-tested.

// DoubleClickDetector recognizes two quick plain clicks on the same target.
// It exists because bars cannot receive a native dblclick: dnd.ts
// preventDefaults their pointerdown (drags must not start text selections),
// which suppresses the browser's compatibility click/dblclick events. The
// semantics mirror the native gesture: same target, within a time budget,
// and without the pointer wandering — two clicks at opposite ends of a wide
// bar are two selections, not a rename.
//
// Feed every completed plain click to click(); call reset() whenever an
// intervening gesture breaks the pair (a drag, a Shift-click, a pointerdown
// on anything other than a bar).
export interface Click {
  id: number; // model id of the clicked target
  x: number;
  y: number;
  at: number; // ms timestamp (e.timeStamp)
}

const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;

export class DoubleClickDetector {
  private last: Click | null = null;

  // click reports whether `c` completes a double click, and records it as the
  // candidate first click otherwise. A completed double consumes both clicks,
  // so a triple click yields one double plus a fresh candidate — the native
  // cadence.
  click(c: Click): boolean {
    const p = this.last;
    if (
      p !== null &&
      p.id === c.id &&
      c.at - p.at <= DOUBLE_CLICK_MS &&
      Math.hypot(c.x - p.x, c.y - p.y) <= DOUBLE_CLICK_PX
    ) {
      this.last = null;
      return true;
    }
    this.last = c;
    return false;
  }

  reset(): void {
    this.last = null;
  }
}
