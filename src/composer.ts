// Docked prompt-composer panel: template picker, section inputs, chip rail,
// agent target selector, draft persistence, send flow.
// "Focus" layout: two heroes — Context (owns @file / /skill / +selection
// completion and the chip rail) and Task — render first, in role→context→
// task→rest order (task is not hoisted ahead of context); Preview / History
// are slide-up drawers that overlay the scroll area (so they can't be
// squeezed off when the terminal drawer steals panel height).
import { ask } from "@tauri-apps/plugin-dialog";
import { templateTags, resolveConfig, type TagConfig } from "./prompt-tags";
import { loadAgentProfiles, resolveAgentProfiles, type AgentProfile } from "./agent-profiles";
import { buildPrompt, defaultSection, type Chip, type RoutedChip } from "./prompt-builder";
import { orderSections, isFirstRunDraft, clampDrawerHeight } from "./composer-layout";
import { matchFiles, matchAssets, assetToken, completionContext, type AssetOption } from "./composer-complete";
import {
  saveDraft, loadDraft, clearDraft, loadHistory, saveHistory, pushHistory,
  profileDefaults, isEmptyDraftContent, withTemplateTag,
  type Draft, type HistoryEntry,
} from "./composer-store";
import {
  readFile, scanAgentAssets, ptyListAgents, deliverToPty,
  type AgentTerminal, type AgentAsset,
} from "./ipc";
import { icon } from "./icons";
import { mountTagManager } from "./tag-manager";
import { IS_MAC } from "./shortcuts";
import { readUiState, patchUiState } from "./terminal-groups";
import { isWorkspaceTrusted } from "./workspace";

/** Native confirm via the dialog plugin — window.confirm is unreliable in
 * WKWebView (mirrors main.ts's confirmNative). */
function confirmNative(msg: string): Promise<boolean> {
  return ask(msg, { title: "Sutra", kind: "warning" });
}

const TRUST_KEY = (root: string) => `composer-trusted:${root}`;
const TAGS_PATH = (root: string) => `${root}/.sutra/prompt-tags.json`;
// Drawer height is a UI preference shared across roots/panels, persisted in
// the backend ui-state store (composerDrawerH field, see terminal-groups.ts).
// This legacy localStorage key is only read once, at app boot (main.ts), to
// seed that store.
export const LEGACY_DRAWER_H_KEY = "composer-drawer-h";
const DRAWER_H_MIN = 120;

export interface ComposerOptions {
  root: string;
  /** Hint from caller; actual trust is also checked in localStorage. */
  trusted: boolean;
  container: HTMLElement;
  getFiles: () => Promise<string[]>;
  getSelection: () => {
    path: string | null; text: string;
    line: number; endLine: number; lang: string;
  };
}

export interface ComposerTaskDraft {
  /** Fully rendered prompt, including the current template/context chips. */
  prompt: string;
  /** A useful editable starting title; the task panel never sends on create. */
  title: string;
}

export type ComposerDeliveryResult = { ok: true } | { ok: false; reason: string };

