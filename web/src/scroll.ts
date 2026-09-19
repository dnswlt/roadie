// Bringing a selection into view inside a scroller whose edges are covered by
// pinned furniture: the timeline pins its time axis and the active-item
// profile over its top, and both views pin the Contexts rail over their left.
// scrollIntoView knows nothing about any of it and parks an element exactly
// where the furniture hides it, so the arithmetic is done here instead — over
// the band that is actually readable, which is the scroller's viewport minus
// those insets.
//
// Everything but the applier at the bottom is DOM-free, so the arithmetic is
// pinned by scroll.test.ts.

// How far the viewport may travel to show something. "center" is for arriving
// from elsewhere (a deep link, find, a view switch), where the surroundings
// are unknown and the target should land in the middle of both axes.
// "nearest" is for a row that moved a step under the reader: it only has to
// stay readable, and it moves the vertical axis alone — a rank change leaves
// the row's dates exactly where they were, so panning the timeline off the
// range the reader is studying would be answering a question nobody asked.
export type ScrollMode = "center" | "nearest";

// One axis of a scroller: where it sits, how much of it the viewport shows,
// and how much of that the pinned furniture covers at the leading edge.
export interface Axis {
  scroll: number;
  client: number;
  inset: number;
}

// scrollOffset answers where the axis should sit so that [start, start + size]
// — in content coordinates — is readable. "nearest" returns the current offset
// unchanged when it already is.
export function scrollOffset(mode: ScrollMode, start: number, size: number, axis: Axis): number {
  const readable = axis.client - axis.inset;
  if (mode === "center") return start + size / 2 - axis.inset - readable / 2;
  const first = axis.scroll + axis.inset;
  const last = axis.scroll + axis.client;
  // Something stretching across the whole readable band is already as visible
  // as it can be made. Chasing its leading edge from here would move the band
  // without putting anything new in it.
  if (start <= first && start + size >= last) return axis.scroll;
  if (start < first) return start - axis.inset;
  if (start + size > last) {
    // Something longer than the readable band is shown from its leading edge:
    // scrolling to its far edge would hide the part being acted on.
    return Math.min(start - axis.inset, start + size - axis.client);
  }
  return axis.scroll;
}

export interface Inset {
  top: number;
  left: number;
}

// scrollIntoViewport applies scrollOffset on both axes. Everything is measured
// before either is written: assigning one axis does not disturb the other, but
// reading a rect back in between would mix pre- and post-scroll coordinates.
export function scrollIntoViewport(
  container: HTMLElement,
  el: HTMLElement,
  mode: ScrollMode,
  inset: Inset,
): void {
  const cr = container.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const { scrollTop, scrollLeft, clientHeight, clientWidth } = container;
  container.scrollTop = scrollOffset(mode, er.top - cr.top + scrollTop, er.height, {
    scroll: scrollTop,
    client: clientHeight,
    inset: inset.top,
  });
  if (mode === "nearest") return; // vertical only; see ScrollMode
  container.scrollLeft = scrollOffset(mode, er.left - cr.left + scrollLeft, er.width, {
    scroll: scrollLeft,
    client: clientWidth,
    inset: inset.left,
  });
}
