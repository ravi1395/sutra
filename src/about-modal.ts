// About panel: a tabbed overlay (What's New / Tutorial / About) opened from the
// app menu (☰ "about sutra…" / "what's new •"), the palette `>about` command,
// and the Settings "About Sutra →" link. Reuses the settings-modal CSS grammar
// (.settings-overlay/.settings-modal/.settings-nav-item/.settings-content).
// Content is static + bundled so the panel works offline.
import { icon } from "./icons";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface Release {
  version: string;
  date: string; // ISO date, e.g. "2026-07-05"
  notes: string[];
}

export interface TutorialSection {
  title: string;
  body: string;
}

export interface TutorialShortcut {
  title: string;
  keys: string;
}

const REPO_URL = "https://github.com/ravi1395/sutra";
const RELEASES_URL = `${REPO_URL}/releases`;

// Post-update discovery: the ☰ button shows a dot badge until the user views
// What's New for the current version. Gating is a pure function so it's testable.
export const WHATS_NEW_SEEN_KEY = "sutra.whatsNewSeen";

/** True when the running version exists and differs from the last version whose What's New was viewed. */
export function shouldShowWhatsNew(current: string, seen: string | null): boolean {
  return current !== "" && current !== seen;
}

export const ABOUT_TABS = ["What's New", "Tutorial", "About"] as const;
export type AboutTab = (typeof ABOUT_TABS)[number];

// Changelog, newest first. Source of truth for the What's New tab; add an entry
// per release. Kept terse — one line per user-visible change.
export const RELEASES: Release[] = [
  {
    version: "2.3.41",
    date: "2026-07-22",
    notes: [
      "Stanza: the code outline now appears as soon as you open or switch files.",
      "Stanza: room tabs are the only surface control — the redundant terminal/diff/browser toggles are gone, and non-Run rooms no longer leave a terminal strip behind.",
      "Stanza: the Write sidebar is Files + Outline; project search stays on ⇧⌘F and ⌘P.",
      "North Light: the change ledger holds its scroll position and no longer lists files that ended up unchanged in a turn's diff.",
      "North Light: a file-tree button (and ⌘B) toggles the sidebar.",
      "Graphite: removed the duplicate terminal button; the Problems tab now fills the panel.",
      "The Problems panel shows \"No problems found.\" instead of a blank pane.",
    ],
  },
  {
    version: "2.3.4",
    date: "2026-07-21",
    notes: [
      "The terminal now keeps raw Vim input — including Esc, Tab, and F1–F12 — instead of routing it through app shortcuts.",
      "Terminal focus recovery is centralized across hide/show, terminal tab activation, and app focus return.",
      "Clicks on terminal card padding, surrounding chrome, or dismissing the command palette no longer steal keyboard focus from the terminal.",
    ],
  },
  {
    version: "2.3.3",
    date: "2026-07-19",
    notes: [
      "Four new views — North Light, Graphite, and Stanza — each with day/night themes, switchable from the palette.",
      "Diff panel gets a branch-review scope: toggle \"vs main\" for a merge-base file list and a scoped read-only gutter.",
      "Agent turn UX rehaul — collapsible summary row, retryable rollback, and paged history.",
      "Diff baseline fix: changed-files now compares against HEAD, not a stale checkout.",
    ],
  },
  {
    version: "2.3.2",
    date: "2026-07-14",
    notes: [
      "CLI installation now generates a terminal-detached shim; native Ctrl-C / terminal-close smoke remains pending.",
      "Workspace indexing no longer blocks the UI on large folders — file tree, terminal, and shortcuts stay responsive during startup scans.",
    ],
  },
  {
    version: "2.3.1",
    date: "2026-07-11",
    notes: [
      "Inline preview: ⇧⌘V renders Markdown/Mermaid/HTML right in the focused tab — the split preview pane is gone.",
      "New agent task panel: track, dispatch, and review agent turns, with isolated worktree dispatch and per-turn handoff.",
      "Agent annotations and prompt-composer profiles: save reusable agent profiles, review context-pack summaries before sending.",
      "Window-registry reliability fixes for multi-window/multi-process sessions.",
    ],
  },
  {
    version: "2.2.0",
    date: "2026-07-09",
    notes: [
      "Unified ⌘P palette: search files by default, then > for commands, # for symbols, @ for recent workspaces.",
      "Menus tidied — every action now lives in exactly one place (folder/workspace on the left, app settings on the right).",
      "The always-on version tag is gone; a dot on the menu button quietly flags What's New after an update.",
      "Version and About details consolidated into a single About panel.",
    ],
  },
  {
    version: "2.1.0",
    date: "2026-07-05",
    notes: [
      "Open files and folders in Sutra from Finder, Explorer, and the command line.",
      "Click the version to see What's New, a quick tutorial, and About.",
      "Set up run/debug automations for any project straight from an AI session.",
      "Much lower idle energy use — background work pauses while the window is hidden.",
      "Prompt composer delivers staged prompts into an idle agent reliably.",
      "Restores your last folder on launch; sturdier update checks; scrollable branch picker.",
    ],
  },
  {
    version: "2.0.0",
    date: "2026-07-03",
    notes: [
      "Redesigned prompt composer: a hero task field with drag-resizable preview and history drawers.",
      "AI change review: accept or reject an agent's edits hunk by hunk.",
      "MCP control plane — drive Sutra from Claude Code and Codex sessions.",
      "Launch-crash fix via a statically linked, vendored libgit2.",
    ],
  },
];

