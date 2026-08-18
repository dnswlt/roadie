export function toast(message: string, isError = false): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  // A repeatable gesture can raise the same message several times in a row (a
  // move refused by the item filter, dnd.ts). Stacking identical copies reads
  // as a malfunction, so the one already on screen stands for all of them.
  for (const live of host.children) {
    if (live.textContent === message && !live.classList.contains("toast-out")) return;
  }
  const el = document.createElement("div");
  el.className = isError ? "toast toast-error" : "toast";
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}
