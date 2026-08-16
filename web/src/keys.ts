// Global keyboard shortcuts: one window listener over one table.
//
// Every binding declares its key, how it reads in Help, and whether it may
// fire while a text field has focus. Two consequences worth keeping:
//
//   - The Help dialog renders this same table (see app.ts), so a shortcut is
//     documented by construction rather than by remembering to document it.
//   - The guards live here once. A bare-character shortcut is only safe
//     because *nothing* competes for the keystroke, and that argument has to
//     hold for every binding, not per handler.
//
// Shortcuts stay single-key on purpose: no chords to look up, and Ctrl/Cmd/Alt
// combos are left to the browser and the OS.

import { actions } from "./actions";
import { openDepsForSelection } from "./deps";
import { openFind } from "./find";
import { openHelpDialog } from "./help";
import {
  addChildToSelection,
  addItemToSelection,
  deleteSelection,
  editSelection,
  flushPendingEdit,
  toggleFlagSelection,
  togglePanel,
} from "./panel";
import { state } from "./state";
import { zoomToFit } from "./zoom";

export interface Binding {
  // Matched against KeyboardEvent.key, so it is the character produced by the
  // user's layout — "!" works whether or not that layout needs Shift for it.
  // Case-sensitive by design: matching "n" loosely would eat Shift+N too and
  // foreclose ever binding the pair separately. The cost is that Caps Lock
  // suppresses letter shortcuts, which is the cheaper of the two problems.
  key: string;
  // How the key is drawn in Help (kbd label), which is not always `key`.
  label: string;
  // Shown in Help; a *starred* phrase renders bold there, a `backticked` key
  // as a <kbd> chip (see help.ts keyList).
  description: string;
  // Opt in to firing while an input/textarea has focus. Off for anything
  // whose key could be a character the user meant to type.
  inTextField?: boolean;
  // Suppress the key's own default. Needed when `run` moves focus *into* a
  // text field: the keystroke that opened it would otherwise be typed into it
  // as its first character. Declared here rather than fixed inside the handler
  // so the reason travels with the binding that has the problem.
  preventDefault?: boolean;
  run: () => void;
}

export const bindings: Binding[] = [
  {
    key: "Escape",
    label: "Esc",
    // Allowed in text fields: Esc finishes a panel edit by blurring the field,
    // which fires its change handler and saves. It deliberately keeps the
    // selection; clearing an ordinary persistent selection is not a dismissal.
    //
    // The rule that makes this consistent: a local editor with its own Escape
    // meaning consumes the event before it reaches here (the find popup, an
    // inline lane rename, a drag in progress), because there Esc means "cancel
    // this". The edit panel's fields are the deliberate exception — they let
    // it through so the global binding can finish and save the edit.
    //
    // Enter on the title is handled on the field itself (see titleField); it
    // has the same finish-and-retain-selection result.
    inTextField: true,
    description: "*Finish editing*, or leave version history.",
    run: () => {
      if (state.history !== null) {
        void actions.closeHistory();
      } else {
        flushPendingEdit();
      }
    },
  },
  {
    key: "Delete",
    label: "Del",
    description: "*Delete* the selected items or milestone.",
    run: () => deleteSelection(),
  },
  {
    key: "n",
    label: "n",
    description: "*Add an item* after the selected item, or to the selected milestone's context.",
    run: () => void addItemToSelection(),
  },
  {
    key: "c",
    label: "c",
    description: "*Add a child item* to the selected parent.",
    run: () => void addChildToSelection(),
  },
  {
    key: "e",
    label: "e",
    description: "*Edit* the selected item or milestone's title.",
    // Moves focus into the Title field, so the "e" must not also be typed
    // into it — same reason as "/".
    preventDefault: true,
    run: () => editSelection(),
  },
  {
    key: "!",
    label: "!",
    description: "*Flag or unflag* the selected items.",
    run: () => toggleFlagSelection(),
  },
  {
    key: "d",
    label: "d",
    description: "*Open the dependency graph* for the selected item or milestone.",
    run: () => openDepsForSelection(),
  },
  {
    key: "/",
    label: "/",
    description: "*Find* items, milestones, and contexts.",
    // Opens the find popup and focuses its input, so the "/" must not also be
    // typed into it.
    preventDefault: true,
    run: () => openFind(),
  },
  {
    key: "p",
    label: "p",
    description: "*Collapse or expand* the edit panel.",
    run: () => togglePanel(),
  },
  {
    key: "v",
    label: "v",
    // From Jira Recon, "v" returns to the chart view last shown — Recon is
    // never a stop in the cycle (it has its own topbar button).
    description: "*Switch between* the timeline and WBS views.",
    run: () => state.toggleChartView(),
  },
  {
    key: "r",
    label: "r",
    // Does nothing when Recon is unavailable (no tracker configured, or no
    // roadmap open) — the topbar button is hidden or disabled there, and a
    // shortcut has no way to show that.
    description: "*Switch to Jira Recon*, and back to the view you came from.",
    run: () => state.toggleReconView(),
  },
  {
    key: "z",
    label: "z",
    description: "*Fit all items* in the visible contexts on screen (timeline view).",
    run: () => zoomToFit(),
  },
  {
    key: "?",
    label: "?",
    // Last, so the reference card ends with the way back to itself. Reopening
    // is not a concern: the handler ignores every shortcut while a dialog is
    // open, and Escape closes it natively.
    description: "*Open Help*.",
    run: () => openHelpDialog(bindings),
  },
];

// isTextField reports whether the event target owns the characters typed into
// it, in which case a bare-key shortcut is not ours to take.
function isTextField(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
}

export function initKeys(): void {
  window.addEventListener("keydown", (e) => {
    // Leave browser/OS combos alone. Shift is not excluded: e.key already
    // reports the shifted character, so requiring Shift for "!" is invisible
    // here and rejecting it would break layouts that need it.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const binding = bindings.find((b) => b.key === e.key);
    if (!binding) return;
    // An open modal owns the keyboard: its own buttons take focus, so a target
    // check alone would let a shortcut fire on the chart behind the dialog.
    // Escape needs no exception — <dialog> closes itself on Escape.
    if (document.querySelector("dialog[open]")) return;
    if (!binding.inTextField && isTextField(e.target)) return;
    if (binding.preventDefault) e.preventDefault();
    binding.run();
  });
}
