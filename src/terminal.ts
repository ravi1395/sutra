// Terminal subsystem: xterm.js front-ends bound to portable-pty sessions in Rust.
// Multiple terminals; toggling the panel only hides the DOM — PTYs keep running,
// so reopening resumes the live session.
import { Terminal, type ITheme, type ILink, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { homeDir } from "@tauri-apps/api/path";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, ptyIsBusy, onPtyOutput, onPtyExit, clipboardRead, clipboardWrite, agentTrackingBegin, fileMtime } from "./ipc";
import { isIntegratedAgentCommand } from "./agent-tracking";
import { showContextMenu, type ContextMenuItem } from "./contextmenu";
import { beginSplitPointerDrag } from "./split-drop";
import {
  collapseAfterClose,
  groupSideForItem,
  moveItemToGroup,
  removeItemFromGroups,
  type TerminalGroupSide,
  type TerminalGroups,
} from "./terminal-groups";
import { icon } from "./icons";
import { isMod } from "./shortcuts";
import { isControlSequence } from "./terminal-input";
import { cssVar, DEFAULT_TERM_COLORS as D } from "./theme-tokens";

export type TerminalMaximizeState = TerminalGroupSide | null;

interface Term {
  id: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  title: string;
  alive: boolean;
  spawnPending: boolean;
  agentAttached: boolean;
  currentInput: string; // Current line being typed
  cwd: string | null; // Spawn-time cwd (session.cwd) — used to resolve relative file links
}

type SessionSnapshot = { count: number; liveCount: number };
type SessionNotification = SessionSnapshot & { listeners: (() => void)[] };

/** Build the live xterm theme from CSS tokens (full ANSI-16 + bg/fg/cursor/selection). */
export function buildTermTheme(): ITheme {
  return {
    background: cssVar("--term-bg", D.background),
    foreground: cssVar("--term-fg", D.foreground),
    cursor: cssVar("--term-fg", D.cursor),
    cursorAccent: cssVar("--term-bg", D.cursorAccent),
    selectionBackground: cssVar("--em-wash", D.selectionBackground),
    black: cssVar("--ansi-black", D.black),
    red: cssVar("--ansi-red", D.red),
    green: cssVar("--ansi-green", D.green),
    yellow: cssVar("--ansi-yellow", D.yellow),
    blue: cssVar("--ansi-blue", D.blue),
    magenta: cssVar("--ansi-magenta", D.magenta),
    cyan: cssVar("--ansi-cyan", D.cyan),
    white: cssVar("--ansi-white", D.white),
    brightBlack: cssVar("--ansi-bright-black", D.brightBlack),
    brightRed: cssVar("--ansi-bright-red", D.brightRed),
    brightGreen: cssVar("--ansi-bright-green", D.brightGreen),
    brightYellow: cssVar("--ansi-bright-yellow", D.brightYellow),
    brightBlue: cssVar("--ansi-bright-blue", D.brightBlue),
    brightMagenta: cssVar("--ansi-bright-magenta", D.brightMagenta),
    brightCyan: cssVar("--ansi-bright-cyan", D.brightCyan),
    brightWhite: cssVar("--ansi-bright-white", D.brightWhite),
  };
}

/** Re-theme every live terminal session in place; xterm repaints on `options.theme` assignment.
 *  Exported (rather than inlined in the subscription) so tests can drive it against fake
 *  sessions without a MutationObserver/DOM. */
export function retheme(sessions: ReadonlyArray<{ term: Pick<Terminal, "options"> }>): void {
  const theme = buildTermTheme();
  for (const s of sessions) s.term.options.theme = theme;
}

/** Classify a URL's host for cmd+click routing: loopback hosts open in Sutra's embedded
 *  browser pane, everything else goes to the OS default browser. */
export function classifyLink(uri: string): "localhost" | "external" {
  try {
    const host = new URL(uri).hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
      return "localhost";
    }
  } catch {
    // Unparsable — fall through to external so we never silently misroute.
  }
  return "external";
}

interface PathMatch {
  path: string;
  line?: number;
  index: number;
  length: number;
}

// Path-ish token: optional prefix (~/, ~, ../, ./, /) + a body of word/dot/slash/hyphen chars,
// plus an optional :line[:col] suffix (col is captured only to be dropped — openFile has no
// column support). Bare words with no separator, extension, or :line are filtered out below so
// stray identifiers in shell output don't turn into link spam.
const PATH_TOKEN_SRC = String.raw`(~\/|~|\.\.\/|\.\/|\/)?(\w[\w./-]*)(?::(\d+)(?::\d+)?)?`;

