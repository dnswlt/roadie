import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ancestorKeys, buildTree, splitPath, type TreeNode } from "./tree";

function rm(name: string): { name: string } {
  return { name };
}

// shape renders a tree as indented lines so a whole expectation reads as the
// list Home draws: "name/" is a folder, a bare name a roadmap.
function shape(nodes: TreeNode<{ name: string }>[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const pad = "  ".repeat(depth);
    if (n.kind === "folder") {
      out.push(`${pad}${n.name}/`);
      out.push(...shape(n.children, depth + 1));
    } else {
      out.push(`${pad}${n.name}`);
    }
  }
  return out;
}

function tree(...names: string[]): string[] {
  return shape(buildTree(names.map(rm)));
}

test("a list with no separators stays flat", () => {
  assert.deepEqual(tree("Beta", "Alpha", "Gamma"), ["Alpha", "Beta", "Gamma"]);
});

test("a separator folds the name into a folder", () => {
  assert.deepEqual(tree("Platform > Q3", "Platform > Q4"), ["Platform/", "  Q3", "  Q4"]);
});

test("a roadmap sits at its own path prefix, not inside its namesake folder", () => {
  assert.deepEqual(tree("Platform", "Platform > Q3"), ["Platform/", "  Q3", "Platform"]);
});

test("the same holds at depth", () => {
  assert.deepEqual(tree("A > B", "A > B > C"), ["A/", "  B/", "    C", "  B"]);
});

test("nesting goes as deep as the name does", () => {
  assert.deepEqual(tree("A > B > C > D"), ["A/", "  B/", "    C/", "      D"]);
});

test("folders come before roadmaps, each alphabetical", () => {
  assert.deepEqual(tree("Zed", "Alpha", "Beta > One", "Alpha > Two"), [
    "Alpha/",
    "  Two",
    "Beta/",
    "  One",
    "Alpha",
    "Zed",
  ]);
});

test("grouping does not depend on input order", () => {
  const a = tree("B > Two", "A > One", "B > One");
  const b = tree("B > One", "B > Two", "A > One");
  assert.deepEqual(a, b);
});

test("spacing around the separator is not part of the path", () => {
  assert.deepEqual(tree("A>B", "A > C", "A  >  D"), ["A/", "  B", "  C", "  D"]);
});

test("empty segments are dropped", () => {
  assert.deepEqual(splitPath("A > > B"), ["A", "B"]);
  assert.deepEqual(splitPath(" > A"), ["A"]);
  assert.deepEqual(splitPath("A > "), ["A"]);
});

test("a name that is only separators keeps its raw name", () => {
  assert.deepEqual(splitPath(">"), [">"]);
  assert.deepEqual(splitPath(" > "), [" > "]);
  // The point of the fallback: such a roadmap is still in the list.
  assert.deepEqual(tree(">"), [">"]);
});

test("a trailing separator does not make a folder", () => {
  assert.deepEqual(tree("Platform >"), ["Platform"]);
});

test("ancestorKeys names the folders to expand", () => {
  assert.deepEqual(ancestorKeys("A > B > C"), ["A", "A>B"]);
  assert.deepEqual(ancestorKeys("A > B"), ["A"]);
  assert.deepEqual(ancestorKeys("A"), []);
});

test("ancestorKeys agrees with the keys buildTree assigns", () => {
  const nodes = buildTree([rm("A > B > C")]);
  const outer = nodes[0];
  assert.equal(outer?.kind, "folder");
  assert.equal(outer?.kind === "folder" ? outer.key : "", "A");
  const inner = outer?.kind === "folder" ? outer.children[0] : undefined;
  assert.equal(inner?.kind === "folder" ? inner.key : "", "A>B");
  assert.deepEqual(ancestorKeys("A > B > C"), ["A", "A>B"]);
});

test("the leaf keeps the full name on the roadmap it carries", () => {
  const nodes = buildTree([rm("Platform > Q3")]);
  const folder = nodes[0];
  const leaf = folder?.kind === "folder" ? folder.children[0] : undefined;
  assert.equal(leaf?.kind === "leaf" ? leaf.name : "", "Q3");
  assert.equal(leaf?.kind === "leaf" ? leaf.roadmap.name : "", "Platform > Q3");
});
