import assert from "node:assert/strict";
import { test } from "node:test";

import { appendLinkToDescription, extractLinks, linkLabel, trimUrl } from "./links";

test("appendLinkToDescription adds a final paragraph without rewriting the description", () => {
  const url = "https://jira.example.test/browse/PAY-1";
  assert.equal(appendLinkToDescription("", url), url);
  assert.equal(appendLinkToDescription("Existing notes", url), `Existing notes\n\n${url}`);
  assert.equal(appendLinkToDescription("Existing notes\n", url), `Existing notes\n\n${url}`);
  assert.equal(appendLinkToDescription("Existing notes\n\n", url), `Existing notes\n\n${url}`);
});

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

const derived = (url: string) => ({ url, label: linkLabel(url), explicit: false });

test("extractLinks finds, cleans, and dedupes bare URLs", () => {
  assert.deepEqual(extractLinks("no links here"), []);
  assert.deepEqual(extractLinks("see (https://example.com/page)."), [
    derived("https://example.com/page"),
  ]);
  assert.deepEqual(extractLinks("a https://x.io b https://x.io"), [derived("https://x.io")]);
  assert.deepEqual(extractLinks("http://a.co and https://b.co,"), [
    derived("http://a.co"),
    derived("https://b.co"),
  ]);
});

test("extractLinks reads a Markdown link's text as the label", () => {
  assert.deepEqual(extractLinks("[Design doc](https://wiki.corp/x)"), [
    { url: "https://wiki.corp/x", label: "Design doc", explicit: true },
  ]);
  assert.deepEqual(extractLinks("see [the RFC](https://a.co/rfc-7) before Friday."), [
    { url: "https://a.co/rfc-7", label: "the RFC", explicit: true },
  ]);
  assert.deepEqual(extractLinks("[ padded ](https://a.co/x)"), [
    { url: "https://a.co/x", label: "padded", explicit: true },
  ]);
  assert.deepEqual(extractLinks("[Split the store](https://jira.co/browse/ABC-123)"), [
    { url: "https://jira.co/browse/ABC-123", label: "Split the store", explicit: true },
  ]);
  assert.deepEqual(extractLinks("https://jira.co/browse/ABC-123"), [
    { url: "https://jira.co/browse/ABC-123", label: "ABC-123", explicit: false },
  ]);
});

test("extractLinks keeps a Markdown target's balanced parens", () => {
  assert.deepEqual(extractLinks("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"), [
    { url: "https://en.wikipedia.org/wiki/Foo_(bar)", label: "Foo", explicit: true },
  ]);
});

test("extractLinks falls back to a derived label when the text is empty", () => {
  assert.deepEqual(extractLinks("[](https://github.com/a/one)"), [
    derived("https://github.com/a/one"),
  ]);
  assert.deepEqual(extractLinks("[   ](https://github.com/a/one)"), [
    derived("https://github.com/a/one"),
  ]);
});

test("extractLinks dedupes by URL, preferring an explicit label", () => {
  const named = { url: "https://x.io/p", label: "The X", explicit: true };
  assert.deepEqual(extractLinks("https://x.io/p and [The X](https://x.io/p)"), [named]);
  assert.deepEqual(extractLinks("[The X](https://x.io/p) and https://x.io/p"), [named]);
  // Two explicit labels for one URL: the first still wins, as for bare ones.
  assert.deepEqual(extractLinks("[One](https://x.io/p) [Two](https://x.io/p)"), [
    { url: "https://x.io/p", label: "One", explicit: true },
  ]);
});

test("extractLinks ignores unsafe and non-http schemes", () => {
  assert.deepEqual(extractLinks("[Click me](javascript:alert(1))"), []);
  assert.deepEqual(extractLinks("[Pixel](data:text/html;base64,PHNjcmlwdD4=)"), []);
  assert.deepEqual(extractLinks("[Mail](mailto:a@b.co)"), []);
  assert.deepEqual(extractLinks("[Share](file:///etc/passwd)"), []);
  assert.deepEqual(extractLinks("javascript:alert(1)"), []);
});

test("extractLinks survives malformed link syntax", () => {
  assert.deepEqual(extractLinks("[dangling] text"), []);
  assert.deepEqual(extractLinks("[no target]()"), []);
  assert.deepEqual(extractLinks("(https://a.co/x)"), [derived("https://a.co/x")]);
  // Half-written forms still expose their bare URL while the user types.
  assert.deepEqual(extractLinks("[unclosed(https://a.co/x)"), [derived("https://a.co/x")]);
  assert.deepEqual(extractLinks("[label] (https://a.co/x)"), [derived("https://a.co/x")]);
  assert.deepEqual(extractLinks("[label](https://a.co/x"), [derived("https://a.co/x")]);
  assert.deepEqual(extractLinks("[two\nlines](https://a.co/x)"), [derived("https://a.co/x")]);
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
