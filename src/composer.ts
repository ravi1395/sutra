// Docked prompt-composer panel: template picker, section inputs, chip rail,
// agent target selector, draft persistence, send flow.
// "Focus" layout: two heroes — Context (owns @file / /skill / +selection
// completion and the chip rail) and Task — render first, in role→context→
// task→rest order (task is not hoisted ahead of context); Preview / History
// are slide-up drawers that overlay the scroll area (so they can't be
// squeezed off when the terminal drawer steals panel height).
import { templateTags, resolveConfig, type TagConfig } from "./prompt-tags";
import { buildPrompt, defaultSection, type Chip, type RoutedChip } from "./prompt-builder";
import { orderSections, isFirstRunDraft, clampDrawerHeight } from "./composer-layout";
import { matchFiles, matchAssets, assetToken, completionContext, type AssetOption } from "./composer-complete";
import {
  saveDraft, loadDraft, clearDraft, loadHistory, saveHistory, pushHistory,
  type Draft, type HistoryEntry,
} from "./composer-store";
import {
  readFile, scanAgentAssets, ptyListAgents, deliverToPty,
  type AgentTerminal, type AgentAsset,
} from "./ipc";
import { icon } from "./icons";
import { mountTagManager } from "./tag-manager";
import { IS_MAC } from "./shortcuts";

const TRUST_KEY = (root: string) => `composer-trusted:${root}`;
const TAGS_PATH = (root: string) => `${root}/.sutra/prompt-tags.json`;
// Drawer height is a UI preference shared across roots/panels.
const DRAWER_H_KEY = "composer-drawer-h";
const DRAWER_H_DEFAULT = 220;
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

