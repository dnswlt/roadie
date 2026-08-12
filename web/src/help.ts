// The Help modal: a small reference card for the parts of the UI that the
// chrome cannot explain by itself. Start with snapping (the most modal, least
// discoverable gesture); add sections here as needed. Escape / Close dismiss it
// (native <dialog>).
//
// The binding table is passed in rather than imported. keys.ts opens this dialog
// from the "?" shortcut, so importing `bindings` back from keys.ts would make the
// two modules circular; only the type crosses that way, and types are erased.

import type { Binding } from "./keys";

// keyList renders a <dl> of key/description pairs, the shape both sections use.
// Descriptions carry light inline markup: a *starred* phrase renders bold, so
// the eye can pick out the action while scanning the list, and a `backticked`
// key renders as a <kbd> chip, so keys named mid-sentence look like the keys in
// the left column. The convention keeps the binding table (keys.ts) plain
// strings.
function keyList(pairs: [key: string, description: string][]): HTMLElement {
  const dl = document.createElement("dl");
  dl.className = "help-keys";
  for (const [key, description] of pairs) {
    const dt = document.createElement("dt");
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    dt.append(kbd);
    const dd = document.createElement("dd");
    for (const part of description.split(/(\*[^*]+\*|`[^`]+`)/)) {
      if (part.startsWith("*") && part.endsWith("*")) {
        const b = document.createElement("b");
        b.textContent = part.slice(1, -1);
        dd.append(b);
      } else if (part.startsWith("`") && part.endsWith("`")) {
        const k = document.createElement("kbd");
        k.textContent = part.slice(1, -1);
        dd.append(k);
      } else if (part) {
        dd.append(part);
      }
    }
    dl.append(dt, dd);
  }
  return dl;
}

function section(heading: string, ...content: HTMLElement[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "help-section";
  const h = document.createElement("h4");
  h.textContent = heading;
  div.append(h, ...content);
  return div;
}

export function openHelpDialog(bindings: Binding[]): void {
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Help";

  const body = document.createElement("div");
  body.className = "help-body";

  const p = document.createElement("p");
  p.textContent =
    "While you drag, items snap to the grid selected in the magnet menu (Day, Week, Month, Quarter, or Schedule) and to nearby item edges, milestones, and today. Moving keeps an item's duration: its start aligns to the grid, and either edge can still catch a nearby target. Resizing snaps the edge you grabbed.";
  body.append(
    section(
      "Snapping",
      p,
      keyList([
        ["Shift", "*Snap to the grid only* — steadier for coarse grids like Quarter or Schedule."],
        ["Alt", "*Turn snapping off* for free, day-by-day placement."],
      ]),
    ),
  );

  // Enter is not in the binding table — it is handled on the title field itself
  // (panel.ts) — so unlike the shortcuts below it has to be listed by hand. It
  // earns that: the run-of-items rhythm it enables is the least guessable thing
  // in the app. Esc belongs to this pair too, but it is a real binding and the
  // Shortcuts section already prints it; describing it again here would be a
  // second wording free to drift from the first. Same for "p", the chevron's
  // keyboard twin — the prose covers only the mouse side.
  const editP = document.createElement("p");
  editP.textContent =
    "Double-click a bar or milestone to open the side panel with its title ready to edit. The chevron strip along the panel's outer edge collapses and reopens it. A description's http(s) URLs become link chips; write [text](url) to name one.";
  body.append(
    section(
      "Editing",
      editP,
      keyList([
        ["Enter", "In a title, *save and step out* of the field — so `n` and `c` start the next item."],
      ]),
    ),
  );

  // The menus themselves stay bare, so this line is where Alt-click is written
  // down. It covers both of them: the gesture is the same in each.
  body.append(
    section(
      "Contexts and labels",
      keyList([["Alt-click", "In the context or label menu, *show only that one*."]]),
    ),
  );

  // Shortcuts are listed straight from the binding table (keys.ts), so adding
  // one there documents it here.
  body.append(
    section(
      "Shortcuts",
      keyList(bindings.map((b) => [b.label, b.description])),
    ),
  );

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  row.append(close);

  dlg.append(h, body, row);
  dlg.showModal();
}
