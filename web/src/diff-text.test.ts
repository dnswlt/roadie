import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffLines, type LineOp } from "./diff-text";

// Compact op notation: "=x" same, "+x" add, "-x" del.
function ops(result: LineOp[]): string[] {
  const glyph = { same: "=", add: "+", del: "-" } as const;
  return result.map((op) => glyph[op.kind] + op.text);
}

test("identical texts produce only same ops", () => {
  assert.deepEqual(ops(diffLines("a\nb", "a\nb")), ["=a", "=b"]);
});

test("both empty produce nothing", () => {
  assert.deepEqual(diffLines("", ""), []);
});

test("empty before is all additions, no phantom blank line", () => {
  assert.deepEqual(ops(diffLines("", "a\nb")), ["+a", "+b"]);
});

test("empty after is all deletions", () => {
  assert.deepEqual(ops(diffLines("a\nb", "")), ["-a", "-b"]);
});

test("a genuinely empty line survives as content", () => {
  assert.deepEqual(ops(diffLines("a\n\nb", "a\nb")), ["=a", "-", "=b"]);
});

test("changed block emits deletions before additions", () => {
  assert.deepEqual(ops(diffLines("keep\nold1\nold2\ntail", "keep\nnew1\nnew2\ntail")), [
    "=keep",
    "-old1",
    "-old2",
    "+new1",
    "+new2",
    "=tail",
  ]);
});

test("common prefix and suffix are preserved around an insertion", () => {
  assert.deepEqual(ops(diffLines("a\nc", "a\nb\nc")), ["=a", "+b", "=c"]);
});

test("common prefix and suffix are preserved around a deletion", () => {
  assert.deepEqual(ops(diffLines("a\nb\nc", "a\nc")), ["=a", "-b", "=c"]);
});

test("disjoint texts replace wholesale", () => {
  assert.deepEqual(ops(diffLines("a\nb", "x\ny")), ["-a", "-b", "+x", "+y"]);
});

test("repeated lines match by longest common subsequence", () => {
  assert.deepEqual(ops(diffLines("a\nb\na", "b\na\nb")), ["-a", "=b", "=a", "+b"]);
});
