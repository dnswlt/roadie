import assert from "node:assert/strict";
import { test } from "node:test";

import { extractUrls, linkLabel, trimUrl } from "./links";

test("trimUrl strips trailing sentence punctuation", () => {
  assert.equal(trimUrl("https://example.com/page."), "https://example.com/page");
  assert.equal(trimUrl("https://wiki.corp/x,"), "https://wiki.corp/x");
  assert.equal(trimUrl("https://a.co/p!!!"), "https://a.co/p");
  assert.equal(trimUrl("https://jira.co/browse/ABC-123."), "https://jira.co/browse/ABC-123");
});

test("trimUrl drops an unbalanced closing paren (URL written in parens)", () => {
  // The opening "(" is outside the captured URL, so the trailing ")" is junk.
  assert.equal(trimUrl("https://example.com/page)"), "https://example.com/page");
});

test("trimUrl keeps a balanced closing paren (e.g. Wikipedia)", () => {
  assert.equal(
    trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)"),
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  );
  // One inner pair kept, one outer sentence paren dropped.
  assert.equal(trimUrl("https://x/Foo_(bar))"), "https://x/Foo_(bar)");
});

test("trimUrl leaves a clean URL untouched", () => {
  assert.equal(trimUrl("https://example.com"), "https://example.com");
});

test("extractUrls finds, cleans, and dedupes URLs", () => {
  assert.deepEqual(extractUrls("no links here"), []);
  assert.deepEqual(extractUrls("see (https://example.com/page)."), ["https://example.com/page"]);
  assert.deepEqual(extractUrls("a https://x.io b https://x.io"), ["https://x.io"]);
  assert.deepEqual(extractUrls("http://a.co and https://b.co,"), ["http://a.co", "https://b.co"]);
});

test("linkLabel prefers a Jira issue key", () => {
  assert.equal(linkLabel("https://jira.co/browse/ABC-123"), "ABC-123");
  assert.equal(linkLabel("https://jira.co/browse/PROJ2-9/details"), "PROJ2-9");
});

test("linkLabel falls back to host + last path segment", () => {
  assert.equal(linkLabel("https://github.com/a/one"), "github.com/one");
  assert.equal(linkLabel("https://github.com/a/two"), "github.com/two");
  assert.equal(linkLabel("https://example.com"), "example.com");
  assert.equal(linkLabel("https://example.com/"), "example.com");
});

test("linkLabel returns the input when it cannot be parsed", () => {
  assert.equal(linkLabel("not a url"), "not a url");
});
