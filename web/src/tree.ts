// Folds Home's flat roadmap list into a tree: a name containing ">" reads as a
// path, so "Platform > Q3" shows as "Q3" inside a "Platform" folder. This is a
// naming convention rendered, not a data model — nothing is stored, nothing
// round-trips, and a list with no ">" in it produces exactly the flat list it
// did before.
//
// A row's position is its path minus its own last segment, and nothing else.
// "Platform" stays top level even when "Platform > Q3" creates a folder of the
// same name beside it: nesting it there would show it at "Platform > Platform",
// a place its name says it isn't.
//
// Folders are synthetic — they exist only as ancestors of real roadmaps, and
// are never selectable, since Home's select-then-act flow assumes every
// selectable row is a roadmap it can preview.

export const SEPARATOR = ">";

export interface FolderNode<T> {
  kind: "folder";
  // The last segment of the folder's path; what the row displays.
  name: string;
  // The full path, joined — identifies the folder across re-renders, which is
  // what Home's expanded set stores. Segments never contain the separator, so
  // this is unambiguous.
  key: string;
  children: TreeNode<T>[];
}

export interface LeafNode<T> {
  kind: "leaf";
  // The last segment of the roadmap's name. The full name stays on `roadmap`;
  // every other surface (title bar, exports, find) keeps showing that.
  name: string;
  roadmap: T;
}

export type TreeNode<T> = FolderNode<T> | LeafNode<T>;

// splitPath reads a name as a path. Segments are trimmed and empty ones
// dropped, so "A>B", "A > B" and "A > > B" are the same two-segment path. A
// name that is nothing but separators has no segments to keep, so it keeps its
// raw name and stays a top-level row rather than vanishing from the list.
export function splitPath(name: string): string[] {
  const segs = name
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return segs.length > 0 ? segs : [name];
}

// ancestorKeys lists the folders a roadmap sits under, outermost first:
// "A > B > C" gives ["A", "A>B"]. Expanding exactly these reveals the roadmap.
export function ancestorKeys(name: string): string[] {
  const segs = splitPath(name);
  const keys: string[] = [];
  const walked: string[] = [];
  for (const seg of segs.slice(0, -1)) {
    walked.push(seg);
    keys.push(walked.join(SEPARATOR));
  }
  return keys;
}

// buildTree groups roadmaps by their name paths. Generic over the entry type so
// it serves both Home tabs: trashed roadmaps carry names too.
export function buildTree<T extends { name: string }>(roadmaps: readonly T[]): TreeNode<T>[] {
  const root: TreeNode<T>[] = [];
  const folders = new Map<string, FolderNode<T>>();

  for (const rm of roadmaps) {
    const segs = splitPath(rm.name);
    const leafName = segs.pop() ?? rm.name;
    let siblings = root;
    const walked: string[] = [];
    for (const seg of segs) {
      walked.push(seg);
      const key = walked.join(SEPARATOR);
      let folder = folders.get(key);
      if (!folder) {
        folder = { kind: "folder", name: seg, key, children: [] };
        folders.set(key, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    siblings.push({ kind: "leaf", name: leafName, roadmap: rm });
  }

  sortNodes(root);
  return root;
}

// Folders before leaves, each alphabetical: folder rows are what the top of a
// long list gets scanned by. Sorting here rather than relying on the server's
// name ordering keeps the fold independent of input order. Equal labels keep
// input order (Array.sort is stable), so two roadmaps with the same name stay
// in the order the server sent them.
function sortNodes<T>(nodes: TreeNode<T>[]): void {
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
  );
  for (const n of nodes) if (n.kind === "folder") sortNodes(n.children);
}
