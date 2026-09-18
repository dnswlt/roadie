# Undo

## Goals

* Undo the edits users experience as accidents and cannot repair by hand: a
  retyped title, a dragged bar, a changed date range.
* Add no endpoint, no wire format and no server concept. Undo is a second call
  to the mutation path that already exists.
* Never let an undo apply to a roadmap it no longer describes. Where that
  cannot be guaranteed, drop the history rather than guess.
* Leave version history what it is: "go back", not step-by-step undo.

## The Claim

Every undo-worthy mutation in Roadie is a partial PATCH on entities that keep
their database IDs. Its inverse is another PATCH of the same shape. So undo is
not a subsystem: it is `actions` applying the inverse of what it just applied,
through `optimistic()` like any other edit — same rollback, same toast, and
server-side the same `s.snap` wrapper, so an undo takes its own snapshot,
broadcasts its own SSE doorbell, and is attributed to whoever pressed it.

The backend changes not at all.

## The Unit: an Edit

One user gesture is one `Edit`, a batch of patches:

```ts
interface Edit {
  items?: { id: number; patch: ItemPatch }[];
  milestones?: { id: number; patch: MilestonePatch }[];
  lanes?: { id: number; patch: LanePatch }[];
  laneOrder?: number[];
}
```

Every gesture in scope already fits: a title edit is one item patch; a bar drag
is one structural patch; dragging a parent is that plus one date patch per
child; a group drag is N date patches; a lane reorder is `laneOrder`.

One batch = one undo step. The existing multi-call actions
(`moveItemWithChildren`, `shiftItems`, `updateItemMetadata`) already batch
exactly this way, so the grouping is not a new judgement call.

## The Inverse Is Read, Not Captured

`inverseOf(edit, roadmap)` walks the batch and, for each entry, reads the
entity's current values for exactly the fields the patch sets. No call site
captures a "before" value, so no call site can capture a stale one.

The one special case: **a patch touching any of `parentId`, `laneId` or `rank`
inverts to all three**, plus the item's current index in its container. A move
is one atom. `store.UpdateItem` splices by remove-then-insert and keeps ranks
dense, so restoring those three restores the exact original order, siblings
included — including a move within one container, and including the children
that follow a parent across lanes.

`inverseOf` is a pure function over `RoadmapFull`. It goes in `undo.ts`,
DOM-free and unit-tested next to its source, the way `snap.ts` and `diff.ts`
are. That is where the position algebra gets pinned, not by hand-dragging.

## One Choke Point

`actions.applyEdit(edit, { push = true })` computes the inverse, then does what
today's actions do: optimistic local apply, `Promise.all` of the API calls,
rollback on failure. On success — and only on success — it pushes the inverse.

`updateItem`, `moveItemWithChildren`, `shiftItems`, `updateItemMetadata`,
`updateMilestone`, `renameLane`, `setLaneColor` and `reorderLanes` become thin
builders over it. Call sites in `panel.ts`, `dnd.ts`, `wbs-dnd.ts` and `app.ts`
do not change.

Undo itself calls `applyEdit(inverse, { push: false })` and moves a cursor.

## The Stack Invariant

> Every entry on the stack refers to entities that still exist and that nobody
> else has touched.

Held by clearing, never by checking:

* **`state.current` is replaced wholesale ⇒ clear.** One hook in the existing
  `set current` accessor, which already invalidates everything derived from the
  model's identity. That covers the SSE refresh, switching roadmaps, entering
  and leaving a snapshot preview, a restore, and a failed mutation's rollback.
* **A mutation that is not a patch ⇒ clear** (`undo.clear()`): every create,
  every delete, schedule replace, dependency add/remove, import.

So undo needs no "does this still exist" guard: with those two rules the case
cannot arise. Dropping the stack on a remote edit is deliberate — undo does not
have to work under concurrent editing, and reasoning about a stack that has to
is where undo implementations go wrong.

## Redo

An Edit's inverse is an Edit, so the stack is a list plus a cursor: undo steps
back and applies the inverse, redo steps forward and applies the original. A
new edit truncates the redo tail. Roughly fifteen lines on top of undo, and
users who press Cmd+Z reflexively need the way back.

## The Keystroke

`keys.ts` returns early on every modifier today, on the rule that chords belong
to the browser and the OS. Cmd+Z is the exception that proves it: the rule is
against *inventing* chords, and this one is already in everyone's fingers.

Add an optional `mod: "primary"` to `Binding` (Cmd on macOS, Ctrl elsewhere)
and let those through. Undo keeps `inTextField: false`, so while the caret sits
in the title field Cmd+Z stays the browser's own text undo — which is what the
user means there, and is free.

Help renders the bindings table, so undo documents itself.

Keyboard only, to start. The topbar is full, and undo is not a control anyone
hunts for with the mouse.

## Undo Must Show Its Work

An undo the user cannot see reads as a broken shortcut. After applying, the
touched entity is revealed and selected through `state.jumpTo` — which already
unhides its context, unfolds its parent and clears a filter that would hide it
— and a toast names what happened ("Undid move of \"Alpha\"").

Labels are derived from the batch shape, not passed in: structural fields ⇒
"move", dates only ⇒ "date change", title ⇒ "title change".

## Bounds

In memory, capped around 50 entries, never persisted. After a reload there is
no way to know what changed in between, and an undo that jumps a page boundary
is exactly the one that applies to a roadmap it no longer describes.

## Out of Scope

**Deletes.** Confirmed already, and re-creating an item issues a new database
ID: its dependency edges, its children's parentage and any link to it would not
come back. That is a restore, and version history does it.

**Creates, schedule, dependencies, import.** Same reason or smaller: nothing
here is a field change on a surviving entity.

Both clear the stack, and the reason for the clear is worth remembering so a
Cmd+Z that finds nothing can say "Deleting can't be undone — use version
history" rather than doing nothing at all.
