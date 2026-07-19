"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/links.test.ts
var import_strict = __toESM(require("node:assert/strict"));
var import_node_test = require("node:test");

// src/links.ts
function countChar(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}
function trimUrl(url) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (!`)].,;!?'"`.includes(ch)) break;
    if (ch === ")" && countChar(url.slice(0, end), "(") >= countChar(url.slice(0, end), ")")) break;
    end--;
  }
  return url.slice(0, end);
}
function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s]+/g) ?? [];
  return [...new Set(matches.map(trimUrl))];
}
function linkLabel(url) {
  try {
    const u = new URL(url);
    const jira = u.pathname.match(/\/browse\/([A-Z0-9]+-\d+)/);
    if (jira) return jira[1];
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? `${u.hostname}/${last}` : u.hostname;
  } catch {
    return url;
  }
}

// src/links.test.ts
(0, import_node_test.test)("trimUrl strips trailing sentence punctuation", () => {
  import_strict.default.equal(trimUrl("https://example.com/page."), "https://example.com/page");
  import_strict.default.equal(trimUrl("https://wiki.corp/x,"), "https://wiki.corp/x");
  import_strict.default.equal(trimUrl("https://a.co/p!!!"), "https://a.co/p");
  import_strict.default.equal(trimUrl("https://jira.co/browse/ABC-123."), "https://jira.co/browse/ABC-123");
});
(0, import_node_test.test)("trimUrl drops an unbalanced closing paren (URL written in parens)", () => {
  import_strict.default.equal(trimUrl("https://example.com/page)"), "https://example.com/page");
});
(0, import_node_test.test)("trimUrl keeps a balanced closing paren (e.g. Wikipedia)", () => {
  import_strict.default.equal(
    trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)"),
    "https://en.wikipedia.org/wiki/Foo_(bar)"
  );
  import_strict.default.equal(trimUrl("https://x/Foo_(bar))"), "https://x/Foo_(bar)");
});
(0, import_node_test.test)("trimUrl leaves a clean URL untouched", () => {
  import_strict.default.equal(trimUrl("https://example.com"), "https://example.com");
});
(0, import_node_test.test)("extractUrls finds, cleans, and dedupes URLs", () => {
  import_strict.default.deepEqual(extractUrls("no links here"), []);
  import_strict.default.deepEqual(extractUrls("see (https://example.com/page)."), ["https://example.com/page"]);
  import_strict.default.deepEqual(extractUrls("a https://x.io b https://x.io"), ["https://x.io"]);
  import_strict.default.deepEqual(extractUrls("http://a.co and https://b.co,"), ["http://a.co", "https://b.co"]);
});
(0, import_node_test.test)("linkLabel prefers a Jira issue key", () => {
  import_strict.default.equal(linkLabel("https://jira.co/browse/ABC-123"), "ABC-123");
  import_strict.default.equal(linkLabel("https://jira.co/browse/PROJ2-9/details"), "PROJ2-9");
});
(0, import_node_test.test)("linkLabel falls back to host + last path segment", () => {
  import_strict.default.equal(linkLabel("https://github.com/a/one"), "github.com/one");
  import_strict.default.equal(linkLabel("https://github.com/a/two"), "github.com/two");
  import_strict.default.equal(linkLabel("https://example.com"), "example.com");
  import_strict.default.equal(linkLabel("https://example.com/"), "example.com");
});
(0, import_node_test.test)("linkLabel returns the input when it cannot be parsed", () => {
  import_strict.default.equal(linkLabel("not a url"), "not a url");
});