// Short walkthrough shown on the Tutorial tab.
export const TUTORIAL_SECTIONS: TutorialSection[] = [
  {
    title: "Open a folder",
    body: "Press ⌘O, or click the workspace name at the top-left, to pick a project. Sutra reopens your last folder on launch.",
  },
  {
    title: "Edit in tabs",
    body: "Click files in the tree to open them as tabs. ⌘S saves. The diff gutter marks changes against git HEAD — click a hunk to revert just that hunk.",
  },
  {
    title: "Terminals",
    body: "⌘J toggles the terminal drawer. Run several sessions side by side, and ⌘\\ splits the editor into two panes.",
  },
  {
    title: "Find things fast",
    body: "⌘P searches files and runs commands (> commands, # symbols, @ workspaces). ⌘F finds within a file; ⇧⌘F searches the whole folder.",
  },
  {
    title: "Automations",
    body: "The bolt button (top-right) runs your saved project commands — build, test, run. They live in .sutra/automations.json, and an AI session can set them up for you.",
  },
  {
    title: "Track AI edits",
    body: "Turn on Track AI to see which lines an agent changed, review them per hunk, and roll a whole turn back if you need to.",
  },
  {
    title: "Switch views",
    body: "Open the palette (⌘P → >) and pick a view — Classic, North Light, Graphite, or Stanza — each with a day/night variant. North Light adds a Ledger rail (⌘L) for agent turns; Stanza splits the window into Write/Run/Review/Web rooms (⌘1–⌘4).",
  },
];

// Keyboard reference shown on the Tutorial tab.
export const TUTORIAL_SHORTCUTS: TutorialShortcut[] = [
  { title: "Open folder", keys: "⌘O" },
  { title: "Save", keys: "⌘S" },
  { title: "Command palette", keys: "⌘P" },
  { title: "Find in file", keys: "⌘F" },
  { title: "Search folder", keys: "⇧⌘F" },
  { title: "Toggle comment", keys: "⌘/" },
  { title: "Toggle terminal", keys: "⌘J" },
  { title: "Toggle sidebar", keys: "⌘B" },
  { title: "Split editor", keys: "⌘\\" },
  { title: "Preview", keys: "⇧⌘V" },
  { title: "Settings", keys: "⌘," },
];

let openOverlay: HTMLElement | null = null;

function sectionHead(label: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "menu-head settings-section-head";
  h.textContent = label;
  return h;
}

