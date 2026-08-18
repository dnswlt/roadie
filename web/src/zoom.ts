// Timeline zoom: the pxPerDay scale, its clamp, and its persistence. Every
// path that changes the zoom comes through here — the toolbar buttons,
// Ctrl+scroll, the "z" shortcut, and the restore at boot — so the
// clamp-and-persist pair has one home instead of one per caller.

import { LABEL_W } from "./layout";
import { currentScale } from "./render";
import { state } from "./state";
import { contentRange, MAX_PX_PER_DAY, MIN_PX_PER_DAY, xOf } from "./timescale";

const ZOOM_KEY = "roadie.zoom";

// Breathing room left on either side of the framed span, so the first and last
// bars don't sit flush against the viewport edges.
const FIT_GUTTER_PX = 32;

function chartEl(): HTMLElement | null {
  return document.getElementById("chart");
}

function clamp(pxPerDay: number): number {
  return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, pxPerDay));
}

// restoreZoom applies the persisted level at boot. Anything unusable (absent,
// non-numeric, zero) leaves state's default alone, and the clamp covers an
// entry written when the bounds were different.
export function restoreZoom(): void {
  const stored = Number(localStorage.getItem(ZOOM_KEY));
  if (stored) state.pxPerDay = clamp(stored);
}

// setZoom keeps the date under the viewport center fixed while zooming.
export function setZoom(pxPerDay: number): void {
  const chart = chartEl();
  if (!chart) return;
  const px = clamp(pxPerDay);
  if (px === state.pxPerDay) return;
  const ratio = px / state.pxPerDay;
  const centerX = chart.scrollLeft + chart.clientWidth / 2 - LABEL_W;
  state.pxPerDay = px;
  localStorage.setItem(ZOOM_KEY, String(px));
  state.notify();
  chart.scrollLeft = Math.max(0, centerX * ratio - chart.clientWidth / 2 + LABEL_W);
}

// zoomToFit frames the items and milestones of the *visible* lanes: it picks
// the largest pxPerDay at which their span fits the viewport, then scrolls to
// the span's start. It deliberately ignores today (unlike the chart's own
// range, which pads out to include it), so a roadmap that lives entirely in
// the future is framed on the work rather than on empty months. MIN_PX_PER_DAY
// still clamps, so a very long roadmap fits as much as it can and no more.
// WBS has no time axis, so its toolbar hides zoom and the shortcut that
// reaches this in that view is deliberately a no-op.
export function zoomToFit(): void {
  if (state.viewMode !== "timeline") return;
  const chart = chartEl();
  if (!chart) return;
  // Fit what is drawn, not what exists: an active filter narrows the span the
  // same way a hidden context does.
  const range = contentRange(state.projection().lanes);
  if (!range) return;
  const days = range.endDay - range.startDay + 1; // end dates are inclusive
  const avail = chart.clientWidth - LABEL_W - FIT_GUTTER_PX;
  if (avail <= 0) return;
  state.pxPerDay = clamp(avail / days);
  localStorage.setItem(ZOOM_KEY, String(state.pxPerDay));
  // Not setZoom: fitting must re-scroll even when the zoom level is unchanged,
  // so a second invocation still recentres after panning away.
  state.notify();
  // Scroll so the span's start lands just right of the lane labels. They are
  // sticky at left: 0 and so overlay the first LABEL_W pixels of the viewport;
  // scrolling to the span's own x would tuck its first bars underneath them.
  chart.scrollLeft = Math.max(0, xOf(currentScale(), range.startDay) - FIT_GUTTER_PX / 2);
}
