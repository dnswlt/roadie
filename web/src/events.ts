// Live updates: subscribe to a roadmap's Server-Sent Events stream so an edit
// by another user prompts this tab to refetch. The event itself carries no
// data — it's a doorbell (see internal/server/events.go); on receiving one we
// pull the whole roadmap via actions.refreshFromServer.
//
// The delicate part is *when* to apply that refresh. A refresh replaces
// state.current and triggers a full re-render, which would yank the chart out
// from under a drag or blow away the edit field under the user's cursor. So we
// gate it: apply immediately when it's safe, otherwise defer behind a visible
// "Updated elsewhere · Refresh" pill and flush once the user finishes.

import { actions } from "./actions";
import { clientId } from "./api";
import { isDragging } from "./dnd";
import { state } from "./state";

// REFRESH_DEBOUNCE_MS coalesces a burst of events (a parent moved with its
// children, a multi-select shift arriving as several pings) into one refetch.
const REFRESH_DEBOUNCE_MS = 250;

let source: EventSource | null = null;
let sourceRoadmapId: number | null = null;
let panelEl: HTMLElement | null = null;
let refreshTimer: number | undefined;

// initEvents records the edit-panel element (for the safe-gate) and wires the
// listeners that flush a deferred refresh once the user stops editing.
export function initEvents(panel: HTMLElement): void {
  panelEl = panel;
  // focusout fires as the caret leaves a field; pointerup ends a drag. Re-check
  // on the next tick, after focus/drag state has settled.
  document.addEventListener("focusout", () => setTimeout(maybeFlush, 0));
  window.addEventListener("pointerup", () => setTimeout(maybeFlush, 0));
}

// connectEvents (re)subscribes to one roadmap's change stream, closing any
// previous connection. The browser's EventSource reconnects on its own, so we
// only manage which roadmap we're listening to.
export function connectEvents(roadmapId: number): void {
  if (source && sourceRoadmapId === roadmapId) return;
  source?.close();
  sourceRoadmapId = roadmapId;
  source = new EventSource(`/api/roadmaps/${roadmapId}/events`);
  // On a *reconnect* (not the first open) refetch once: a change may have
  // landed while we were disconnected, and no event for it is coming.
  let opened = false;
  source.onopen = () => {
    if (opened) requestRefresh();
    opened = true;
  };
  source.onmessage = (e) => {
    let ev: { origin?: string };
    try {
      ev = JSON.parse(e.data) as { origin?: string };
    } catch {
      return;
    }
    // Ignore the echo of our own edits: our optimistic apply already reflects
    // them, and refetching would fight the user's in-flight typing.
    if (ev.origin === clientId) return;
    requestRefresh();
  };
}

// isEditing reports whether applying a refresh right now would disrupt the user:
// a snapshot preview (read-only), a live drag, or a focused edit-panel field.
function isEditing(): boolean {
  if (state.preview) return true;
  if (isDragging()) return true;
  return !!panelEl && panelEl.contains(document.activeElement);
}

// requestRefresh applies the refresh when it's safe, otherwise raises the stale
// pill and waits for the user to finish (maybeFlush) or click it (refreshNow).
function requestRefresh(): void {
  if (isEditing()) {
    if (!state.stale) {
      state.stale = true;
      state.notify();
    }
    return;
  }
  scheduleRefresh();
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    void actions.refreshFromServer().catch(() => {
      // Leave stale set; the next event (or the pill) retries.
    });
  }, REFRESH_DEBOUNCE_MS);
}

// maybeFlush applies a deferred refresh once editing has stopped.
function maybeFlush(): void {
  if (state.stale && !isEditing()) scheduleRefresh();
}

// refreshNow applies the pending refresh immediately, e.g. when the user clicks
// the pill. Deliberately ignores the safe-gate: an explicit click means "do it
// now", even mid-edit.
export function refreshNow(): void {
  clearTimeout(refreshTimer);
  void actions.refreshFromServer().catch(() => {});
}
