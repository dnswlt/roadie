// Discovery and selection of integration milestones from other roadmaps. This
// is deliberately an explicit search dialog rather than another global Find
// corpus: a source is not part of this roadmap until the user links it.

import { api } from "./api";
import { icons } from "./icons";
import { dayOf, formatDay } from "./timescale";
import type { IntegrationMilestone } from "./types";

const MAX_SEARCH_RESULTS = 50;

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "menu-empty";
  el.textContent = text;
  return el;
}

function resultRow(
  source: IntegrationMilestone,
  choose: (source: IntegrationMilestone) => void,
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "find-row mirror-result";

  const text = document.createElement("span");
  text.className = "find-text";
  const titleLine = document.createElement("span");
  titleLine.className = "find-title-line";
  titleLine.append(icons.providedInterface(16));
  const title = document.createElement("span");
  title.className = "find-title";
  title.textContent = source.title;
  titleLine.append(title);

  const meta = document.createElement("span");
  meta.className = "find-meta";
  meta.textContent = `${source.roadmapName} · ${formatDay(dayOf(source.date))}`;
  text.append(titleLine, meta);
  if (source.description.trim() !== "") {
    const description = document.createElement("span");
    description.className = "mirror-result-description";
    description.textContent = source.description;
    text.append(description);
  }
  row.append(text);
  row.addEventListener("click", () => choose(source));
  return row;
}

// Returns the provider milestone to mirror, leaving creation to actions.ts so
// the dialog has no client-state mutation or rollback responsibilities.
export function mirrorMilestoneDialog(
  roadmapId: number,
): Promise<IntegrationMilestone | null> {
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();
  dlg.classList.add("mirror-dialog");

  const form = document.createElement("form");
  const heading = document.createElement("h3");
  heading.textContent = "Link external milestone";

  const searchBar = document.createElement("div");
  searchBar.className = "mirror-search-bar";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Milestone, roadmap or description";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.required = true;
  input.setAttribute("aria-label", "Search external milestones");
  const search = document.createElement("button");
  search.type = "submit";
  search.className = "btn btn-primary";
  search.append(icons.search(15), document.createTextNode("Search"));
  searchBar.append(input, search);

  const head = document.createElement("div");
  head.className = "find-head";
  head.setAttribute("aria-live", "polite");
  const results = document.createElement("div");
  results.className = "find-list mirror-search-results";
  results.setAttribute("aria-label", "External milestone search results");
  results.append(note("Search integration milestones published by other roadmaps."));

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  actions.append(cancel);
  form.append(heading, searchBar, head, results, actions);
  dlg.append(form);

  let choice: IntegrationMilestone | null = null;
  let searching = false;

  const choose = (source: IntegrationMilestone): void => {
    choice = source;
    dlg.close();
  };
  const runSearch = async (): Promise<void> => {
    const query = input.value.trim();
    if (query === "" || searching) return;
    searching = true;
    search.disabled = true;
    search.replaceChildren(document.createTextNode("Searching…"));
    head.replaceChildren();
    results.replaceChildren(note("Searching…"));
    try {
      const matches = await api.searchIntegrationMilestones(roadmapId, query);
      head.textContent =
        matches.length === MAX_SEARCH_RESULTS
          ? `${MAX_SEARCH_RESULTS} results · Refine your search`
          : matches.length === 1
            ? "1 result"
            : `${matches.length} results`;
      results.replaceChildren();
      if (matches.length === 0) {
        results.append(note("No integration milestones match this search."));
      } else {
        for (const source of matches) results.append(resultRow(source, choose));
      }
    } catch (e) {
      results.replaceChildren(
        note(e instanceof Error ? e.message : "Could not search integration milestones."),
      );
    } finally {
      searching = false;
      search.disabled = false;
      search.replaceChildren(icons.search(15), document.createTextNode("Search"));
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runSearch();
  });
  cancel.addEventListener("click", () => dlg.close());

  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        dlg.classList.remove("mirror-dialog");
        resolve(choice);
      },
      { once: true },
    );
    dlg.showModal();
    input.focus();
  });
}