function findPathMatches(lineText: string, cap = 20): PathMatch[] {
  const re = new RegExp(PATH_TOKEN_SRC, "g");
  const out: PathMatch[] = [];
  let m: RegExpExecArray | null;
  while (out.length < cap && (m = re.exec(lineText))) {
    const path = (m[1] ?? "") + m[2];
    const hasLine = m[3] !== undefined;
    const pathIsh = path.includes("/") || /\.[A-Za-z0-9]+$/.test(path) || hasLine;
    if (pathIsh) {
      out.push({ path, line: hasLine ? Number(m[3]) : undefined, index: m.index, length: m[0].length });
    }
  }
  return out;
}

/** Extract path-ish tokens (with optional :line[:col], col dropped) from one terminal line of text. */
export function extractPathCandidates(lineText: string): Array<{ path: string; line?: number }> {
  return findPathMatches(lineText).map(({ path, line }) => (line === undefined ? { path } : { path, line }));
}

export type MtimeProbe = (path: string) => Promise<number>;

function joinPosix(base: string, rel: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const r = rel.startsWith("/") ? rel.slice(1) : rel;
  return `${b}/${r}`;
}

/** Resolve a path-ish token to a validated absolute path, trying (in order) the literal token,
 *  home-expansion, the spawning terminal's cwd, then the workspace root — first mtime hit wins.
 *  `probe` and `home` are injected so tests can stub filesystem existence. */
export async function resolveLinkPath(
  path: string,
  ctx: { cwd: string | null; workspaceRoot: string | null; home: string | null },
  probe: MtimeProbe,
): Promise<string | null> {
  const isTilde = path === "~" || path.startsWith("~/");
  const attempts: string[] = [];
  // Bare-literal probe only for already-absolute tokens (incl. ~-prefixed, absolute post-expansion) —
  // a plain relative token must never hit fs::metadata as-is: that resolves against the Sutra
  // process's launch cwd, not the terminal session's cwd, and can shadow the real match below.
  if (path.startsWith("/") || isTilde) attempts.push(path);
  if (isTilde) {
    if (ctx.home) attempts.push(path === "~" ? ctx.home : joinPosix(ctx.home, path.slice(2)));
  }
  if (!path.startsWith("/")) {
    if (ctx.cwd) attempts.push(joinPosix(ctx.cwd, path));
    if (ctx.workspaceRoot) attempts.push(joinPosix(ctx.workspaceRoot, path));
  }
  for (const attempt of attempts) {
    try {
      await probe(attempt);
      return attempt;
    } catch {
      // Not this one — try the next candidate location.
    }
  }
  return null;
}

let cachedHomeDir: Promise<string | null> | null = null;
/** Cached best-effort home dir via Tauri's core path resolver (the renderer has no HOME env). */
function getHomeDir(): Promise<string | null> {
  if (!cachedHomeDir) cachedHomeDir = homeDir().catch(() => null);
  return cachedHomeDir;
}

/** Collect the full logical (wrapped) line containing buffer row `y0` (0-based): walk back to
 *  the row that starts the wrap chain, then forward through every continuation row. Adapted from
 *  @xterm/addon-web-links's windowing strategy (MIT) without its space heuristic — path tokens,
 *  like URLs, never legitimately contain unescaped spaces, so a straight wrap-chain walk is
 *  precise here without needing that shortcut. */
function getWindowedLine(term: Terminal, y0: number): { text: string; startRow: number } | null {
  const buf = term.buffer.active;
  if (!buf.getLine(y0)) return null;
  let startRow = y0;
  while (startRow > 0 && buf.getLine(startRow)?.isWrapped) startRow--;
  const parts: string[] = [];
  let row = startRow;
  let guard = 0;
  do {
    const line = buf.getLine(row);
    if (!line) break;
    parts.push(line.translateToString(true));
    row++;
    guard++;
  } while (guard < 200 && buf.getLine(row)?.isWrapped);
  return { text: parts.join(""), startRow };
}

/** Port of @xterm/addon-web-links's `_mapStrIdx` (MIT): advance `count` string characters from
 *  (lineIndex, columnIndex), returning the buffer position reached — walking through wrapped
 *  continuation rows and accounting for wide (2-cell) characters. */
