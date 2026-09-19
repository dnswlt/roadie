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

Undo-worthy field edits are partial PATCHes on entities that keep their database
IDs; lane order uses its existing PUT. Each inverse uses the same mutation path
as the forward edit. So undo is not a separate server subsystem: it is `actions`
applying another edit, with the same toast and `s.snap` wrapper. An undo takes
its own snapshot, broadcasts its own SSE doorbell, and is attributed to whoever
pressed it.

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

Record item, milestone and lane edits by what they change, wherever the user
makes them. That includes an item description changed by Jira linking and a
milestone's integration status. Saving a Jira favourite query or extractor
script is not an edit to roadmap content and never enters this stack.

## The Inverse Is Read, Not Captured

`inverseOf(edit, roadmap)` walks the batch and, for each entry, reads the
entity's current values for exactly the fields the patch sets. No call site
captures a separate "before" value. The inverse still reflects the client's
last observed roadmap, which can lag another user's write. Copy mutable values
such as labels; the milestone's integration value comes from its linkage.

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
today's actions do: optimistic local apply followed by the existing API calls.
It pushes the inverse before the requests go out, in the order this client
applied them rather than the order the server answers in — two gestures overlap
whenever a re-render commits a panel field left half-typed, and a stack in
response order is one no cursor can walk back through. For a multi-call
gesture, wait for every request to settle. If any fails, no undo step survives:
the rollback clears the stack, and the roadmap is reloaded from the server once
all calls finish. An optimistic snapshot rollback cannot undo requests that
already committed. If that reload fails too and part of the gesture had landed,
the roadmap on screen matches neither the server nor the edit: say so and ask
for a page load, rather than let editing continue from a model known to be
wrong.

`updateItem`, `moveItemWithChildren`, `shiftItems`, `updateItemMetadata`,
`updateMilestone`, `renameLane`, `setLaneColor` and `reorderLanes` become thin
builders over it. Call sites in `panel.ts`, `dnd.ts`, `wbs-dnd.ts` and `app.ts`
do not change.

Undo itself calls `applyEdit(inverse, { push: false })` and moves the cursor only
on success. This is replay, not an excluded content mutation: it neither pushes
a new entry nor clears the stack.
Undo/redo cannot run while a roadmap edit is pending, and repeated shortcuts
cannot start a second replay before the first finishes. Ordinary edits keep
their existing concurrency behavior; undo introduces no write queue.

## The Stack Invariant

> Every entry belongs to the current live roadmap and the client state from
> which its inverse was read.

Held by clearing, never by checking:

* **`state.current` is replaced wholesale ⇒ clear.** One hook in the existing
  `set current` accessor, which already invalidates everything derived from the
  model's identity. That covers the SSE refresh, switching roadmaps, entering
  and leaving a snapshot preview, a restore, and a failed mutation's rollback.
* **A foreign SSE event or stream disconnect ⇒ clear immediately**, even when
  refresh is deferred during a drag or field edit. Reconnect refreshes the
  roadmap, but an edit can record new history before that lands — the same
  concurrent-edit race the paragraph below accepts.
* **A successful roadmap-content mutation not recorded as an Edit ⇒ clear.**
  The action mutation boundary does this by default; recording an Edit is the
  explicit exception. Creates, deletes, schedule replacement and dependency
  changes clear the stack. Tracker favourites, extractor scripts, checkpoint
  metadata and visibility are outside that roadmap-content boundary.

Clear on an *observed* remote edit rather than waiting for `state.current` to
be replaced. Client-only undo cannot prevent a remote write that lands before
its SSE notification from being overwritten by an inverse PATCH. A GET before
undo would narrow, but not close, that check-then-write gap. An in-flight edit
may push its inverse only if no stack clear happened while it was pending.

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
and let those through: Cmd/Ctrl+Z for undo, Cmd/Ctrl+Shift+Z for redo. Both keep
`inTextField: false`, so while the caret sits in the title field they stay the
browser's own text undo/redo. While a historical snapshot is previewed, they
do nothing; browsing the live roadmap's history list is not an edit.

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

Those roadmap-content changes clear the stack, and the reason is worth
remembering so a Cmd+Z that finds nothing can say "Empty undo stack —
use version history" rather than doing nothing at all.
