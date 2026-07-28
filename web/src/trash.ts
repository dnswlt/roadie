// The trash: deleted roadmaps, and the two things you can do with them.
//
// Deleting a roadmap marks it rather than removing it (see
// migrations/011_roadmap_deleted.sql), so this dialog is the other half of that
// feature — without somewhere to see and restore them, a soft delete is just an
// invisible one. It owns its own DOM like info.ts and history.ts, and fetches on
// open: the trash is usually empty and never on the critical path of loading a
// roadmap.

import { actions } from "./actions";
import { api } from "./api";
import { confirmDialog } from "./dialogs";
import { toast } from "./toast";
import type { TrashedRoadmap } from "./types";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// countdown says how long a roadmap has left. Days, because that is the unit
// the retention policy is written in and a shrinking hour count is nothing
// anyone can act on faster.
function countdown(purgeAt: string): string {
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / DAY_MS);
  if (days <= 0) return "due to be deleted";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// entryRow is one trashed roadmap: what it is, when it went, and its two exits.
function entryRow(rm: TrashedRoadmap, reopen: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "trash-row";

  const text = document.createElement("div");
  text.className = "trash-text";
  const name = document.createElement("div");
  name.className = "trash-name";
  name.textContent = rm.name;
  const meta = document.createElement("div");
  meta.className = "trash-meta";
  meta.textContent = `Deleted ${stamp(rm.deletedAt)} · ${countdown(rm.purgeAt)}`;
  text.append(name, meta);

  const buttons = document.createElement("div");
  buttons.className = "trash-actions";

  const restore = document.createElement("button");
  restore.className = "btn";
  restore.textContent = "Restore";
  restore.addEventListener("click", () => {
    void (async () => {
      try {
        // Closing first: restoring opens the roadmap, and a modal left standing
        // in front of it would hide the result of the click.
        dialogEl().close();
        await actions.restoreRoadmap(rm.id);
      } catch (e) {
        toast(errMsg(e), true);
        reopen(); // put the trash back, entry and all, so it can be retried
      }
    })();
  });

  const purge = document.createElement("button");
  purge.className = "btn btn-danger";
  purge.textContent = "Delete permanently";
  purge.addEventListener("click", () => {
    void (async () => {
      // The confirm reuses the shared #dialog, so this one has to step aside
      // and come back — it is rebuilt from a fresh fetch anyway.
      dialogEl().close();
      const ok = await confirmDialog(
        `Permanently delete "${rm.name}"? This cannot be undone.`,
        "Delete permanently",
      );
      if (ok) {
        try {
          await api.purgeRoadmap(rm.id);
          toast(`Permanently deleted "${rm.name}"`);
        } catch (e) {
          toast(errMsg(e), true);
        }
      }
      reopen();
    })();
  });

  buttons.append(restore, purge);
  row.append(text, buttons);
  return row;
}

function dialogEl(): HTMLDialogElement {
  return document.getElementById("dialog") as HTMLDialogElement;
}

// openTrash shows the deleted roadmaps. Re-entrant: every action that has to
// leave the dialog (a confirm, a failed restore) simply calls it again, which
// re-fetches, so the list can never show an entry that is no longer there.
export async function openTrash(): Promise<void> {
  let entries: TrashedRoadmap[] = [];
  try {
    entries = await api.listTrash();
  } catch (e) {
    toast(errMsg(e), true);
    return; // nothing worth showing: an empty trash and a failed fetch look alike
  }

  const dlg = dialogEl();
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Trash";
  dlg.append(h);

  // No explanatory blurb: each row already says when it was deleted and how
  // long it has left, which is the whole of what there is to explain.
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trash-empty";
    empty.textContent = "The trash is empty.";
    dlg.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "trash-list";
    for (const rm of entries) list.append(entryRow(rm, () => void openTrash()));
    dlg.append(list);
  }

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const close = document.createElement("button");
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  row.append(close);
  dlg.append(row);

  dlg.showModal();
}
