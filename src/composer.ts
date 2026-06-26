// Docked prompt-composer panel: template picker, section inputs with @ / /
// completion, chip rail, agent target selector, draft persistence, send flow.
import { templateTags, resolveConfig, type TagConfig } from "./prompt-tags";
import { buildPrompt, defaultSection, type Chip, type RoutedChip } from "./prompt-builder";
import { matchFiles, matchAssets, assetToken, type AssetOption } from "./composer-complete";
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

const TRUST_KEY = (root: string) => `composer-trusted:${root}`;
const TAGS_PATH = (root: string) => `${root}/.sutra/prompt-tags.json`;

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
  let taskArea: HTMLTextAreaElement | null = null;
  let suggestItems: string[] = [];
  let suggestActive = 0;
  let suggestStart = 0;

  // ── DOM ──────────────────────────────────────────────────────────────────────
  container.innerHTML = "";

  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

  // Toolbar
  const toolbar = mk("div", "cmp-toolbar");
  const targetSel = mk("select", "cmp-target");
  const stateDot = mk("span", "cmp-state-dot");
  const gearBtn = mkBtn("cmp-gear sbtn", icon("settings", 13));
  gearBtn.title = "Tag manager";
  toolbar.append(targetSel, stateDot, gearBtn);

  // Trust banner
  const trustBanner = mk("div", "cmp-trust-banner hidden");
  const trustMsg = mk("span", "");
  trustMsg.textContent = "Custom tags disabled — workspace not trusted.";
  const trustBtn = mkBtn("cmp-trust-btn", "Trust workspace");
  trustBanner.append(trustMsg, trustBtn);

  // Template bar
  const tmplBar = mk("div", "cmp-template-bar");

  // Per-tag sections
  const sectionsEl = mk("div", "cmp-sections");

  // Suggestion dropdown (inline, below sections)
  const suggestEl = mk("div", "cmp-suggest hidden");

  // Chip rail
  const chipRail = mk("div", "cmp-chip-rail");
  const addSelBtn = mkBtn("cmp-add-sel sbtn", `${icon("pencil", 12)} Add selection`);
  addSelBtn.title = "Insert current editor selection as a context chip";
  chipRail.appendChild(addSelBtn);

  // Action bar
  const actionBar = mk("div", "cmp-action-bar");
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
  const sendBtn = mkBtn("cmp-send", `Send ${isMac ? "⌘" : "Ctrl"}↵`);
  actionBar.append(modeGrp, sendBtn);

  // Preview (collapsible)
  const previewWrap = mk("details", "cmp-preview-wrap");
  const previewSummary = document.createElement("summary");
  previewSummary.textContent = "Preview";
  const previewPre = mk("pre", "cmp-preview-pre");
  previewWrap.append(previewSummary, previewPre);

  // History
  const histWrap = mk("div", "cmp-hist-wrap");
  const histBtn = mkBtn("cmp-hist-btn", `History ${icon("chevronDown", 12)}`);
  const histList = mk("div", "cmp-hist-list hidden");
  histWrap.append(histBtn, histList);

  // Status / error
  const statusBar = mk("div", "cmp-status hidden");

  container.append(
    toolbar, trustBanner, tmplBar, sectionsEl, suggestEl,
    chipRail, actionBar, previewWrap, histWrap, statusBar,
  );

  // ── init ─────────────────────────────────────────────────────────────────────
  void init();

  async function init(): Promise<void> {
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
        renderPreview();
        autosave();
      };
      tmplBar.appendChild(b);
    }
  }

  function renderSections(): void {
    sectionsEl.innerHTML = "";
    taskArea = null;
    for (const tag of templateTags(config, templateName)) {
      const wrap = mk("div", "cmp-section");
      // Drop target: dragging a chip here re-routes it to this section, overriding auto-route.
      wrap.dataset.section = tag.id;
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
      lbl.textContent = tag.label;
      wrap.appendChild(lbl);

      if (tag.input === "text") {
        const inp = mk("input", "cmp-section-input cmp-section-text");
        inp.type = "text";
        inp.placeholder = tag.placeholder ?? "";
        inp.value = text[tag.id] ?? tag.default ?? "";
        inp.oninput = () => { text[tag.id] = inp.value; renderPreview(); autosave(); };
        wrap.appendChild(inp);
      } else {
        const ta = mk("textarea", "cmp-section-input");
        ta.placeholder = tag.placeholder || tag.label;
        ta.value = text[tag.id] ?? tag.default ?? "";
        ta.rows = tag.id === "task" ? 5 : 3;
        ta.oninput = () => {
          text[tag.id] = ta.value;
          renderPreview();
          autosave();
          if (tag.id === "task") handleCompletion(ta);
        };
        ta.onkeydown = (e) => { if (tag.id === "task") onTaskKeydown(e, ta); };
        if (tag.id === "task") {
          taskArea = ta;
          const hint = mk("div", "cmp-complete-hint");
          hint.textContent = "@ file  / skill";
          wrap.append(ta, hint);
        } else {
          wrap.appendChild(ta);
        }
      }
      sectionsEl.appendChild(wrap);
    }
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
  }

  function updateStateDot(): void {
    const st = agents.find((a) => a.id === targetId)?.state ?? "unknown";
    stateDot.className = `cmp-state-dot cmp-state-${st}`;
    stateDot.title = st;
  }

  function renderPreview(): void {
    if (!previewWrap.open) return;
    const p = safeBuildPrompt();
    previewPre.textContent = p?.trim() ? p : "(empty)";
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

  // ── @ / / completion ──────────────────────────────────────────────────────────
  function handleCompletion(ta: HTMLTextAreaElement): void {
    const ctx = completionContext(ta);
    if (!ctx) { hideSuggest(); return; }
    suggestStart = ctx.start;
    if (ctx.trigger === "@") {
      void getFiles()
        .then((files) => {
          const matches = matchFiles(ctx.query, files);
          showSuggest(
            matches.map((f) => basename(f)),
            matches.map((f) => `@${f}`),
          );
        })
        .catch(() => hideSuggest());
    } else {
      const aopts: AssetOption[] = assets.map((a) => ({ kind: a.kind, name: a.name, invocation: a.invocation }));
      const matches = matchAssets(ctx.query, aopts);
      showSuggest(
        matches.map((a) => `${a.name} (${a.kind})`),
        matches.map((a) => assetToken(a)),
      );
    }
  }

  function completionContext(ta: HTMLTextAreaElement): { trigger: "@" | "/"; query: string; start: number } | null {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    for (let i = pos - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === "@" || ch === "/") {
        const query = before.slice(i + 1);
        if (!/\s/.test(query)) return { trigger: ch as "@" | "/", query, start: i };
        break;
      }
      if (/\s/.test(ch)) break;
    }
    return null;
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
    if (!taskArea) return;
    const pos = taskArea.selectionStart;
    const before = taskArea.value.slice(0, suggestStart);
    const after = taskArea.value.slice(pos);
    taskArea.value = before + token + " " + after;
    const newPos = before.length + token.length + 1;
    taskArea.setSelectionRange(newPos, newPos);
    text["task"] = taskArea.value;
    hideSuggest();
    renderPreview();
    autosave();
  }

  function onTaskKeydown(e: KeyboardEvent, _ta: HTMLTextAreaElement): void {
    if (!suggestEl.classList.contains("hidden")) {
      const items = suggestEl.querySelectorAll<HTMLElement>(".cmp-suggest-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        suggestActive = Math.min(suggestActive + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle("active", i === suggestActive));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        suggestActive = Math.max(suggestActive - 1, 0);
        items.forEach((it, i) => it.classList.toggle("active", i === suggestActive));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const token = suggestItems[suggestActive];
        if (token !== undefined) { e.preventDefault(); pickSuggestion(token); return; }
      }
      if (e.key === "Escape") { hideSuggest(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
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

  addSelBtn.onclick = () => {
    const sel = getSelection();
    if (!sel.text.trim()) { showStatus("No text selected in editor."); return; }
    clearStatus();
    chips.push({
      chip: {
        kind: "selection",
        path: sel.path ?? "",
        lang: sel.lang,
        startLine: sel.line,
        endLine: sel.endLine,
        text: sel.text,
      },
      section: defaultSection({ kind: "selection", path: sel.path ?? "", lang: sel.lang, startLine: sel.line, endLine: sel.endLine, text: sel.text }),
    });
    renderChips();
    renderPreview();
    autosave();
  };

  sendBtn.onclick = () => void onSend();
  stageInp.onchange = () => { submit = false; };
  submitInp.onchange = () => { submit = true; };
  thinkInp.onchange = () => { thinking = thinkInp.checked; renderPreview(); autosave(); };
  previewWrap.ontoggle = () => { if (previewWrap.open) renderPreview(); };
  histBtn.onclick = () => histList.classList.toggle("hidden");

  trustBtn.onclick = () => {
    localStorage.setItem(TRUST_KEY(root), "1");
    trusted = true;
    void reloadConfig().then(() => renderAll());
  };

  gearBtn.onclick = () => {
    mountTagManager({
      root,
      config,
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
    container.innerHTML = "";
  }

  return {
    toggle: () => setVisible(!visible),
    show: () => setVisible(true),
    hide: () => setVisible(false),
    dispose,
  };
}
