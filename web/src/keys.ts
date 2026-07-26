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
import { addItemToSelection, deleteSelection, toggleFlagSelection } from "./panel";
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
  run: () => void;
}

export const bindings: Binding[] = [
  {
    key: "Escape",
    label: "Esc",
    // Allowed in text fields: backing out of history or a selection from
    // inside a panel field (blur + deselect) is exactly what it should do.
    inTextField: true,
    description: "Clear the selection, or leave version history.",
    run: () => {
      if (state.history !== null) {
        void actions.closeHistory();
      } else if (state.clearSelection()) {
        state.notify();
      }
    },
  },
  {
    key: "Delete",
    label: "Del",
    description: "Delete the selected item or milestone.",
    run: () => deleteSelection(),
  },
  {
    key: "n",
    label: "n",
    description: "New item beside the selection.",
    run: () => void addItemToSelection(),
  },
  {
    key: "!",
    label: "!",
    description: "Flag or unflag the selected items.",
    run: () => toggleFlagSelection(),
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
    binding.run();
  });
}