export function mountComposer(opts: ComposerOptions): {
  toggle: () => void;
  show: () => void;
  hide: () => void;
  /** Trusted profile guidance loaded for this workspace; P2 renders the picker. */
  getProfiles: () => readonly AgentProfile[];
  /** Snapshot the current draft for task creation without delivering it. */
  getTaskDraft: () => ComposerTaskDraft | null;
  /** Reuse the composer delivery seam for task Start (Stage or Submit). */
  deliverTaskPrompt: (args: { targetId: string; prompt: string; submit: boolean }) => Promise<ComposerDeliveryResult>;
  pausePolling: () => void;
  resumePolling: () => void;
  dispose: () => void;
} {
  const { root, container, getFiles, getSelection } = opts;

  // ── helpers ─────────────────────────────────────────────────────────────────
  function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function mkBtn(cls: string, html: string): HTMLButtonElement {
    const b = mk("button", cls);
    b.innerHTML = html;
    return b;
  }
  function basename(p: string): string {
    return p.split(/[/\\]/).pop() ?? p;
  }

  // ── state ────────────────────────────────────────────────────────────────────
  let trusted = localStorage.getItem(TRUST_KEY(root)) === "1" || opts.trusted;
  let config: TagConfig = resolveConfig({ rawJson: null, trusted: false });
  // P2 exposes these as the profile picker. Loading them now keeps the same
  // trusted-config boundary as prompt tags without changing delivery behavior.
  let profiles: readonly AgentProfile[] = resolveAgentProfiles({ rawJson: null, trusted: false, automationIds: [] });
  let assets: AgentAsset[] = [];
  let agents: AgentTerminal[] = [];
  let history: HistoryEntry[] = loadHistory(root);
  let chips: RoutedChip[] = [];
  let draggingChip: number | null = null;
  let text: Record<string, string> = {};
  let templateName = "";
  let targetId: string | null = null;
  // Selected agent profile id, or null. GUIDANCE ONLY: a profile pre-fills a
  // new draft's template + default acceptance rows; it never restricts what
  // can be sent or grants command/automation execution (that stays owned by
  // workspace trust + the task's own allowed-automations list elsewhere).
  let profileId: string | null = null;
  let thinking = false;
  let submit = false;
  let visible = false;
  let pollTimer: number | undefined;
  let lastAgentsSig = ""; // last polled agent-list signature; skip rebuild if unchanged
  let ctxCount: HTMLElement | null = null;
  let prevOpen = false;
  let histOpen = false;

  interface CompletionState {
    id: "context" | "task";
    triggers: Array<"@" | "/">;
    area: HTMLTextAreaElement | null;
    suggestEl: HTMLDivElement;
    items: string[];
    active: number;
    start: number;
  }
  const ctxComp: CompletionState = {
    id: "context", triggers: ["@"], area: null,
    suggestEl: mk("div", "cmp-suggest hidden"), items: [], active: 0, start: 0,
  };
  const taskComp: CompletionState = {
    id: "task", triggers: ["@", "/"], area: null,
    suggestEl: mk("div", "cmp-suggest hidden"), items: [], active: 0, start: 0,
  };

  // ── DOM ──────────────────────────────────────────────────────────────────────
  container.innerHTML = "";

  // Header (target picker + history + tag-manager)
  const toolbar = mk("div", "cmp-toolbar");
  const targetSel = mk("select", "cmp-target");
  const stateDot = mk("span", "cmp-state-dot");
  // Profile picker: guidance only, never enforcement — see the profileId
  // comment above and onProfileChange below for what "guidance" means here.
  const profileSel = mk("select", "cmp-profile");
  profileSel.title = "Agent profile — sets defaults for a new task draft only; never restricts sending or runs a command.";
  const profileHint = mk("span", "cmp-profile-hint");
  profileHint.textContent = "guidance";
  profileHint.title = "Profiles are guidance, not enforcement: they pre-fill a fresh draft's template + acceptance rows. They do not grant command or automation authority.";
  const histToggleBtn = mkBtn("cmp-icon-btn sbtn", icon("list", 13));
  histToggleBtn.title = "History";
  const gearBtn = mkBtn("cmp-gear sbtn", icon("settings", 13));
  gearBtn.title = "Tag manager";
  toolbar.append(targetSel, stateDot, profileSel, profileHint, histToggleBtn, gearBtn);

  // Trust banner
  const trustBanner = mk("div", "cmp-trust-banner hidden");
  const trustMsg = mk("span", "");
  trustMsg.textContent = "Custom tags disabled — workspace not trusted.";
  const trustBtn = mkBtn("cmp-trust-btn", "Trust workspace");
  trustBanner.append(trustMsg, trustBtn);

  // Template bar
  const tmplBar = mk("div", "cmp-template-bar");

  // Main area: scrollable sections + overlay drawers (position anchor)
  const mainWrap = mk("div", "cmp-main");
  const sectionsEl = mk("div", "cmp-sections");
  // Chip rail (rendered directly under the context hero)
  const chipRail = mk("div", "cmp-chip-rail");
  // Standalone "+ selection" row — sits between the Context hero and the chip
  // rail (or, if the template has no Context section, just before the chip
  // rail). Built once and repositioned in renderSections(), not recreated.
  const selRow = mk("div", "cmp-sel-row");
  const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
  selBtn.title = "Insert current editor selection as a context chip";
  selBtn.onclick = addSelectionChip;
  selRow.appendChild(selBtn);

  // Onboarding whisper — shown only on a fresh, empty draft.
  const onboardEl = mk("div", "cmp-onboard hidden");
  const chord = IS_MAC ? "⌘↵" : "Ctrl+↵";
  onboardEl.innerHTML =
    '<div class="cmp-onboard-row"><span class="cmp-onboard-n">1</span><span>Pick a <b>template</b> — it sets which sections show.</span></div>' +
    '<div class="cmp-onboard-row"><span class="cmp-onboard-n">2</span><span>Attach files/skills in <b>Context</b> (<b>@</b> file, <b>/</b> skill, <b>+ selection</b>). Write the ask in <b>Task</b>.</span></div>' +
    `<div class="cmp-onboard-row"><span class="cmp-onboard-n">3</span><span>Choose an <b>agent terminal</b> above, then <b>${chord}</b> to send.</span></div>`;

  // Preview drawer
  const prevPeek = mk("div", "cmp-peek");
  const prevGrab = mk("div", "cmp-peek-grab");
  prevGrab.dataset.drag = "prev";
  prevGrab.appendChild(mk("div", "cmp-peek-grabbar"));
  const prevHead = mk("div", "cmp-peek-h");
  const prevTitle = mk("span", "cmp-peek-title");
  prevTitle.textContent = "Preview";
  const prevClose = mkBtn("cmp-peek-close", "×");
  prevHead.append(prevTitle, prevClose);
  const previewPre = mk("pre", "cmp-peek-body cmp-preview-pre");
  prevPeek.append(prevGrab, prevHead, previewPre);

  // History drawer
  const histPeek = mk("div", "cmp-peek");
  const histGrab = mk("div", "cmp-peek-grab");
  histGrab.dataset.drag = "hist";
  histGrab.appendChild(mk("div", "cmp-peek-grabbar"));
  const histHead = mk("div", "cmp-peek-h");
  const histTitle = mk("span", "cmp-peek-title");
  histTitle.textContent = "History";
  const histClose = mkBtn("cmp-peek-close", "×");
  histHead.append(histTitle, histClose);
  const histList = mk("div", "cmp-peek-body cmp-hist-list");
  histPeek.append(histGrab, histHead, histList);

  mainWrap.append(sectionsEl, prevPeek, histPeek);

  // Action bar (pinned footer): Preview toggle + send mode + Send
  const actionBar = mk("div", "cmp-action-bar");
  const prevBtn = mkBtn("cmp-preview-btn", `${icon("chevronDown", 12)} Preview`);
  const modeGrp = mk("div", "cmp-mode-grp");
  const stageLbl = mk("label", "cmp-radio-lbl");
  const stageInp = mk("input", "");
  stageInp.type = "radio"; stageInp.name = "cmp-send-mode"; stageInp.value = "stage"; stageInp.checked = true;
  stageLbl.append(stageInp, " Stage");
  const submitLbl = mk("label", "cmp-radio-lbl");
  const submitInp = mk("input", "");
  submitInp.type = "radio"; submitInp.name = "cmp-send-mode"; submitInp.value = "submit";
  submitLbl.append(submitInp, " Submit");
  const thinkLbl = mk("label", "cmp-radio-lbl cmp-think-lbl");
  const thinkInp = mk("input", "");
  thinkInp.type = "checkbox";
  thinkLbl.append(thinkInp, " Think");
  modeGrp.append(stageLbl, submitLbl, thinkLbl);
  const sendBtn = mkBtn("cmp-send", `Send ${IS_MAC ? "⌘" : "Ctrl+"}↵`);
  actionBar.append(prevBtn, modeGrp, sendBtn);

  // Status / error
  const statusBar = mk("div", "cmp-status hidden");

  container.append(toolbar, trustBanner, tmplBar, mainWrap, actionBar, statusBar);

  // ── init ─────────────────────────────────────────────────────────────────────
  void init();

  async function init(): Promise<void> {
    await applyDrawerHeight();
    await Promise.all([reloadConfig(), reloadProfiles(), refreshAgents(), refreshAssets()]);
    const saved = loadDraft(root);
    if (saved) applyDraft(saved);
    else templateName = config.templates[0]?.name ?? "";
    renderAll();
  }

  async function reloadConfig(): Promise<void> {
    const rawJson = await readFile(TAGS_PATH(root)).catch(() => null);
    config = resolveConfig({ rawJson, trusted });
  }

  async function reloadProfiles(): Promise<void> {
    profiles = await loadAgentProfiles(root, { isTrusted: isWorkspaceTrusted, readFile });
  }

  async function refreshAgents(): Promise<void> {
    agents = await ptyListAgents().catch(() => []);
  }

  async function refreshAssets(): Promise<void> {
    assets = await scanAgentAssets(root).catch(() => []);
  }

  // ── render ────────────────────────────────────────────────────────────────────
  function renderAll(): void {
    renderTrustBanner();
    renderTemplateBar();
    renderSections();
    renderChips();
    renderTargetPicker();
    renderProfilePicker();
    renderPreview();
    renderHistory();
  }

  function renderTrustBanner(): void {
    trustBanner.classList.toggle("hidden", trusted);
  }

  function renderTemplateBar(): void {
    tmplBar.innerHTML = "";
    if (!templateName && config.templates[0]) templateName = config.templates[0].name;
    for (const t of config.templates) {
      const b = mkBtn(`cmp-tmpl-btn${t.name === templateName ? " active" : ""}`, t.name);
      b.onclick = () => {
        templateName = t.name;
        renderTemplateBar();
        renderSections();
        renderChips();
        renderPreview();
        autosave();
      };
      tmplBar.appendChild(b);
    }
  }

  // Build one section wrapper and append it to sectionsEl.
  function renderSection(tag: { id: string; label: string; input: string; default: string; placeholder: string }): void {
    const isCtx = tag.id === "context";
    const isTask = tag.id === "task";
    const isHero = isCtx || isTask;
    const wrap = mk("div", `cmp-section${isHero ? " cmp-hero" : ""}`);
    wrap.dataset.section = tag.id;
    // Chip drop target (re-route on drop) — unchanged behaviour.
    wrap.addEventListener("dragover", (e) => {
      if (draggingChip === null) return;
      e.preventDefault();
      wrap.classList.add("cmp-drop-over");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("cmp-drop-over"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      wrap.classList.remove("cmp-drop-over");
      if (draggingChip !== null && chips[draggingChip]) {
        chips[draggingChip].section = tag.id;
        draggingChip = null;
        renderChips();
        renderPreview();
        autosave();
      }
    });

    const lbl = mk("div", "cmp-section-lbl");
    lbl.textContent = isCtx ? "Context" : isTask ? "Task" : tag.label;
    if (isHero) {
      const count = mk("span", "cmp-hero-count");
      lbl.appendChild(count);
      if (isCtx) ctxCount = count; else taskCountEl(count);
    }
    wrap.appendChild(lbl);

    if (tag.input === "text" && !isHero) {
      const inp = mk("input", "cmp-section-input cmp-section-text");
      inp.type = "text";
      inp.placeholder = tag.placeholder ?? "";
      inp.value = text[tag.id] ?? tag.default ?? "";
      inp.oninput = () => { text[tag.id] = inp.value; renderPreview(); autosave(); };
      wrap.appendChild(inp);
      sectionsEl.appendChild(wrap);
      return;
    }

    // Context and Task each own their own completion independently now —
    // Context is @file-only, Task is @file + /skill.
    const comp: CompletionState | null = isCtx ? ctxComp : isTask ? taskComp : null;

    const ta = mk("textarea", "cmp-section-input");
    ta.placeholder = tag.placeholder || tag.label;
    ta.value = text[tag.id] ?? tag.default ?? "";
    ta.rows = isHero ? 5 : 3;
    ta.oninput = () => {
      text[tag.id] = ta.value;
      renderPreview();
      autosave();
      if (comp) { handleCompletion(ta, comp); }
      if (isHero) { updateHeroCounts(); updateOnboard(); }
    };
    ta.onkeydown = (e) => { if (comp) onCompleteKeydown(e, comp); else onHeroKeydown(e); };
    wrap.appendChild(ta);
    if (comp) comp.area = ta;

    if (isCtx) {
      const hint = mk("div", "cmp-complete-hint");
      hint.textContent = "@ file";
      wrap.appendChild(hint);
    } else if (isTask) {
      const hint = mk("div", "cmp-complete-hint");
      hint.textContent = "@ file · / skill · plain prose";
      wrap.appendChild(hint);
    }
    sectionsEl.appendChild(wrap);
  }

  // Late-bound so renderSection can assign either hero's count element.
  let taskCount: HTMLElement | null = null;
  function taskCountEl(el: HTMLElement): void { taskCount = el; }

  function updateHeroCounts(): void {
    if (taskCount) taskCount.textContent = `${(text["task"] ?? "").length} chars`;
    if (ctxCount) {
      // Only chips routed to Context count here — some route to Task.
      const n = chips.filter((c) => c.section === "context").length;
      ctxCount.textContent = n ? `${n} attached` : "";
    }
  }

  function renderSections(): void {
    sectionsEl.innerHTML = "";
    ctxComp.area = null; taskComp.area = null; taskCount = null; ctxCount = null;
    sectionsEl.appendChild(onboardEl);
    const ordered = orderSections(templateTags(config, templateName));
    let placedCtx = false;
    for (const tag of ordered) {
      renderSection(tag);
      // Each hero's own suggestion dropdown sits directly under it; the
      // standalone selection row + chip rail sit directly under Context.
      if (tag.id === "context") {
        sectionsEl.appendChild(ctxComp.suggestEl);
        sectionsEl.appendChild(selRow);
        sectionsEl.appendChild(chipRail);
        placedCtx = true;
      } else if (tag.id === "task") {
        sectionsEl.appendChild(taskComp.suggestEl);
      }
    }
    if (!placedCtx) {
      // No context section — keep the selection row + chip rail reachable
      // at the end, so selection chips stay attachable.
      sectionsEl.appendChild(selRow);
      sectionsEl.appendChild(chipRail);
    }
    updateHeroCounts();
    updateOnboard();
  }

  // First run: nothing written and no chips attached yet.
  function isFirstRun(): boolean {
    const written = (text["task"] ?? "").trim() + (text["context"] ?? "").trim();
    return isFirstRunDraft(written, chips.length);
  }

  function updateOnboard(): void {
    onboardEl.classList.toggle("hidden", !isFirstRun());
  }

  // Send needs a target terminal; reflect that on the button.
  function updateSendState(): void {
    sendBtn.disabled = !targetId;
    sendBtn.title = targetId ? "" : "No agent terminal — open one to send.";
  }

  function renderChips(): void {
    chipRail.querySelectorAll(".cmp-chip").forEach((e) => e.remove());
    chips.forEach((rc, i) => {
      const pill = mk("span", "cmp-chip");
      pill.textContent = chipLabel(rc.chip) + " ";
      pill.draggable = true;
      pill.title = `routed to <${rc.section}> — drag onto a section to re-route`;
      pill.addEventListener("dragstart", () => { draggingChip = i; });
      pill.addEventListener("dragend", () => {
        draggingChip = null;
        sectionsEl.querySelectorAll(".cmp-drop-over").forEach((el) => el.classList.remove("cmp-drop-over"));
      });
      const x = mkBtn("cmp-chip-x", "×");
      x.onclick = () => { chips.splice(i, 1); renderChips(); renderPreview(); autosave(); };
      pill.appendChild(x);
      chipRail.appendChild(pill);
    });
    updateHeroCounts();
    updateOnboard();
  }

  function renderTargetPicker(): void {
    const prev = targetSel.value;
    targetSel.innerHTML = "";
    if (agents.length === 0) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = "No agent terminals";
      targetSel.appendChild(o);
      targetId = null;
    } else {
      for (const a of agents) {
        const o = document.createElement("option");
        o.value = a.id;
        o.textContent = `${a.kind}${a.cwd ? " — " + basename(a.cwd) : ""} [${a.state}]`;
        targetSel.appendChild(o);
      }
      if (prev && agents.find((a) => a.id === prev)) targetSel.value = prev;
      targetId = targetSel.value || null;
    }
    updateStateDot();
    updateSendState();
  }

  function updateStateDot(): void {
    const st = agents.find((a) => a.id === targetId)?.state ?? "unknown";
    stateDot.className = `cmp-state-dot cmp-state-${st}`;
    stateDot.title = st;
  }

  // P2 picker: renders profiles loaded by P1's reloadProfiles(). "No profile"
  // is always the first, default-selected option — profiles are opt-in.
  function renderProfilePicker(): void {
    profileSel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No profile";
    profileSel.appendChild(none);
    for (const p of profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      profileSel.appendChild(o);
    }
    profileSel.value = profileId && profiles.some((p) => p.id === profileId) ? profileId : "";
    updateProfileHint();
  }

  // "Context choices" (AgentProfile.contextSelectors) have no safe way to
  // become real prompt content here: resolving git-changes / task-evidence /
  // unresolved-annotations needs IPC surfaces this composer doesn't own
  // (getFiles/getSelection only), and stamping the raw selector names into
  // the <context> tag would pollute the actual prompt sent to the agent with
  // meta-instructions instead of content. So they're surfaced as a guidance
  // tooltip on the profile picker instead of applied to the draft's text —
  // deliberately UI-only, matching "GUIDANCE, not enforcement".
  function updateProfileHint(): void {
    const profile = profiles.find((p) => p.id === profileId) ?? null;
    profileHint.textContent = "guidance";
    profileHint.title = profile
      ? `"${profile.name}" is guidance, not enforcement — it does not restrict actions or auto-run commands. Suggested context: ${profile.contextSelectors.join(", ") || "none"}.`
      : "Profiles are guidance, not enforcement: they pre-fill a fresh draft's template + acceptance rows. They do not grant command or automation authority.";
  }

  // Selecting a profile only ever touches local draft state (templateName,
  // text, profileId) — it never calls deliverTaskPrompt/deliverToPty or any
  // automation runner. This is what guarantees the "Explore" profile (and
  // every other profile) can never invoke a command from the composer: there
  // is simply no code path from this function to command execution.
  async function onProfileChange(id: string | null): Promise<void> {
    const profile = id ? profiles.find((p) => p.id === id) ?? null : null;
    if (!profile) {
      profileId = null;
      autosave();
      renderProfilePicker();
      return;
    }
    const defaults = profileDefaults(profile);
    const fresh = isEmptyDraftContent(text, chips.length);
    if (fresh) {
      applyProfileDefaults(defaults);
    } else {
      // Non-fresh draft = work already in progress (an "existing task" per
      // the acceptance criteria) — never silently overwrite it. Open-question
      // default: ask for confirmation rather than guessing. Declining keeps
      // the profile selected (for future new drafts / history) without
      // touching the current text.
      const confirmed = await confirmNative(
        `Apply "${profile.name}" defaults (template + acceptance criteria) to this draft? This may replace text you've already written.`,
      );
      if (confirmed) applyProfileDefaults(defaults);
    }
    profileId = profile.id;
    renderAll();
    autosave();
  }

  function applyProfileDefaults(defaults: ReturnType<typeof profileDefaults>): void {
    templateName = defaults.templateName;
    // Without this, a profile's stamped acceptance rows can sit in `text`
    // but never render in the UI or reach the built prompt, because the
    // profile's mapped template doesn't always carry a "success_criteria"
    // tag (see withTemplateTag's doc comment in composer-store.ts).
    if (defaults.text.success_criteria) config = withTemplateTag(config, templateName, "success_criteria");
    text = { ...text, ...defaults.text };
  }

  // ── drawers (preview / history) ────────────────────────────────────────────────
  async function applyDrawerHeight(): Promise<void> {
    const ui = await readUiState();
    const h = `${ui.composerDrawerH}px`;
    prevPeek.style.height = h;
    histPeek.style.height = h;
  }

  function openPreview(open: boolean): void {
    prevOpen = open;
    if (open) { histOpen = false; histPeek.classList.remove("open"); }
    prevPeek.classList.toggle("open", open);
    prevBtn.classList.toggle("active", open);
    if (open) renderPreview();
  }

  function openHistory(open: boolean): void {
    histOpen = open;
    if (open) { prevOpen = false; prevPeek.classList.remove("open"); prevBtn.classList.remove("active"); }
    histPeek.classList.toggle("open", open);
    if (open) renderHistory();
  }

  function renderPreview(): void {
    if (!prevOpen) return;
    const p = safeBuildPrompt();
    previewPre.textContent = p?.trim() ? p : "Nothing to preview — write the ask first.";
  }

  function renderHistory(): void {
    histList.innerHTML = "";
    const entries = history.slice(0, 10);
    if (entries.length === 0) {
      const empty = mk("div", "cmp-hist-empty");
      empty.textContent = "No history yet.";
      histList.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const item = mk("div", "cmp-hist-item");
      const ts = new Date(entry.ts).toLocaleTimeString();
      const preview = entry.finalPrompt.slice(0, 60).replace(/\n/g, " ");
      item.textContent = `${ts} — ${preview}…`;
      item.title = entry.finalPrompt;
      item.onclick = () => { applyDraft(entry.draft); renderAll(); autosave(); };
      histList.appendChild(item);
    }
  }

  // Drag the drawer grab handle to resize; height persists globally.
  let dragEl: HTMLElement | null = null;
  let dragStartY = 0;
  let dragStartH = 0;
  let dragMax = 0;

  function onDrawerDown(e: PointerEvent): void {
    const grab = e.currentTarget as HTMLElement;
    dragEl = grab.dataset.drag === "prev" ? prevPeek : histPeek;
    dragStartY = e.clientY;
    dragStartH = dragEl.getBoundingClientRect().height;
    dragMax = Math.round(mainWrap.getBoundingClientRect().height * 0.9);
    dragEl.classList.add("cmp-peek-dragging");
    e.preventDefault();
    window.addEventListener("pointermove", onDrawerMove);
    window.addEventListener("pointerup", onDrawerUp);
  }

  function onDrawerMove(e: PointerEvent): void {
    if (!dragEl) return;
    const dy = dragStartY - e.clientY;
    const h = clampDrawerHeight(dragStartH + dy, DRAWER_H_MIN, dragMax);
    dragEl.style.height = `${h}px`;
  }

  function onDrawerUp(): void {
    if (dragEl) {
      const h = parseInt(dragEl.style.height, 10);
      if (Number.isFinite(h)) void patchUiState({ composerDrawerH: h }).catch(() => {});
      dragEl.classList.remove("cmp-peek-dragging");
      void applyDrawerHeight(); // keep both drawers in sync
      dragEl = null;
    }
    window.removeEventListener("pointermove", onDrawerMove);
    window.removeEventListener("pointerup", onDrawerUp);
  }

  prevGrab.addEventListener("pointerdown", onDrawerDown);
  histGrab.addEventListener("pointerdown", onDrawerDown);

  // ── @ / / completion (independent per hero: ctxComp is @-only, taskComp is @+/) ─
  function handleCompletion(ta: HTMLTextAreaElement, comp: CompletionState): void {
    const ctx = completionContext(ta.value, ta.selectionStart);
    if (!ctx || !comp.triggers.includes(ctx.trigger)) { hideSuggest(comp); return; }
    comp.start = ctx.start;
    if (ctx.trigger === "@") {
      void getFiles()
        .then((files) => {
          const matches = matchFiles(ctx.query, files);
          showSuggest(comp, matches.map((f) => basename(f)), matches.map((f) => `@${f}`));
        })
        .catch(() => hideSuggest(comp));
    } else {
      const aopts: AssetOption[] = assets.map((a) => ({ kind: a.kind, name: a.name, invocation: a.invocation }));
      const matches = matchAssets(ctx.query, aopts);
      showSuggest(comp, matches.map((a) => `${a.name} (${a.kind})`), matches.map((a) => assetToken(a)));
    }
  }

  function showSuggest(comp: CompletionState, labels: string[], tokens: string[]): void {
    comp.suggestEl.innerHTML = "";
    if (!labels.length) { hideSuggest(comp); return; }
    comp.items = tokens;
    comp.active = 0;
    labels.forEach((lbl, i) => {
      const item = mk("div", `cmp-suggest-item${i === 0 ? " active" : ""}`);
      item.textContent = lbl;
      item.onmousedown = (e) => { e.preventDefault(); pickSuggestion(comp, tokens[i]); };
      comp.suggestEl.appendChild(item);
    });
    comp.suggestEl.classList.remove("hidden");
  }

  function hideSuggest(comp: CompletionState): void {
    comp.suggestEl.classList.add("hidden");
  }

  function pickSuggestion(comp: CompletionState, token: string): void {
    if (!comp.area) return;
    const pos = comp.area.selectionStart;
    const before = comp.area.value.slice(0, comp.start);
    const after = comp.area.value.slice(pos);
    comp.area.value = before + token + " " + after;
    const newPos = before.length + token.length + 1;
    comp.area.setSelectionRange(newPos, newPos);
    text[comp.id] = comp.area.value;
    hideSuggest(comp);
    updateHeroCounts();
    renderPreview();
    autosave();
  }

  function onCompleteKeydown(e: KeyboardEvent, comp: CompletionState): void {
    if (!comp.suggestEl.classList.contains("hidden")) {
      const items = comp.suggestEl.querySelectorAll<HTMLElement>(".cmp-suggest-item");
      if (e.key === "ArrowDown") { e.preventDefault(); comp.active = Math.min(comp.active + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle("active", i === comp.active)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); comp.active = Math.max(comp.active - 1, 0); items.forEach((it, i) => it.classList.toggle("active", i === comp.active)); return; }
      if (e.key === "Enter" || e.key === "Tab") { const token = comp.items[comp.active]; if (token !== undefined) { e.preventDefault(); pickSuggestion(comp, token); return; } }
      if (e.key === "Escape") { hideSuggest(comp); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); }
  }

  function onHeroKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); }
  }

  // ── send ──────────────────────────────────────────────────────────────────────
  async function onSend(): Promise<void> {
    if (!targetId) { showStatus("No agent terminal selected."); return; }
    const prompt = safeBuildPrompt();
    if (!prompt?.trim()) { showStatus("Nothing to send."); return; }
    sendBtn.disabled = true;
    clearStatus();

    const result = await deliverTaskPrompt({ targetId, prompt, submit });
    sendBtn.disabled = false;

    if (result.ok) {
      const entry: HistoryEntry = { draft: captureDraft(), finalPrompt: prompt, ts: Date.now() };
      history = pushHistory(history, entry);
      saveHistory(root, history);
      clearDraft(root);
      resetComposerState();
      renderAll();
    } else {
      showStatus(result.reason);
    }
  }

  // Full reset after a successful stage/submit — the composer returns to the
  // same blank state as a fresh, draft-less open (mirrors init()'s no-saved-
  // draft branch). Never called on a failed send — result.reason is shown
  // instead and the typed prompt stays intact for retry.
  function resetComposerState(): void {
    templateName = config.templates[0]?.name ?? "";
    text = {};
    chips = [];
    thinking = false;
    submit = false;
    // Profile selection does not survive a send — the next draft starts
    // unprofiled, same as a fresh composer open (init()'s no-saved-draft
    // branch). History still remembers which profile produced a past prompt
    // via the saved draft's profileId.
    profileId = null;
    stageInp.checked = true;
    submitInp.checked = false;
    thinkInp.checked = false;
    targetSel.value = "";
  }

  // ── draft ─────────────────────────────────────────────────────────────────────
  function captureDraft(): Draft {
    return { templateName, text: { ...text }, chips: [...chips], targetId, thinking, profileId };
  }

  function taskTitle(prompt: string): string {
    const title = (text["task"] ?? "").trim().split(/\r?\n/, 1)[0]?.trim();
    return title || prompt.trim().split(/\r?\n/, 1)[0]?.trim() || "Untitled task";
  }

  function getTaskDraft(): ComposerTaskDraft | null {
    const prompt = safeBuildPrompt();
    if (!prompt?.trim()) return null;
    return { prompt, title: taskTitle(prompt) };
  }

  async function deliverTaskPrompt(args: { targetId: string; prompt: string; submit: boolean }): Promise<ComposerDeliveryResult> {
    // Keep every task delivery on the same revalidated bracketed-paste path as
    // the composer. This performs one delivery attempt; callers own retries.
    return deliverToPty({ targetId: args.targetId, text: args.prompt, submit: args.submit });
  }

  function applyDraft(d: Draft): void {
    templateName = (d.templateName || config.templates[0]?.name) ?? "";
    text = { ...d.text };
    chips = [...d.chips];
    targetId = d.targetId;
    thinking = d.thinking;
    // Tolerant of drafts/history saved before profileId existed.
    profileId = d.profileId ?? null;
    submit = false;
    stageInp.checked = true;
    thinkInp.checked = thinking;
  }

  function autosave(): void {
    saveDraft(root, captureDraft());
  }

  // ── status ────────────────────────────────────────────────────────────────────
  function showStatus(msg: string): void {
    statusBar.textContent = msg;
    statusBar.classList.remove("hidden");
  }

  function clearStatus(): void {
    statusBar.textContent = "";
    statusBar.classList.add("hidden");
  }

  // ── misc ──────────────────────────────────────────────────────────────────────
  function safeBuildPrompt(): string | null {
    try { return buildPrompt({ config, templateName, text, chips, thinking }); }
    catch { return null; }
  }

  function chipLabel(chip: Chip): string {
    if (chip.kind === "file") return `@${basename(chip.path)}`;
    if (chip.kind === "selection") {
      const name = chip.path ? basename(chip.path) : "selection";
      return `@${name}:${chip.startLine}-${chip.endLine}`;
    }
    if (chip.kind === "skill") return chip.invocation;
    return chip.name; // subagent
  }

  // ── event wiring ──────────────────────────────────────────────────────────────
  targetSel.onchange = () => {
    targetId = targetSel.value || null;
    updateStateDot();
    autosave();
  };

  profileSel.onchange = () => void onProfileChange(profileSel.value || null);

  // Insert the current editor selection as a context chip — invoked from the
  // "+ selection" affordance rendered inside the context hero (see renderSection).
  function addSelectionChip(): void {
    const sel = getSelection();
    if (!sel.text.trim()) { showStatus("No text selected in editor."); return; }
    clearStatus();
    const chip = {
      kind: "selection" as const,
      path: sel.path ?? "", lang: sel.lang,
      startLine: sel.line, endLine: sel.endLine, text: sel.text,
    };
    chips.push({ chip, section: defaultSection(chip) });
    renderChips();
    renderPreview();
    autosave();
  }

  sendBtn.onclick = () => void onSend();
  stageInp.onchange = () => { submit = false; };
  submitInp.onchange = () => { submit = true; };
  thinkInp.onchange = () => { thinking = thinkInp.checked; renderPreview(); autosave(); };

  prevBtn.onclick = () => openPreview(!prevOpen);
  histToggleBtn.onclick = () => openHistory(!histOpen);
  prevClose.onclick = () => openPreview(false);
  histClose.onclick = () => openHistory(false);

  trustBtn.onclick = () => {
    localStorage.setItem(TRUST_KEY(root), "1");
    trusted = true;
    void Promise.all([reloadConfig(), reloadProfiles()]).then(() => renderAll());
  };

  gearBtn.onclick = () => {
    mountTagManager({
      root,
      config,
      trusted,
      // Re-read from disk (saveConfig already persisted + normalized) so the
      // composer reflects the normalized on-disk config, not the modal's copy.
      onSave: () => {
        void reloadConfig().then(() => renderAll());
      },
    });
  };

  // ── agent poll (runs while panel is visible) ──────────────────────────────────
  function startPoll(): void {
    if (pollTimer !== undefined) return;
    pollTimer = window.setInterval(() => {
      void ptyListAgents().then((a) => {
        // Runs every 3 s while the panel is open — skip the <select> rebuild when
        // the agent list is byte-identical.
        const sig = a.map((x) => `${x.id}:${x.kind}:${x.cwd ?? ""}:${x.state}`).join("|");
        if (sig === lastAgentsSig) return;
        lastAgentsSig = sig;
        agents = a;
        renderTargetPicker();
      }).catch(() => {});
    }, 3000);
  }

  function stopPoll(): void {
    if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
  }

  // ── public API ────────────────────────────────────────────────────────────────
  // Idempotent: callers (main.ts show/hide) set absolute state, so the poll
  // timer can't leak from open/close desync on remount.
  function setVisible(v: boolean): void {
    if (visible === v) return;
    visible = v;
    if (visible) {
      startPoll();
      void refreshAgents().then(() => renderTargetPicker());
    } else {
      stopPoll();
      hideSuggest(ctxComp);
      hideSuggest(taskComp);
    }
  }

  function dispose(): void {
    stopPoll();
    window.removeEventListener("pointermove", onDrawerMove);
    window.removeEventListener("pointerup", onDrawerUp);
    container.innerHTML = "";
  }

  return {
    toggle: () => setVisible(!visible),
    show: () => setVisible(true),
    hide: () => setVisible(false),
    getProfiles: () => profiles,
    getTaskDraft,
    deliverTaskPrompt,
    // Window-hidden gate: pause the agent poll without touching visible state,
    // resume only if the panel is still open.
    pausePolling: () => stopPoll(),
    resumePolling: () => { if (visible) startPoll(); },
    dispose,
  };
}
