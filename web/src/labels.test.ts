import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLabelInput } from "./labels";

test("label input trims and collapses spaces before checking length", () => {
  assert.deepEqual(parseLabelInput("  Needs   refinement  "), { value: "Needs refinement" });
  assert.deepEqual(parseLabelInput("\u00a0Team\u2003\u2003A\u3000"), { value: "Team A" });
  assert.deepEqual(parseLabelInput(" \u00a0 "), { value: "" });
  assert.deepEqual(parseLabelInput("  " + "a".repeat(64) + "  "), { value: "a".repeat(64) });
  assert.deepEqual(parseLabelInput("a" + " ".repeat(100) + "b"), { value: "a b" });
});

test("labels keep punctuation, case, non-Latin text and emoji", () => {
  for (const value of ["@team", "#hashtag", "this-dash", "snake_case", "C++", "/_.:", "中文", "é", "e\u0301", "👩‍💻"]) {
    assert.deepEqual(parseLabelInput(value), { value });
  }
});

test("accepts labels within 64 Unicode code points and rejects longer ones", () => {
  // The same boundary examples are covered by TestNormalizeLabels in Go.
  for (const [unit, count] of [["a", 64], ["界", 64], ["😀", 64], ["e\u0301", 32], ["👩‍💻", 21]] as const) {
    const value = unit.repeat(count);
    assert.deepEqual(parseLabelInput(value), { value });
    assert.ok("error" in parseLabelInput(value + unit));
  }
  assert.ok("error" in parseLabelInput("a".repeat(1_000_000)));
});

test("label input rejects controls and line separators", () => {
  for (const control of ["\n", "\r", "\t", "\0", "\u001b", "\u007f", "\u0085", "\u2028", "\u2029"]) {
    assert.ok("error" in parseLabelInput(`a${control}b`));
  }
});
