// Minimal promise-based wrappers around the native <dialog> element.

function dialogEl(): HTMLDialogElement {
  return document.getElementById("dialog") as HTMLDialogElement;
}

export function promptDialog(title: string, initial = "", okLabel = "OK"): Promise<string | null> {
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

// confirmDialog asks a yes/no question. The confirm button is a red "Delete"
// by default (the common case); pass danger = false for a non-destructive
// confirmation (e.g. restore), which uses the neutral button style instead.
export function confirmDialog(message: string, okLabel = "Delete", danger = true): Promise<boolean> {
  const dlg = dialogEl();
  dlg.replaceChildren();
  const p = document.createElement("p");
  p.textContent = message;
  const row = document.createElement("div");
  row.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = danger ? "btn btn-danger" : "btn";
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
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
  });
}