function mapStrIdx(term: Terminal, lineIndex: number, columnIndex: number, count: number): [number, number] {
  const buf = term.buffer.active;
  const nullCell = buf.getNullCell();
  let li = lineIndex;
  let col = columnIndex;
  let remaining = count;
  while (remaining > 0) {
    const line = buf.getLine(li);
    if (!line) return [-1, -1];
    for (let x = col; x < line.length; x++) {
      line.getCell(x, nullCell);
      const chars = nullCell.getChars();
      if (nullCell.getWidth()) {
        remaining -= chars.length || 1;
        if (x === line.length - 1 && chars === "") {
          const nextLine = buf.getLine(li + 1);
          if (nextLine?.isWrapped) {
            nextLine.getCell(0, nullCell);
            if (nullCell.getWidth() === 2) remaining += 1;
          }
        }
      }
      if (remaining < 0) return [li, x];
    }
    li++;
    col = 0;
  }
  return [li, col];
}

/** Custom xterm link provider for file paths — WebLinksAddon's regex is URL-only. Reads the
 *  hovered logical (wrapped) line, extracts path-ish candidates, resolves+validates each against
 *  the filesystem, and only surfaces validated paths as clickable links (modifier-gated). */
export class FileLinkProvider implements ILinkProvider {
  constructor(
    private readonly term: Terminal,
    private readonly getCwd: () => string | null,
    private readonly getWorkspaceRoot: () => string | null,
    private readonly probe: MtimeProbe,
    private readonly onActivate: (absPath: string, line?: number) => void,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    void this.computeLinks(y - 1).then(callback);
  }

  private async computeLinks(y0: number): Promise<ILink[] | undefined> {
    const windowed = getWindowedLine(this.term, y0);
    if (!windowed) return undefined;
    const matches = findPathMatches(windowed.text);
    if (matches.length === 0) return undefined;

    const home = await getHomeDir();
    const ctx = { cwd: this.getCwd(), workspaceRoot: this.getWorkspaceRoot(), home };
    const links: ILink[] = [];
    for (const match of matches) {
      const resolved = await resolveLinkPath(match.path, ctx, this.probe);
      if (!resolved) continue;
      const [startLine, startCol] = mapStrIdx(this.term, windowed.startRow, 0, match.index);
      const [endLine, endCol] = mapStrIdx(this.term, startLine, startCol, match.length);
      if (startLine === -1 || endLine === -1) continue;
      links.push({
        range: { start: { x: startCol + 1, y: startLine + 1 }, end: { x: endCol, y: endLine + 1 } },
        text: windowed.text.slice(match.index, match.index + match.length),
        activate: (event) => {
          if (!isMod(event)) return;
          this.onActivate(resolved, match.line);
        },
      });
    }
    return links.length ? links : undefined;
  }
}

