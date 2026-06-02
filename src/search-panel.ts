import type { EditorView, Panel } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  selectMatches,
  closeSearchPanel,
} from "@codemirror/search";

const MAX_MATCHES = 1000;

function btn(text: string, title: string, cls = "sf-btn"): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.title = title;
  b.className = cls;
  b.type = "button";
  return b;
}

function toggleBtn(text: string, title: string): HTMLButtonElement {
  const b = btn(text, title, "sf-btn sf-toggle");
  b.addEventListener("click", () => b.classList.toggle("active"));
  return b;
}

function updateCount(
  view: EditorView,
  findInput: HTMLInputElement,
  countEl: HTMLSpanElement,
): void {
  const q = getSearchQuery(view.state);
  if (!q.search) {
    countEl.textContent = "";
    findInput.classList.remove("sf-error");
    return;
  }

  const selFrom = view.state.selection.main.from;

  try {
    const cursor = q.getCursor(view.state);

    let total = 0;
    let current = 0;
    let truncated = false;

    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      total++;
      if (total > MAX_MATCHES) {
        truncated = true;
        break;
      }
      if (current === 0 && next.value.from <= selFrom && next.value.to >= selFrom) {
        current = total;
      }
    }

    findInput.classList.remove("sf-error");
    if (total === 0) {
      countEl.textContent = "No results";
    } else if (truncated) {
      countEl.textContent = current ? `${current} of 1000+` : "1000+";
    } else {
      countEl.textContent = current ? `${current} of ${total}` : `${total} results`;
    }
  } catch {
    findInput.classList.add("sf-error");
    countEl.textContent = "!";
  }
}

function commitQuery(
  view: EditorView,
  findInput: HTMLInputElement,
  replaceInput: HTMLInputElement,
  caseBtn: HTMLButtonElement,
  reBtn: HTMLButtonElement,
  wordBtn: HTMLButtonElement,
): void {
  const q = new SearchQuery({
    search: findInput.value,
    replace: replaceInput.value,
    caseSensitive: caseBtn.classList.contains("active"),
    regexp: reBtn.classList.contains("active"),
    wholeWord: wordBtn.classList.contains("active"),
  });
  view.dispatch({ effects: setSearchQuery.of(q) });
}

export function buildSearchPanel(view: EditorView): Panel {
  const findInput = document.createElement("input");
  findInput.id = "sf-find";
  findInput.type = "text";
  findInput.placeholder = "Find";
  findInput.spellcheck = false;
  findInput.className = "sf-input";

  const countEl = document.createElement("span");
  countEl.id = "sf-count";

  const replaceInput = document.createElement("input");
  replaceInput.id = "sf-replace";
  replaceInput.type = "text";
  replaceInput.placeholder = "Replace";
  replaceInput.spellcheck = false;
  replaceInput.className = "sf-input";

  const nextBtn = btn("↓", "Next match (Enter)");
  const prevBtn = btn("↑", "Previous match (Shift-Enter)");
  const allBtn = btn("All", "Select all matches");
  const closeBtn = btn("×", "Close (Escape)", "sf-btn sf-close");
  const replaceBtn = btn("Replace", "Replace next match");
  const replaceAllBtn = btn("Replace All", "Replace all matches");

  const caseBtn = toggleBtn("Aa", "Match case");
  const reBtn = toggleBtn(".*", "Regular expression");
  const wordBtn = toggleBtn("|w|", "Whole word");

  const commit = () =>
    commitQuery(view, findInput, replaceInput, caseBtn, reBtn, wordBtn);

  findInput.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);
  caseBtn.addEventListener("click", commit);
  reBtn.addEventListener("click", commit);
  wordBtn.addEventListener("click", commit);

  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? findPrevious(view) : findNext(view);
    } else if (e.key === "Escape") {
      closeSearchPanel(view);
      view.focus();
    }
  });

  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSearchPanel(view);
      view.focus();
    }
  });

  nextBtn.addEventListener("click", () => findNext(view));
  prevBtn.addEventListener("click", () => findPrevious(view));
  allBtn.addEventListener("click", () => selectMatches(view));
  closeBtn.addEventListener("click", () => {
    closeSearchPanel(view);
    view.focus();
  });
  replaceBtn.addEventListener("click", () => replaceNext(view));
  replaceAllBtn.addEventListener("click", () => replaceAll(view));

  const findRow = document.createElement("div");
  findRow.className = "sf-row";
  const findInputWrap = document.createElement("div");
  findInputWrap.className = "sf-input-wrap";
  findInputWrap.append(findInput, countEl);
  findRow.append(findInputWrap, nextBtn, prevBtn, allBtn, caseBtn, reBtn, wordBtn, closeBtn);

  const replaceRow = document.createElement("div");
  replaceRow.className = "sf-row";
  replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);

  const dom = document.createElement("div");
  dom.className = "sf-panel";
  dom.append(findRow, replaceRow);

  return {
    dom,
    mount() {
      // sync query → inputs on open (e.g. when Mod-f with selection pre-fills query)
      const q = getSearchQuery(view.state);
      if (q.search) {
        findInput.value = q.search;
        replaceInput.value = q.replace || "";
        caseBtn.classList.toggle("active", !!q.caseSensitive);
        reBtn.classList.toggle("active", !!q.regexp);
        wordBtn.classList.toggle("active", !!q.wholeWord);
      }
      findInput.select();
    },
    update(u: ViewUpdate) {
      const prev = getSearchQuery(u.startState);
      const cur = getSearchQuery(u.state);
      if (prev.search !== cur.search || prev.caseSensitive !== cur.caseSensitive ||
          prev.regexp !== cur.regexp || prev.wholeWord !== cur.wholeWord) {
        if (cur.search !== findInput.value) findInput.value = cur.search;
        if ((cur.replace || "") !== replaceInput.value) replaceInput.value = cur.replace || "";
        caseBtn.classList.toggle("active", !!cur.caseSensitive);
        reBtn.classList.toggle("active", !!cur.regexp);
        wordBtn.classList.toggle("active", !!cur.wholeWord);
      }
      updateCount(u.view, findInput, countEl);
    },
  };
}
