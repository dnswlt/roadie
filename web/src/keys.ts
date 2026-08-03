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

export interface Binding {
  // Matched against KeyboardEvent.key, so it is the character produced by the
  // user's layout — "!" works whether or not that layout needs Shift for it.
  // Case-sensitive by design: matching "n" loosely would eat Shift+N too and
  // foreclose ever binding the pair separately. The cost is that Caps Lock
  // suppresses letter shortcuts, which is the cheaper of the two problems.
  key: string;
  // How the key is drawn in Help (kbd label), which is not always `key`.
  label: string;
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
    // Allowed in text fields: backing out of history or a selection from
    // inside a panel field is exactly what it should do. The flush commits
    // what was typed first — this is an everything-saves app, so Esc means
    // "done here", never "discard".
    //
    // The rule that makes this consistent: a local editor with its own Escape
    // meaning consumes the event before it reaches here (the find popup, an
    // inline lane rename, a drag in progress), because there Esc means "cancel
    // this", not "back out of everything". The edit panel's fields are the
    // deliberate exception — they let it through, which is what lets Esc from a
    // panel field clear the selection.
    //
    // Enter is the shallower exit, handled on the field itself (see
    // titleField): it leaves the field but keeps the item selected, so "n" and
    // "c" still have a target. Esc leaves the item.
    inTextField: true,
    description: "Clear the selection, or leave version history.",
    run: () => {
      if (state.history !== null) {
        void actions.closeHistory();
      } else {
        flushPendingEdit();
        if (state.clearSelection()) state.notifySelection();
      }
    },
  },
  {
    key: "Delete",
    label: "Del",
    description: "Delete the selected items or milestone.",
    run: () => deleteSelection(),
  },
  {
    key: "n",
    label: "n",
    description: "New item beside the selection.",
    run: () => void addItemToSelection(),
  },
  {
    key: "c",
    label: "c",
    description: "New child item under the selection.",
    run: () => void addChildToSelection(),
  },
  {
    key: "e",
    label: "e",
    description: "Edit the selected item or milestone's title.",
    // Moves focus into the Title field, so the "e" must not also be typed
    // into it — same reason as "/".
    preventDefault: true,
    run: () => editSelection(),
  },
  {
    key: "!",
    label: "!",
    description: "Flag or unflag the selected items.",
    run: () => toggleFlagSelection(),
  },
  {
    key: "/",
    label: "/",
    description: "Find items, milestones and contexts.",
    // Opens the find popup and focuses its input, so the "/" must not also be
    // typed into it.
    preventDefault: true,
    run: () => openFind(),
  },
  {
    key: "p",
    label: "p",
    description: "Collapse or expand the edit panel.",
    run: () => togglePanel(),
  },
  {
    key: "v",
    label: "v",
    description: "Switch between timeline and WBS view.",
    run: () => state.setViewMode(state.viewMode === "wbs" ? "timeline" : "wbs"),
  },
  {
    key: "?",
    label: "?",
    // Last, so the reference card ends with the way back to itself. Reopening
    // is not a concern: the handler ignores every shortcut while a dialog is
    // open, and Escape closes it natively.
    description: "Show this help.",
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