// Random PTY ids survive HMR reloads — the Rust process keeps running across hot
// reloads, so a counter reset would re-issue the same id and pick up the old
// session's stale pty-exit event when the HashMap insert drops the old Session.
function newPtyId(): string {
  return `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TerminalManager {
  private host: HTMLElement;
  private area: HTMLElement;
  private groupHosts: Record<TerminalGroupSide, HTMLElement>;
  private tabLists: Record<TerminalGroupSide, HTMLElement>;
  private bodyHosts: Record<TerminalGroupSide, HTMLElement>;
  private groups: TerminalGroups<Term> = { left: [], right: [] };
  private activeByGroup: Record<TerminalGroupSide, Term | null> = { left: null, right: null };
  private focusedGroup: TerminalGroupSide = "left";
  private mainEl: HTMLElement;
  private maximizedGroup: TerminalGroupSide | null = null;
  private savedFlex = '';
  private maximizeBtns: Partial<Record<TerminalGroupSide, HTMLButtonElement>> = {};
  private terms: Term[] = [];
  private active: Term | null = null;
  private seq = 0;
  private fontSize = 12;
  private fontFamily = '"SF Mono", Menlo, monospace';
  private scrollback = 5000;
  private shellPref: string | null = null;
  private sessionListeners = new Set<() => void>();
  private sessionNotifications: SessionNotification[] = [];
  private drainingSessionNotifications = false;
  private sessionSnapshotOverride: SessionSnapshot | null = null;
  // Cursor blink is a repaint loop that keeps the compositor awake. Read the OS
  // reduced-motion preference once, and let the window-idle gate pause blink
  // while hidden — WKWebView keeps xterm's blink timer running off-screen where
  // the CSS animation gate cannot reach it.
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private blinkPaused = false;
  cwd: string | null = null;
  onTabsChanged?: () => void;
  /** Fires after a Claude/Codex command is delivered to an integrated terminal. */
  onAgentAttached?: () => void;
  onUrlActivate?: (uri: string, kind: "localhost" | "external") => void; // cmd+click on a URL
  onFileLinkActivate?: (absPath: string, line?: number) => void; // cmd+click on a resolved file path

  constructor(host: HTMLElement, area: HTMLElement, mainEl: HTMLElement) {
    this.mainEl = mainEl;
    this.host = host;
    this.area = area;

    const buildGroup = (side: TerminalGroupSide, extraClass: string) => {
      const col = document.createElement("div");
      col.className = `term-group ${extraClass}`;
      col.dataset.side = side;

      const tabsBar = document.createElement("div");
      tabsBar.className = "term-group-tabs";

      const tabList = document.createElement("div");
      tabList.className = "term-tab-list";

      const addBtn = document.createElement("button");
      addBtn.className = "term-add";
      addBtn.title = "New terminal";
      addBtn.textContent = "+";
      addBtn.onclick = () => void this.create(side);

      const maxBtn = document.createElement("button");
      maxBtn.className = "term-maximize";
      maxBtn.title = "Maximize terminal";
      maxBtn.innerHTML = icon("expand", 14, 1.6);
      maxBtn.onclick = () => this.toggleMaximize(side);
      this.maximizeBtns[side] = maxBtn;

      tabsBar.append(tabList, addBtn, maxBtn);

      const body = document.createElement("div");
      body.className = "term-group-body";

      col.append(tabsBar, body);
      // Focus the group when its body is pressed. Skip presses inside the tab bar:
      // focusGroup() rebuilds the tab DOM, which would destroy the pressed tab node
      // before its click fires (killing tab activation). Tab clicks set focus via activate().
      col.addEventListener("mousedown", (e) => {
        if ((e.target as Element).closest(".term-group-tabs")) return;
        this.focusGroup(side);
      });

      return { col, tabList, body };
    };

    const l = buildGroup("left", "term-group-left");
    const r = buildGroup("right", "term-group-right hidden");

    this.groupHosts = { left: l.col, right: r.col };
    this.tabLists = { left: l.tabList, right: r.tabList };
    this.bodyHosts = { left: l.body, right: r.body };
    this.host.append(l.col, r.col);

    void onPtyOutput((p) => {
      const t = this.terms.find((x) => x.id === p.id);
      if (t) t.term.write(b64ToBytes(p.data));
    });
    void onPtyExit((id) => {
      const t = this.terms.find((x) => x.id === id);
      if (t) this.markExited(t);
    });

  }

  /** Re-theme all live sessions after an explicit settings class transaction. */
  retheme(): void {
    retheme(this.terms);
  }

  get count(): number {
    return this.sessionSnapshotOverride?.count ?? this.terms.length;
  }

  /** Number of sessions whose PTY is still alive. */
  liveCount(): number {
    return this.sessionSnapshotOverride?.liveCount ?? this.actualSessionSnapshot().liveCount;
  }

  /** Subscribe to session/liveness transitions; current state is immediate and listener changes apply next transition. */
  onSessionsChanged(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    this.withSessionSnapshot(this.actualSessionSnapshot(), listener);
    return () => this.sessionListeners.delete(listener);
  }

  private notifySessionsChanged(): void {
    this.sessionNotifications.push({ ...this.actualSessionSnapshot(), listeners: [...this.sessionListeners] });
    if (this.drainingSessionNotifications) return;

    this.drainingSessionNotifications = true;
    try {
      while (this.sessionNotifications.length > 0) {
        const notification = this.sessionNotifications.shift()!;
        for (const listener of notification.listeners) {
          this.withSessionSnapshot(notification, listener);
        }
      }
    } finally {
      this.drainingSessionNotifications = false;
    }
  }

  private actualSessionSnapshot(): SessionSnapshot {
    return { count: this.terms.length, liveCount: this.terms.filter((term) => term.alive).length };
  }

  private withSessionSnapshot(snapshot: SessionSnapshot, listener: () => void): void {
    const previous = this.sessionSnapshotOverride;
    this.sessionSnapshotOverride = snapshot;
    try {
      listener();
    } finally {
      this.sessionSnapshotOverride = previous;
    }
  }

  private finishSpawn(t: Term, succeeded: boolean, error?: unknown): void {
    if (!t.spawnPending || !this.terms.includes(t)) return;
    t.spawnPending = false;
    t.alive = succeeded;
    if (!succeeded) t.term.write(`\r\n\x1b[31mfailed to start shell: ${error}\x1b[0m\r\n`);
    this.notifySessionsChanged();
  }

  private markExited(t: Term): void {
    if (!this.terms.includes(t) || (!t.alive && !t.spawnPending)) return;
    t.alive = false;
    t.spawnPending = false;
    t.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    this.renderTabs();
    this.notifySessionsChanged();
  }

  private removeSession(t: Term): boolean {
    const index = this.terms.indexOf(t);
    if (index < 0) return false;
    t.spawnPending = false;
    this.terms.splice(index, 1);
    this.notifySessionsChanged();
    return true;
  }

  private resetSessions(): void {
    for (const term of this.terms) term.spawnPending = false;
    this.terms = [];
    this.active = null;
    this.seq = 0;
    this.notifySessionsChanged();
  }

  private focusGroup(side: TerminalGroupSide): void {
    this.focusedGroup = side;
    const active = this.activeByGroup[side];
    if (active) this.active = active;
    this.renderGroups();
    this.renderTabs();
  }

  private moveToGroup(t: Term, side: TerminalGroupSide): void {
    if (groupSideForItem(this.groups, t) === side) {
      this.activate(t);
      return;
    }
    this.groups = moveItemToGroup(this.groups, t, side);
    this.bodyHosts[side].appendChild(t.el);
    this.activeByGroup[side] = t;
    this.focusedGroup = side;
    this.activate(t);
  }

  private syncGroupHosts(): void {
    for (const side of ["left", "right"] as const) {
      for (const t of this.groups[side]) {
        if (t.el.parentElement !== this.bodyHosts[side]) this.bodyHosts[side].appendChild(t.el);
      }
    }
  }

  private renderGroups(): void {
    this.syncGroupHosts();
    const hasRight = this.groups.right.length > 0;
    this.host.classList.toggle("terminal-split", hasRight);
    // When one group is maximized in split view, keep the other hidden
    if (this.maximizedGroup && hasRight) {
      const other = this.maximizedGroup === 'left' ? 'right' : 'left';
      this.groupHosts[this.maximizedGroup].classList.remove('hidden');
      this.groupHosts[other].classList.add('hidden');
    } else {
      this.groupHosts.right.classList.toggle("hidden", !hasRight);
    }
    // If all right tabs closed while right was maximized, reset maximize state
    if (!hasRight && this.maximizedGroup === 'right') {
      this.maximizedGroup = null;
      this.mainEl.classList.remove('terminal-maximized');
      this.area.style.flex = this.savedFlex;
      this.renderMaximizeButtons();
    }
    this.groupHosts.left.classList.toggle("focused", this.focusedGroup === "left");
    this.groupHosts.right.classList.toggle("focused", this.focusedGroup === "right");
  }

  private refreshActiveByGroup(): void {
    for (const side of ["left", "right"] as const) {
      const active = this.activeByGroup[side];
      if (!active || !this.groups[side].includes(active)) {
        const group = this.groups[side];
        this.activeByGroup[side] = group.length > 0 ? group[group.length - 1] : null;
      }
    }
    if (this.focusedGroup === "right" && this.groups.right.length === 0) this.focusedGroup = "left";
  }

  /** Create and activate a terminal in the requested group, optionally overriding cwd. */
  async create(sideArg?: TerminalGroupSide, cwd?: string): Promise<void> {
    const num = ++this.seq; // display number, resets per workspace
    const id = newPtyId();
    const sessionCwd = cwd ?? this.cwd;
    const term = new Terminal({
      theme: buildTermTheme(),
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      cursorBlink: !this.reducedMotion && !this.blinkPaused,
      scrollback: this.scrollback,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Load search addon.
    const search = new SearchAddon();
    term.loadAddon(search);

    // Load web-links addon; only modifier-clicks activate (Decision 9 — plain click is a no-op),
    // routed by classifyLink to the embedded browser (localhost) or OS browser (external).
    const webLinks = new WebLinksAddon((event: MouseEvent, uri: string) => {
      if (!isMod(event)) return;
      this.onUrlActivate?.(uri, classifyLink(uri));
    });
    term.loadAddon(webLinks);

    const el = document.createElement("div");
    el.className = "term-instance";
    const side = sideArg ?? this.focusedGroup;
    this.bodyHosts[side].appendChild(el);
    term.open(el);
    fit.fit();

    const t: Term = { id, term, fit, el, title: `zsh ${num}`, alive: false, spawnPending: true, agentAttached: false, currentInput: "", cwd: sessionCwd };
    this.terms.push(t);
    this.groups[side].push(t);
    this.activeByGroup[side] = t;
    this.renderGroups();

    // File-path link provider (WebLinksAddon's regex is URL-only): resolves and validates
    // path-ish tokens on the hovered line, surfacing only real files as clickable links.
    term.registerLinkProvider(
      new FileLinkProvider(
        term,
        () => t.cwd,
        () => this.cwd,
        fileMtime,
        (absPath, line) => this.onFileLinkActivate?.(absPath, line),
      ),
    );
    term.onData((d) => {
      // Only track a shell command line while the normal buffer is active.
      // Full-screen programs (vim/less/fzf/htop) switch to the alternate
      // buffer; their keystrokes are not a shell prompt.
      const atPrompt = term.buffer.active.type === "normal";
      const submittedCommand = atPrompt && (d === "\r" || d === "\n") ? t.currentInput : null;
      // Track raw input solely to detect integrated-agent commands at submit.
      if (!atPrompt) {
        // Alt-screen program owns input; leave currentInput untouched.
      } else if (d === "\r" || d === "\n") {
        t.currentInput = "";
      } else if (d === "" || d === "") {
        // Ctrl+C / Ctrl+D: clear input.
        t.currentInput = "";
      } else if (d === "\b" || d === "\x7f") {
        // Backspace: remove last char from input.
        t.currentInput = t.currentInput.slice(0, -1);
      } else if (isControlSequence(d)) {
        // Control byte: readline shortcuts (Ctrl+A/U/K/W) or an ANSI report/function-key
        // sequence (arrows, focus in/out CSI I/O, shift-tab, etc.) — xterm delivers these
        // through the same onData channel as typed text, but they are never literal input.
      } else {
        // Regular char: add to input (simple; doesn't handle cursor movement).
        t.currentInput += d;
      }
      const send = () => void ptyWrite(id, d).catch((e) => console.error("[sutra] ptyWrite failed", id, e));
      if (submittedCommand && this.cwd && isIntegratedAgentCommand(submittedCommand)) {
        t.agentAttached = true;
        this.renderTabs();
        void agentTrackingBegin(this.cwd).then(() => {
          send();
          this.onAgentAttached?.();
        }, () => {
          send();
          this.onAgentAttached?.();
        });
      } else {
        send();
      }
    });

    // Preserve only conventional terminal copy and find overrides.
    term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      const mod = isMod(event);

      // Cmd+C / Ctrl+C: copy selection if present, else let through (sends SIGINT).
      if (mod && event.key === "c") {
        const selection = term.getSelection();
        if (selection) {
          void clipboardWrite(selection).catch(() => {});
          return false; // Swallow event
        }
        return true; // Let SIGINT through
      }

      // Cmd+F / Ctrl+F: open find overlay.
      if (mod && event.key === "f") {
        this.openFindOverlay(search);
        return false;
      }

      return true;
    });

    // Click anywhere in the instance (incl. the wrapper padding xterm's own
    // handler never sees) recovers keyboard focus. WKWebView can leave the
    // helper textarea as document.activeElement while no longer routing keys to
    // it — so a bare focus() (xterm's built-in click handler, or ours) is a
    // no-op and the terminal stays deaf (e.g. vim ignoring i/:). blur()+focus()
    // forces a real refocus that breaks the stale state. stopPropagation avoids
    // a redundant focusGroup() render pass from the group-body mousedown above.
    el.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (this.active !== t) {
        this.activate(t);
      } else {
        this.recoverFocus(t);
      }
    });

    // Right-click context menu.
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [
        {
          label: "Copy",
          action: () => {
            const selection = term.getSelection();
            if (selection) void clipboardWrite(selection).catch(() => {});
          },
        },
        {
          label: "Paste",
          action: () => {
            void clipboardRead()
              .then((text) => term.paste(text))
              .catch(() => {});
          },
        },
        {
          label: "Clear",
          action: () => term.clear(),
        },
        {
          label: "Select All",
          action: () => term.selectAll(),
        },
      ];
      showContextMenu(e.clientX, e.clientY, items, el);
    });

    // fit() can report 0 before first paint; fall back to a sane size.
    const rows = term.rows || 24;
    const cols = term.cols || 80;
    try {
      await ptySpawn(id, cwd ?? this.cwd, rows, cols, this.shellPref);
      this.finishSpawn(t, true);
    } catch (e) {
      this.finishSpawn(t, false, e);
    }
    if (this.terms.includes(t)) this.activate(t);
  }

  /** Strict busy check for one terminal (kernel foreground-pgrp; errors read as idle). */
  private isBusy(t: Term): Promise<boolean> {
    return ptyIsBusy(t.id).catch(() => false);
  }

  /** True when there is no terminal or the active one has a foreground child running. */
  async isActiveBusy(): Promise<boolean> {
    return this.active ? this.isBusy(this.active) : true;
  }

  /**
   * Run a shell command in a free terminal: reuse the active one when it's idle at a
   * prompt, otherwise spawn a fresh terminal (e.g. the only terminal has claude live).
   * Returns the target terminal id so callers can poll its busy state, or null if nothing ran.
   */
  async runCommand(command: string): Promise<string | null> {
    const cmd = command.trim();
    if (!cmd) return null;
    if (!this.active || (await this.isBusy(this.active))) {
      await this.create(); // spawns + activates a new terminal
    } else {
      this.activate(this.active);
    }
    const target = this.active;
    if (!target) return null;
    await ptyWrite(target.id, cmd + "\r").catch(() => {});
    return target.id;
  }

  /** Strict busy check for an arbitrary terminal id (used to poll a running automation). */
  isBusyById(id: string): Promise<boolean> {
    return ptyIsBusy(id).catch(() => false);
  }

  /** Send Ctrl-C to a terminal id so its foreground command (e.g. an automation) stops. */
  interrupt(id: string): void {
    void ptyWrite(id, "\x03").catch(() => {});
  }

  /** Open find overlay with SearchAddon wired to find controls. */
  private openFindOverlay(search: SearchAddon): void {
    // Create a simple find input overlay.
    let overlay = document.querySelector(".term-find-overlay") as HTMLElement | null;
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.className = "term-find-overlay";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find...";
    input.className = "term-find-input";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.className = "term-find-close";

    const close = () => {
      overlay?.remove();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        search.findPrevious(input.value);
      } else if (e.key === "Enter") {
        search.findNext(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    closeBtn.addEventListener("click", close);

    overlay.append(input, closeBtn);
    this.host.appendChild(overlay);
    input.focus();
  }

  activate(t: Term): void {
    const side = groupSideForItem(this.groups, t) ?? this.focusedGroup;
    this.focusedGroup = side;
    this.activeByGroup[side] = t;
    this.active = t;
    for (const groupSide of ["left", "right"] as const) {
      const active = this.activeByGroup[groupSide];
      for (const x of this.groups[groupSide]) x.el.classList.toggle("hidden", x !== active);
    }
    this.renderGroups();
    this.refit();
    this.recoverFocus(t);
    this.renderTabs();
  }

  close(t: Term): void {
    void ptyKill(t.id).catch(() => {});
    t.term.dispose();
    t.el.remove();
    this.removeSession(t);
    const wasActive = this.active === t;
    const side = groupSideForItem(this.groups, t) ?? "left";
    this.groups = removeItemFromGroups(this.groups, t);
    this.groups = collapseAfterClose(this.groups);
    this.refreshActiveByGroup();
    if (wasActive) {
      this.active = null;
      const sideActive = this.activeByGroup[side];
      const next = sideActive ?? this.activeByGroup[this.focusedGroup] ?? this.activeByGroup.left ?? this.activeByGroup.right;
      if (next) this.activate(next);
      else {
        this.renderGroups();
        this.renderTabs();
      }
    } else {
      this.renderGroups();
      this.renderTabs();
    }
  }

  async reset(cwd: string | null, create: boolean): Promise<void> {
    for (const t of this.terms) {
      void ptyKill(t.id).catch(() => {});
      t.term.dispose();
      t.el.remove();
    }
    this.cwd = cwd;
    this.groups = { left: [], right: [] };
    this.activeByGroup = { left: null, right: null };
    this.focusedGroup = "left";
    this.bodyHosts.left.innerHTML = "";
    this.bodyHosts.right.innerHTML = "";
    this.renderGroups();
    this.renderTabs();
    this.resetSessions();
    if (create) await this.create();
  }

  /** Re-measure + tell the PTY the new size. Call after the panel is shown/resized. */
  refit(): void {
    for (const side of ["left", "right"] as const) {
      const active = this.activeByGroup[side];
      if (!active) continue;
      try {
        active.fit.fit();
        void ptyResize(active.id, active.term.rows, active.term.cols).catch(() => {});
      } catch {
        /* host not measurable while hidden */
      }
    }
  }

  /** Current terminal maximize state, suitable for snapshot/restore by layout owners. */
  getMaximizeState(): TerminalMaximizeState {
    return this.maximizedGroup;
  }

  /** Apply an exact maximize state through the same DOM path as the terminal controls. */
  setMaximizeState(next: TerminalMaximizeState): void {
    if (this.maximizedGroup === next) return;
    const inSplit = this.groups.right.length > 0;
    const previous = this.maximizedGroup;

    if (previous !== null && inSplit) {
      const other = previous === "left" ? "right" : "left";
      this.groupHosts[other].classList.remove("hidden");
    }

    if (next === null) {
      this.maximizedGroup = null;
      this.mainEl.classList.remove("terminal-maximized");
      this.area.style.flex = this.savedFlex;
    } else {
      if (previous === null) this.savedFlex = this.area.style.flex;
      this.maximizedGroup = next;
      this.area.style.flex = "";
      this.mainEl.classList.add("terminal-maximized");
      if (inSplit) {
        const other = next === "left" ? "right" : "left";
        this.groupHosts[other].classList.add("hidden");
      }
    }
    this.renderMaximizeButtons();
    this.refit();
  }

  /** Toggle maximize for a specific group; in split view only that group expands. */
  toggleMaximize(side: TerminalGroupSide): void {
    this.setMaximizeState(this.maximizedGroup === side ? null : side);
  }

  /** Update maximize button icons per group based on current maximized state. */
  private renderMaximizeButtons(): void {
    for (const side of ["left", "right"] as const) {
      const btn = this.maximizeBtns[side];
      if (!btn) continue;
      const isMax = this.maximizedGroup === side;
      btn.title = isMax ? 'Restore terminal' : 'Maximize terminal';
      btn.innerHTML = icon(isMax ? 'compress' : 'expand', 14, 1.6);
    }
  }

  focusActive(): void {
    const t = this.active;
    if (!t) return;
    this.recoverFocus(t);
  }

  /** Force WKWebView to re-route keys, but never steal focus into display:none. */
  private recoverFocus(t: Term): boolean {
    // offsetParent is null under any display:none ancestor.
    if (!t.term.element || t.term.element.offsetParent === null) return false;
    t.term.blur();
    t.term.focus();
    return true;
  }

  /** Apply terminal font size to current and future terminal sessions. */
  setFontSize(size: number): void {
    this.fontSize = size;
    for (const t of this.terms) {
      t.term.options.fontSize = size;
    }
    this.refit();
  }

  /** Apply terminal font family to current and future terminal sessions. */
  setFontFamily(family: string): void {
    this.fontFamily = family;
    for (const t of this.terms) {
      t.term.options.fontFamily = family;
    }
    this.refit();
  }

  /** Apply terminal scrollback depth to current and future terminal sessions. */
  setScrollback(lines: number): void {
    this.scrollback = lines;
    for (const t of this.terms) {
      t.term.options.scrollback = lines;
    }
  }

  /** Pause cursor blink across every terminal while the window is hidden; the
   *  window-idle gate calls this so xterm stops repainting the cursor off-screen.
   *  Reduced-motion users never blink regardless of this flag. */
  setBlinkPaused(paused: boolean): void {
    if (this.blinkPaused === paused) return;
    this.blinkPaused = paused;
    const on = !this.reducedMotion && !this.blinkPaused;
    for (const t of this.terms) {
      t.term.options.cursorBlink = on;
    }
  }

  /** Apply shell preference to future terminal sessions; null uses system $SHELL. */
  setShellPreference(shell: string | null): void {
    if (this.shellPref === shell) return;
    this.shellPref = shell;
  }

  private renderTabs(): void {
    for (const side of ["left", "right"] as const) {
      this.tabLists[side].innerHTML = "";
      for (const t of this.groups[side]) {
        const tab = document.createElement("div");
        tab.dataset.side = side;
        tab.className =
          "term-tab" +
          (t === this.activeByGroup[side] ? " active" : "") +
          (side === this.focusedGroup ? " focused" : "");
        tab.addEventListener("pointerdown", (e) => {
          if ((e.target as Element).closest(".term-close")) return;
          beginSplitPointerDrag({
            event: e,
            source: tab,
            target: this.area,
            onDrop: (targetSide) => this.moveToGroup(t, targetSide),
          });
        });
        const label = document.createElement("span");
        label.textContent = t.title + (t.alive || t.spawnPending ? "" : " (exited)");
        tab.onclick = () => this.activate(t);
        if (t === this.activeByGroup[side]) {
          const ti = document.createElement("span");
          ti.className = "term-tab-icon";
          ti.innerHTML = icon("terminal", 13, 1.7);
          tab.appendChild(ti);
        }
        if (t.agentAttached) {
          const dot = document.createElement("span");
          dot.className = "term-agent-dot";
          dot.title = "Integrated agent attached";
          tab.appendChild(dot);
        }
        const close = document.createElement("button");
        close.className = "term-close";
        close.textContent = "×";
        close.onclick = (e) => {
          e.stopPropagation();
          this.close(t);
        };
        tab.append(label, close);
        this.tabLists[side].append(tab);
      }
    }
    this.onTabsChanged?.();
  }
}
