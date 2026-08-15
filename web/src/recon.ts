// The Jira Recon view (notes/JIRA.md): run a user-supplied JQL query against
// the deployment's tracker connection and list the issues it returns, one
// explicitly fetched page at a time — "Load more" is the only way to another
// page, so a single action can never download a whole Jira deployment.
//
// Everything here is view-local module state, deliberately outside AppState:
// tracker results are not roadmap content (not snapshotted, not exported, not
// rendered by any chart view). The state survives view switches — leaving and
// returning shows the same loaded results — but not a reload.
//
// Rendering follows render.ts/wbs.ts: full rebuild from state on every call.
// The one editable field, the query input, gets the panel's courtesy: its text
// lives in `query` (synced on input) and its caret/focus are restored across a
// rebuild, so an SSE refresh landing mid-typing cannot eat a half-written
// query.

import { api } from "./api";
import { state } from "./state";
import type { TrackerIssue } from "./types";

let query = "";
// The query the loaded results and cursor belong to — Load more must send
// this, not the editor's current text: editing the box does not invalidate the
// loaded list, only Run does. null = never ran.
let ranQuery: string | null = null;
let issues: TrackerIssue[] = [];
// Opaque continuation cursor for the next page; undefined = no more pages.
let next: string | undefined;
let loading = false;
let error: string | null = null;
// Stamps each fetch so a slow response cannot apply over a newer run's
// results: bumped at every start, checked before applying.
let seq = 0;

let mount: HTMLElement | null = null;

// rerender repaints after an async step, but only while Recon is on screen: a
// response landing after the user switched back to a chart must not touch its
// DOM (the module state is kept, so returning shows the result). Deliberately
// not state.notify() — tracker results live outside AppState, and a full
// notify fired by a background response could land mid-drag on the chart,
// which is exactly what events.ts gates refreshes to avoid.
function rerender(): void {
  if (mount && state.viewMode === "recon") renderRecon(mount);
}

async function search(q: string, cursor?: string): Promise<void> {
  const mySeq = ++seq;
  loading = true;
  error = null;
  rerender();
  try {
    const page = await api.searchTracker(q, cursor);
    if (seq !== mySeq) return;
    issues = cursor === undefined ? page.issues : issues.concat(page.issues);
    next = page.next;
  } catch (e) {
    if (seq !== mySeq) return;
    error = e instanceof Error ? e.message : String(e);
  }
  loading = false;
  rerender();
}

// run starts over with the editor's query: rerunning clears the loaded
// results, and a changed query invalidates the old cursor (JIRA.md).
function run(): void {
  const q = query.trim();
  if (!q || loading) return;
  ranQuery = q;
  issues = [];
  next = undefined;
  void search(q);
}

function loadMore(): void {
  if (loading || ranQuery === null || next === undefined) return;
  void search(ranQuery, next);
}

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export function renderRecon(container: HTMLElement): void {
  mount = container;
  const scrollTop = container.scrollTop;
  const prev = container.querySelector<HTMLInputElement>(".recon-input");
  const caret =
    prev && prev === document.activeElement
      ? { start: prev.selectionStart ?? prev.value.length, end: prev.selectionEnd ?? prev.value.length }
      : null;

  const root = div("recon");
  root.append(buildQueryForm(), ...buildResults());
  container.replaceChildren(root);

  container.scrollTop = scrollTop;
  if (caret) {
    const input = container.querySelector<HTMLInputElement>(".recon-input");
    if (input) {
      input.focus();
      input.setSelectionRange(caret.start, caret.end);
    }
  }
}

function buildQueryForm(): HTMLElement {
  const head = div("recon-head");
  const h = document.createElement("h2");
  h.textContent = "Jira Recon";
  head.append(h);

  const form = document.createElement("form");
  form.className = "recon-query";
  const input = document.createElement("input");
  input.className = "recon-input";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "JQL — e.g. project = ROAD AND issuetype = Epic";
  input.value = query;
  input.addEventListener("input", () => {
    query = input.value;
  });
  const runBtn = document.createElement("button");
  runBtn.type = "submit";
  runBtn.className = "btn btn-primary";
  runBtn.textContent = loading ? "Running…" : "Run";
  runBtn.disabled = loading;
  form.append(input, runBtn);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run();
  });
  head.append(form);

  if (error !== null) {
    const err = div("recon-error");
    err.textContent = error;
    head.append(err);
  }
  return head;
}

function buildResults(): HTMLElement[] {
  if (ranQuery === null) {
    const hint = div("recon-hint");
    hint.textContent = "Run a JQL query to list issues from the connected Jira.";
    return [hint];
  }

  const out: HTMLElement[] = [];
  if (issues.length > 0) {
    const list = div("recon-list");
    for (const issue of issues) list.append(issueRow(issue));
    out.push(list);
  } else if (loading) {
    const hint = div("recon-hint");
    hint.textContent = "Searching…";
    out.push(hint);
  } else if (error === null) {
    const hint = div("recon-hint");
    hint.textContent = "No issues match this query.";
    out.push(hint);
  }

  // The count states its scope ("loaded", not "found"): the tracker reports no
  // total, and the filter chip to come will count against loaded issues only —
  // that scope has to be legible from the start (JIRA.md).
  if (issues.length > 0 || next !== undefined) {
    const foot = div("recon-foot");
    if (next !== undefined) {
      const more = document.createElement("button");
      more.className = "btn";
      more.textContent = loading ? "Loading…" : "Load more";
      more.disabled = loading;
      more.addEventListener("click", () => loadMore());
      foot.append(more);
    }
    const count = div("recon-count");
    const n = issues.length;
    count.textContent =
      next !== undefined
        ? `${n} issue${n === 1 ? "" : "s"} loaded · more available`
        : `All ${n} issue${n === 1 ? "" : "s"} loaded`;
    foot.append(count);
    out.push(foot);
  }
  return out;
}

// One result row: enough to identify the issue (key, summary, type, status),
// with the key linking out — opening an issue goes to Jira, never to a Roadie
// rendering of it.
function issueRow(issue: TrackerIssue): HTMLElement {
  const row = div("recon-issue");
  const key = document.createElement("a");
  key.className = "recon-issue-key";
  key.href = issue.url;
  key.target = "_blank";
  key.rel = "noreferrer";
  key.title = "Open in Jira";
  key.textContent = issue.key;
  const title = div("recon-issue-title");
  title.textContent = issue.title;
  title.title = issue.title;
  const type = div("recon-issue-type");
  type.textContent = issue.type;
  const status = div("recon-issue-status");
  status.textContent = issue.status;
  row.append(key, title, type, status);
  return row;
}
