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
function keyList(pairs: [key: string, description: string][]): HTMLElement {
  const dl = document.createElement("dl");
  dl.className = "help-keys";
  for (const [key, description] of pairs) {
    const dt = document.createElement("dt");
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    dt.append(kbd);
    const dd = document.createElement("dd");
    dd.textContent = description;
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
    "Dragging or resizing an item snaps to the grid you pick in the magnet menu (Day, Week, Month, Quarter, or Schedule) and to nearby item edges, milestones, and today. Moving an item aligns its start to the grid, keeping its duration; either edge still clicks onto a nearby item edge, milestone, or today. Resizing snaps the edge you grabbed.";
  body.append(
    section(
      "Snapping",
      p,
      keyList([
        ["Shift", "Snap to the selected grid only — steadier for coarse grids like Quarter or Schedule."],
        ["Alt", "Turn snapping off for free, day-by-day placement."],
      ]),
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
