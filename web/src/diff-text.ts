// Line-based text diff for the version-diff view (diff-view.ts): plain LCS
// over lines, DOM-free so diff-text.test.ts can pin it. Descriptions are prose
// of at most a few hundred lines, so the quadratic table buys the simplest
// correct implementation.

export interface LineOp {
  kind: "same" | "add" | "del";
  text: string;
}

// diffLines compares two texts line by line. At each divergence deletions are
// emitted before additions, so a changed paragraph reads old-then-new. The
// empty string is no lines at all, not one empty line: an empty description
// diffed against text must not produce a phantom blank row.
export function diffLines(before: string, after: string): LineOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: Int32Array[] = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // >= keeps taking deletions while they don't cost LCS length, which is
      // what groups a changed block's old lines ahead of its new ones.
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}