export function mountComposer(opts: ComposerOptions): {
  toggle: () => void;
  show: () => void;
  hide: () => void;
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
  let assets: AgentAsset[] = [];
  let agents: AgentTerminal[] = [];
  let history: HistoryEntry[] = loadHistory(root);
  let chips: RoutedChip[] = [];
  let draggingChip: number | null = null;
  let text: Record<string, string> = {};
  let templateName = "";
  let targetId: string | null = null;
  let thinking = false;
  let submit = false;
  let visible = false;
  let pollTimer: number | undefined;
  let completeArea: HTMLTextAreaElement | null = null;  // section owning @ / / completion (context, else task)
  let completeId = "context";                           // tag id a picked suggestion inserts into
  let ctxCount: HTMLElement | null = null;
  let suggestItems: string[] = [];
  let suggestActive = 0;
  let suggestStart = 0;
  let prevOpen = false;
  let histOpen = false;

  // ── DOM ──────────────────────────────────────────────────────────────────────
  container.innerHTML = "";

  // Header (target picker + history + tag-manager)
  const toolbar = mk("div", "cmp-toolbar");
  const targetSel = mk("select", "cmp-target");
  const stateDot = mk("span", "cmp-state-dot");
  const histToggleBtn = mkBtn("cmp-icon-btn sbtn", icon("list", 13));
  histToggleBtn.title = "History";
  const gearBtn = mkBtn("cmp-gear sbtn", icon("settings", 13));
  gearBtn.title = "Tag manager";
  toolbar.append(targetSel, stateDot, histToggleBtn, gearBtn);

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
  // Suggestion dropdown (moved under the Context hero during render)
  const suggestEl = mk("div", "cmp-suggest hidden");
  // Chip rail (rendered directly under the context hero)
  const chipRail = mk("div", "cmp-chip-rail");

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
    applyDrawerHeight();
    await Promise.all([reloadConfig(), refreshAgents(), refreshAssets()]);
    const saved = loadDraft(root);
    if (saved) applyDraft(saved);
    else templateName = config.templates[0]?.name ?? "";
    renderAll();
  }

  async function reloadConfig(): Promise<void> {
    const rawJson = await readFile(TAGS_PATH(root)).catch(() => null);
    config = resolveConfig({ rawJson, trusted });
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

    // Whichever hero backs completion this render (Context if present, else Task).
    const ownsCompletion = isHero && tag.id === completeId;

    const ta = mk("textarea", "cmp-section-input");
    ta.placeholder = tag.placeholder || tag.label;
    ta.value = text[tag.id] ?? tag.default ?? "";
    ta.rows = isHero ? 5 : 3;
    ta.oninput = () => {
      text[tag.id] = ta.value;
      renderPreview();
      autosave();
      if (ownsCompletion) { handleCompletion(ta); }
      if (isHero) { updateHeroCounts(); updateOnboard(); }
    };
    ta.onkeydown = (e) => { if (ownsCompletion) onCompleteKeydown(e); else onHeroKeydown(e); };
    wrap.appendChild(ta);
    if (ownsCompletion) completeArea = ta;

    if (isCtx) {
      // hint row: @ file · / skill · + selection
      const hint = mk("div", "cmp-complete-hint");
      hint.innerHTML = `@ file &middot; / skill &middot; `;
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      hint.appendChild(selBtn);
      wrap.appendChild(hint);
    } else if (isTask) {
      const hint = mk("div", "cmp-complete-hint");
      // Task backs completion only when the template omits a Context section.
      hint.textContent = ownsCompletion
        ? "@ file · / skill · plain prose"
        : "plain prose — describe the outcome you want";
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
    completeArea = null; taskCount = null; ctxCount = null;
    sectionsEl.appendChild(onboardEl);
    // chipRail persists across renders (only its .cmp-chip pills are re-rendered
    // elsewhere) — drop any fallback "+ selection" button from a prior render
    // before deciding whether to re-add one below, to avoid duplicates on
    // repeated template switches.
    chipRail.querySelectorAll(".cmp-add-sel").forEach((e) => e.remove());
    const ordered = orderSections(templateTags(config, templateName));
    // Context owns completion when present; else Task backs it so @ / / still
    // work in context-less templates.
    completeId = ordered.some((t) => t.id === "context") ? "context" : "task";
    let placed = false;
    for (const tag of ordered) {
      renderSection(tag);
      // Suggestion dropdown + chip rail sit directly under the Context hero.
      if (tag.id === "context") {
        sectionsEl.appendChild(suggestEl);
        sectionsEl.appendChild(chipRail);
        placed = true;
      }
    }
    if (!placed) {
      // No context section — keep completion + chips reachable at the end,
      // and preserve the "+ selection" affordance the Context hero would
      // otherwise provide, so selection chips stay reachable.
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      chipRail.appendChild(selBtn);
      sectionsEl.appendChild(suggestEl);
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

  // ── drawers (preview / history) ────────────────────────────────────────────────
  function drawerHeight(): number {
    const v = parseInt(localStorage.getItem(DRAWER_H_KEY) ?? "", 10);
    return Number.isFinite(v) ? v : DRAWER_H_DEFAULT;
  }

  function applyDrawerHeight(): void {
    const h = `${drawerHeight()}px`;
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
      if (Number.isFinite(h)) localStorage.setItem(DRAWER_H_KEY, String(h));
      dragEl.classList.remove("cmp-peek-dragging");
      applyDrawerHeight(); // keep both drawers in sync
      dragEl = null;
    }
    window.removeEventListener("pointermove", onDrawerMove);
    window.removeEventListener("pointerup", onDrawerUp);
  }

  prevGrab.addEventListener("pointerdown", onDrawerDown);
  histGrab.addEventListener("pointerdown", onDrawerDown);

  // ── @ / / completion ──────────────────────────────────────────────────────────
  function handleCompletion(ta: HTMLTextAreaElement): void {
    const ctx = completionContext(ta.value, ta.selectionStart);
    if (!ctx) { hideSuggest(); return; }
    suggestStart = ctx.start;
    if (ctx.trigger === "@") {
      void getFiles()
        .then((files) => {
          const matches = matchFiles(ctx.query, files);
          showSuggest(matches.map((f) => basename(f)), matches.map((f) => `@${f}`));
        })
        .catch(() => hideSuggest());
    } else {
      const aopts: AssetOption[] = assets.map((a) => ({ kind: a.kind, name: a.name, invocation: a.invocation }));
      const matches = matchAssets(ctx.query, aopts);
      showSuggest(matches.map((a) => `${a.name} (${a.kind})`), matches.map((a) => assetToken(a)));
    }
  }

  function showSuggest(labels: string[], tokens: string[]): void {
    suggestEl.innerHTML = "";
    if (!labels.length) { hideSuggest(); return; }
    suggestItems = tokens;
    suggestActive = 0;
    labels.forEach((lbl, i) => {
      const item = mk("div", `cmp-suggest-item${i === 0 ? " active" : ""}`);
      item.textContent = lbl;
      item.onmousedown = (e) => { e.preventDefault(); pickSuggestion(tokens[i]); };
      suggestEl.appendChild(item);
    });
    suggestEl.classList.remove("hidden");
  }

  function hideSuggest(): void {
    suggestEl.classList.add("hidden");
  }

  function pickSuggestion(token: string): void {
    if (!completeArea) return;
    const pos = completeArea.selectionStart;
    const before = completeArea.value.slice(0, suggestStart);
    const after = completeArea.value.slice(pos);
    completeArea.value = before + token + " " + after;
    const newPos = before.length + token.length + 1;
    completeArea.setSelectionRange(newPos, newPos);
    text[completeId] = completeArea.value;
    hideSuggest();
    updateHeroCounts();
    renderPreview();
    autosave();
  }

  function onCompleteKeydown(e: KeyboardEvent): void {
    if (!suggestEl.classList.contains("hidden")) {
      const items = suggestEl.querySelectorAll<HTMLElement>(".cmp-suggest-item");
      if (e.key === "ArrowDown") { e.preventDefault(); suggestActive = Math.min(suggestActive + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle("active", i === suggestActive)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); items.forEach((it, i) => it.classList.toggle("active", i === suggestActive)); return; }
      if (e.key === "Enter" || e.key === "Tab") { const token = suggestItems[suggestActive]; if (token !== undefined) { e.preventDefault(); pickSuggestion(token); return; } }
      if (e.key === "Escape") { hideSuggest(); return; }
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

    const result = await deliverToPty({ targetId, text: prompt, submit });
    sendBtn.disabled = false;

    if (result.ok) {
      const entry: HistoryEntry = { draft: captureDraft(), finalPrompt: prompt, ts: Date.now() };
      history = pushHistory(history, entry);
      saveHistory(root, history);
      clearDraft(root);
      renderHistory();
    } else {
      showStatus(result.reason);
    }
  }

  // ── draft ─────────────────────────────────────────────────────────────────────
  function captureDraft(): Draft {
    return { templateName, text: { ...text }, chips: [...chips], targetId, thinking };
  }

  function applyDraft(d: Draft): void {
    templateName = (d.templateName || config.templates[0]?.name) ?? "";
    text = { ...d.text };
    chips = [...d.chips];
    targetId = d.targetId;
    thinking = d.thinking;
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
    void reloadConfig().then(() => renderAll());
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
      void ptyListAgents().then((a) => { agents = a; renderTargetPicker(); }).catch(() => {});
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
      hideSuggest();
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
    dispose,
  };
}
