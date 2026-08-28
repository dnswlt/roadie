// Minimal promise-based wrappers around the native <dialog> element.

import { icons } from "./icons";
import type { ImportMode, Visibility } from "./types";

function dialogEl(): HTMLDialogElement {
  return document.getElementById("dialog") as HTMLDialogElement;
}

// visibilityChips builds the private/public picker used when creating a
// roadmap, and returns a getter for the current choice. It is a pair of chips
// rather than a lone "Private" checkbox because both states then name
// themselves: "Public" has to say that it means everyone, or nobody reads it.
function visibilityChips(): { el: HTMLElement; value: () => Visibility } {
  // Public is the default, here and on the server: an open deployment behaves
  // as it always has, and a team roadmap nobody else can open is rarely what
  // someone means by "new roadmap".
  let value: Visibility = "public";
  const row = document.createElement("div");
  row.className = "prio-chips vis-chips";
  const chips = new Map<Visibility, HTMLButtonElement>();
  const paint = (): void => {
    for (const [v, b] of chips) b.classList.toggle("active", v === value);
  };
  const options: [Visibility, string, SVGSVGElement, string][] = [
    ["public", "Public", icons.globe(13), "Everyone can see and edit it"],
    ["private", "Private", icons.lock(13), "Only you can see it"],
  ];
  for (const [v, label, icon, title] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prio-chip";
    b.title = title;
    b.append(icon, document.createTextNode(label));
    b.addEventListener("click", () => {
      value = v;
      paint();
    });
    chips.set(v, b);
    row.append(b);
  }
  paint();
  return { el: row, value: () => value };
}

// newRoadmapDialog is the create prompt: a name, plus a visibility choice when
// the deployment has accounts. With auth off the choice is not offered at all,
// and not because the UI checks the mode — a private roadmap needs an owner,
// and an anonymous creator cannot be one, so there is genuinely nothing to
// choose. Returns null if cancelled.
export function newRoadmapDialog(
  canChooseVisibility: boolean,
): Promise<{ name: string; visibility: Visibility } | null> {
  const dlg = dialogEl();
  dlg.replaceChildren();
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h3");
  h.textContent = "New roadmap";
  const input = document.createElement("input");
  input.type = "text";
  input.required = true;

  const chips = canChooseVisibility ? visibilityChips() : null;
  form.append(h, input);
  if (chips) {
    const label = document.createElement("label");
    label.className = "dialog-label";
    label.textContent = "Who can see it";
    form.append(label, chips.el);
  }

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "btn btn-primary";
  ok.textContent = "Create";
  row.append(cancel, ok);
  form.append(row);
  dlg.append(form);

  return new Promise((resolve) => {
    let result: { name: string; visibility: Visibility } | null = null;
    form.addEventListener("submit", () => {
      const name = input.value.trim();
      if (name) result = { name, visibility: chips ? chips.value() : "public" };
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
    input.select();
  });
}

// importModeDialog asks what an imported file should become. The question is
// always asked, never inferred from whether the file's identities collide with
// something already here: taking a copy and taking the roadmap the file names
// are different operations, and only the person importing knows which one they
// mean. Returns null if cancelled.
export function importModeDialog(fileName: string): Promise<ImportMode | null> {
  const dlg = dialogEl();
  dlg.replaceChildren();
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h3");
  h.textContent = "Import roadmap";
  const file = document.createElement("p");
  file.textContent = fileName;
  // New identifiers is the default and the common case; reusing the file's is a
  // deliberate act.
  let value: ImportMode = "copy";
  const options: [ImportMode, string, string][] = [
    [
      "copy",
      "New identifiers",
      "Imports as a new roadmap. Assigns new identifiers.",
    ],
    [
      "transfer",
      "Keep identifiers",
      "Reuses the identifiers in the file. Fails if any of them already exists here.",
    ],
  ];
  // Both hints are rendered, stacked in one grid cell, and only the inactive
  // one is hidden: the dialog is then the size of the longest hint whichever
  // chip is active, instead of resizing under the pointer as the choice
  // changes.
  const hint = document.createElement("div");
  hint.className = "dialog-hint";
  const hints = new Map<ImportMode, HTMLParagraphElement>();
  for (const [v, , text] of options) {
    const p = document.createElement("p");
    p.textContent = text;
    hints.set(v, p);
    hint.append(p);
  }
  const row = document.createElement("div");
  row.className = "prio-chips mode-chips";
  const chips = new Map<ImportMode, HTMLButtonElement>();
  const paint = (): void => {
    for (const [v, b] of chips) b.classList.toggle("active", v === value);
    for (const [v, p] of hints)
      p.style.visibility = v === value ? "visible" : "hidden";
  };
  for (const [v, text] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prio-chip";
    b.textContent = text;
    b.addEventListener("click", () => {
      value = v;
      paint();
    });
    chips.set(v, b);
    row.append(b);
  }
  paint();

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "btn btn-primary";
  ok.textContent = "Import";
  actions.append(cancel, ok);
  form.append(h, file, row, hint, actions);
  dlg.append(form);

  return new Promise((resolve) => {
    let result: ImportMode | null = null;
    form.addEventListener("submit", () => {
      result = value;
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
    ok.focus();
  });
}

export function promptDialog(
  title: string,
  initial = "",
  okLabel = "OK",
): Promise<string | null> {
  const dlg = dialogEl();
  dlg.replaceChildren();
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h3");
  h.textContent = title;
  const input = document.createElement("input");
  input.type = "text";
  input.value = initial;
  input.required = true;
  const row = document.createElement("div");
  row.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "btn btn-primary";
  ok.textContent = okLabel;
  row.append(cancel, ok);
  form.append(h, input, row);
  dlg.append(form);

  return new Promise((resolve) => {
    let result: string | null = null;
    form.addEventListener("submit", () => {
      result = input.value.trim() || null;
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
    input.select();
  });
}

// The confirm button's weight, which must match the control that opened the
// dialog: a confirmation quieter than its trigger reads as a different, lesser
// action. "danger" is the red Delete of the common case, "primary" answers a
// solid brand button, "neutral" a plain one.
const CONFIRM_TONE = {
  danger: "btn btn-danger",
  primary: "btn btn-primary",
  neutral: "btn",
} as const;

type ConfirmContent = string | { title: string; message: string };

// confirmDialog asks a yes/no question. Most confirmations need only a short
// sentence; consequential ones may promote their most important fact to a
// heading instead of burying it in the prose.
export function confirmDialog(
  content: ConfirmContent,
  okLabel = "Delete",
  tone: keyof typeof CONFIRM_TONE = "danger",
): Promise<boolean> {
  const dlg = dialogEl();
  dlg.replaceChildren();
  dlg.classList.add("confirm-dialog");
  if (typeof content !== "string") {
    const h = document.createElement("h3");
    h.textContent = content.title;
    dlg.append(h);
  }
  const p = document.createElement("p");
  p.textContent = typeof content === "string" ? content : content.message;
  const row = document.createElement("div");
  row.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = CONFIRM_TONE[tone];
  ok.textContent = okLabel;
  row.append(cancel, ok);
  dlg.append(p, row);

  return new Promise((resolve) => {
    let result = false;
    cancel.addEventListener("click", () => dlg.close());
    ok.addEventListener("click", () => {
      result = true;
      dlg.close();
    });
    dlg.addEventListener(
      "close",
      () => {
        dlg.classList.remove("confirm-dialog");
        resolve(result);
      },
      { once: true },
    );
    dlg.showModal();
  });
}