// Opens the About panel focused on `initialTab` (idempotent while already open).
export function openAboutModal(version: string, initialTab: AboutTab = "What's New"): void {
  if (openOverlay) return;

  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";
  const modal = document.createElement("div");
  modal.className = "settings-modal about-modal";

  const header = document.createElement("div");
  header.className = "settings-header";
  const title = document.createElement("span");
  title.textContent = "Sutra";
  const closeBtn = document.createElement("button");
  closeBtn.className = "settings-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "settings-body";
  const nav = document.createElement("div");
  nav.className = "settings-nav";
  const content = document.createElement("div");
  content.className = "settings-content";
  body.append(nav, content);
  modal.append(header, body);
  overlay.append(modal);

  // ---- What's New ----
  function renderWhatsNew(): void {
    const frag: HTMLElement[] = [sectionHead("What's New")];
    for (const rel of RELEASES) {
      const block = document.createElement("div");
      block.className = "about-release";
      const head = document.createElement("div");
      head.className = "about-release-head";
      const ver = document.createElement("span");
      ver.className = "about-ver";
      ver.textContent = `v${rel.version}`;
      const date = document.createElement("span");
      date.className = "about-date";
      date.textContent = rel.date;
      head.append(ver, date);
      const list = document.createElement("ul");
      list.className = "about-notes";
      for (const note of rel.notes) {
        const li = document.createElement("li");
        li.textContent = note;
        list.append(li);
      }
      block.append(head, list);
      frag.push(block);
    }
    content.replaceChildren(...frag);
  }

  // ---- Tutorial ----
  function renderTutorial(): void {
    const frag: HTMLElement[] = [sectionHead("Getting started")];
    for (const sec of TUTORIAL_SECTIONS) {
      const wrap = document.createElement("div");
      wrap.className = "about-step";
      const t = document.createElement("div");
      t.className = "about-step-title";
      t.textContent = sec.title;
      const p = document.createElement("p");
      p.className = "settings-desc";
      p.textContent = sec.body;
      wrap.append(t, p);
      frag.push(wrap);
    }
    frag.push(sectionHead("Shortcuts"));
    const table = document.createElement("div");
    table.className = "settings-shortcuts";
    for (const s of TUTORIAL_SHORTCUTS) {
      const r = document.createElement("div");
      r.className = "settings-shortcut-row";
      const t = document.createElement("span");
      t.textContent = s.title;
      const k = document.createElement("kbd");
      k.textContent = s.keys;
      r.append(t, k);
      table.append(r);
    }
    frag.push(table);
    content.replaceChildren(...frag);
  }

  // ---- About ----
  function renderAbout(): void {
    const wordmark = document.createElement("h2");
    wordmark.className = "settings-wordmark";
    wordmark.innerHTML = `<span class="settings-mark">${icon("brandMark", 22, 2.2)}</span><span>Sutra</span>`;
    const tagline = document.createElement("p");
    tagline.className = "settings-tagline";
    tagline.textContent = "A minimal code editor.";
    const desc = document.createElement("p");
    desc.className = "settings-desc";
    desc.textContent =
      "Three panes, no ceremony: file tree, CodeMirror 6 multi-tab editor, and " +
      "integrated terminals — with a git diff gutter, per-hunk revert, project " +
      "search, live preview, and AI agent edit tracking.";
    const ver = document.createElement("p");
    ver.className = "settings-version";
    ver.textContent = `Version ${version}`;

    const links = document.createElement("div");
    links.className = "about-links";
    const mkLink = (label: string, url: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "settings-reset";
      b.textContent = label;
      b.onclick = () => void openUrl(url).catch(() => {});
      return b;
    };
    links.append(mkLink("GitHub", REPO_URL), mkLink("Releases", RELEASES_URL));

    content.replaceChildren(sectionHead("About"), wordmark, tagline, desc, ver, links);
  }

  const renderers: Record<AboutTab, () => void> = {
    "What's New": renderWhatsNew,
    Tutorial: renderTutorial,
    About: renderAbout,
  };

  function renderTab(tab: AboutTab): void {
    for (const el of Array.from(nav.children))
      el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab);
    renderers[tab]();
  }

  for (const tab of ABOUT_TABS) {
    const item = document.createElement("button");
    item.className = "settings-nav-item";
    item.dataset.tab = tab;
    item.textContent = tab;
    item.onclick = () => renderTab(tab);
    nav.append(item);
  }

  function close(): void {
    overlay.remove();
    openOverlay = null;
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  closeBtn.onclick = close;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  renderTab(ABOUT_TABS.includes(initialTab) ? initialTab : "What's New");
  document.body.append(overlay);
  openOverlay = overlay;
}
