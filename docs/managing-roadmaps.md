# Managing roadmaps

## Create a roadmap

1. Select **Home** in the top bar.
2. Select **New**.
3. Enter a name. If Roadie uses sign-in, you can also choose whether the roadmap
   starts public or private.
4. Select **Create**.

The new roadmap opens immediately.

## Open a roadmap

1. Select **Home** to see the available roadmaps.
2. Select a roadmap to see its summary.
3. Select **Open**.

You can also open a roadmap by double-clicking it in the list.

## Rename a roadmap

1. Open the roadmap.
2. Select its name in the top bar to open the roadmap menu.
3. Select **Rename**, enter the new name, and confirm.

## Duplicate a roadmap

Duplicating creates an independent copy of the open roadmap:

1. Select the roadmap name in the top bar.
2. Select **Duplicate**.
3. Name the copy and confirm.

Roadie opens the copy, leaving the original unchanged.

## Export and import

### Export a roadmap

1. Open the roadmap.
2. Select its name in the top bar.
3. Select **Export**.

Roadie downloads a JSON file containing the roadmap and its content.

### Import a roadmap

1. Select **Home**.
2. Select **Import** and choose the exported JSON file.

Importing creates and opens a new public roadmap. In deployments with sign-in,
its owner can make it private afterward.

## Delete or restore a roadmap

### Delete a roadmap

1. Open the roadmap.
2. Select its name in the top bar.
3. Select **Delete roadmap** and confirm.

The roadmap moves to Trash and can no longer be opened from the roadmap list.

### Restore a roadmap

1. Select **Home**.
2. Select the **Trash** tab.
3. Choose the roadmap.
4. Select **Restore**.

Roadie shows how long each roadmap will remain recoverable.

### Delete a roadmap permanently

1. Select **Home**.
2. Select the **Trash** tab.
3. Choose the roadmap.
4. Select **Delete permanently** and confirm.

Permanent deletion cannot be undone.

## History and recovery

Roadie records **version history** as snapshots of roadmap content. You can
preview an earlier version without editing it and restore it when you decide the
roadmap should go back to that state. Automatic snapshots capture recent
editing.

History is “go back,” not step-by-step undo. Restoring a snapshot replaces the
current plan with that version.

### View an earlier version

1. Open the roadmap.
2. Select its name in the top bar.
3. Select **Version history**.
4. Select a version from the history list.

Earlier versions open as read-only previews. Select **Back to current** to leave
the preview without changing the roadmap.

### Restore an earlier version

1. Preview the version you want to restore.
2. Select **Restore this version** and confirm.

Roadie keeps the version you replaced in history, so you can return to it later.

## Sharing and collaboration

In deployments with sign-in enabled, a roadmap can be:

- **Public**: available to everyone who can reach Roadie, and editable by them.
- **Private**: available only to its owner.

Public does not mean read-only; Roadie currently has no read-only sharing mode.

### Change a roadmap's visibility

1. Open a roadmap you own.
2. Select its name in the top bar.
3. Select **Make private** or **Make public** and confirm.

The visibility action appears only for the roadmap's owner in deployments with
sign-in enabled.

When several people have the same roadmap open, Roadie refreshes it as changes
arrive. It also records the people who have contributed to a roadmap, without
turning version history into a detailed audit log.
