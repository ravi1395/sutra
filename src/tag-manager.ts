// Tag config editor: pure mutations, IPC persistence, and a modal DOM manager
// opened from the composer gear button. Pure functions are tested independently.
import { readFile, writeFile, createDir } from "./ipc";
import { DEFAULT_CONFIG, normalizeConfig, type TagConfig, type TagDef } from "./prompt-tags";

const CONFIG_PATH = (root: string) => `${root}/.sutra/prompt-tags.json`;
const CONFIG_DIR = (root: string) => `${root}/.sutra`;

// ── pure mutations (tested in tests/tag-manager.test.ts) ──────────────────────

/** Insert or update a tag by id; preserves existing order for updates. */
export function upsertTag(config: TagConfig, tag: TagDef): TagConfig {
  const idx = config.tags.findIndex((t) => t.id === tag.id);
  const tags =
    idx >= 0
      ? config.tags.map((t, i) => (i === idx ? tag : t))
      : [...config.tags, tag];
  return { ...config, tags };
}

/** Remove a tag and scrub it from every template's tag list. */
export function removeTag(config: TagConfig, tagId: string): TagConfig {
  return {
    ...config,
    tags: config.tags.filter((t) => t.id !== tagId),
    templates: config.templates.map((tmpl) => ({
      ...tmpl,
      tags: tmpl.tags.filter((id) => id !== tagId),
    })),
  };
}

/** Replace a template's tag order (unknown template name is a no-op). */
export function reorderTemplate(config: TagConfig, templateName: string, newOrder: string[]): TagConfig {
  return {
    ...config,
    templates: config.templates.map((t) =>
      t.name === templateName ? { ...t, tags: newOrder } : t,
    ),
  };
}

// ── persistence ───────────────────────────────────────────────────────────────

export async function readConfig(root: string): Promise<TagConfig> {
  const raw = await readFile(CONFIG_PATH(root)).catch(() => null);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(root: string, config: TagConfig): Promise<void> {
  await createDir(CONFIG_DIR(root)).catch(() => {}); // ok if already exists
  // Normalize before persisting so a malformed config never reaches disk.
  await writeFile(CONFIG_PATH(root), JSON.stringify(normalizeConfig(config), null, 2));
}

// ── modal DOM manager ─────────────────────────────────────────────────────────

export interface TagManagerOptions {
  root: string;
  config: TagConfig;
  /** Called with the new config after a successful save. */
  onSave: (config: TagConfig) => void;
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export function mountTagManager(opts: TagManagerOptions): { close: () => void } {
  const { root, onSave } = opts;
  let config = opts.config;

  const overlay = mk("div", "tm-overlay");
  const modal = mk("div", "tm-modal");

  const header = mk("div", "tm-header");
  const titleEl = mk("span", "tm-title");
  titleEl.textContent = "Tag Manager";
  const closeBtn = mk("button", "tm-close");
  closeBtn.textContent = "×";
  header.append(titleEl, closeBtn);

  const body = mk("div", "tm-body");

  const footer = mk("div", "tm-footer");
  const statusEl = mk("span", "tm-status");
  const saveBtn = mk("button", "tm-save");
  saveBtn.textContent = "Save";
  footer.append(statusEl, saveBtn);

  modal.append(header, body, footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  render();

  function render(): void {
    body.innerHTML = "";

    // ── tags ──────────────────────────────────────────────────────────────────
    const tagSection = mk("div", "tm-section");
    const tagTitle = mk("div", "tm-section-title");
    tagTitle.textContent = "Tags";
    tagSection.appendChild(tagTitle);

    for (const tag of config.tags) {
      const row = mk("div", "tm-row");
      const idSpan = mk("span", "tm-tag-id");
      idSpan.textContent = tag.id;
      const lblInp = mk("input", "tm-input");
      lblInp.type = "text";
      lblInp.value = tag.label;
      lblInp.placeholder = "label";
      lblInp.oninput = () => { config = upsertTag(config, { ...tag, label: lblInp.value }); };
      const rmBtn = mk("button", "tm-rm");
      rmBtn.textContent = "−";
      rmBtn.title = `Remove tag "${tag.id}"`;
      rmBtn.onclick = () => { config = removeTag(config, tag.id); render(); };
      row.append(idSpan, lblInp, rmBtn);
      tagSection.appendChild(row);
    }

    // add-tag row
    const addRow = mk("div", "tm-row tm-add-row");
    const newId = mk("input", "tm-input tm-input-sm");
    newId.placeholder = "tag-id";
    const newLbl = mk("input", "tm-input tm-input-sm");
    newLbl.placeholder = "Label";
    const addBtn = mk("button", "tm-add");
    addBtn.textContent = "+";
    addBtn.onclick = () => {
      const id = newId.value.trim().replace(/\s+/g, "-").toLowerCase();
      if (!id) return;
      const t: TagDef = {
        id,
        label: newLbl.value.trim() || id,
        input: "textarea",
        default: "",
        placeholder: "",
        defaultOn: true,
      };
      config = upsertTag(config, t);
      newId.value = "";
      newLbl.value = "";
      render();
    };
    addRow.append(newId, newLbl, addBtn);
    tagSection.appendChild(addRow);
    body.appendChild(tagSection);

    // ── templates ─────────────────────────────────────────────────────────────
    const tmplSection = mk("div", "tm-section");
    const tmplTitle = mk("div", "tm-section-title");
    tmplTitle.textContent = "Templates (tag order)";
    tmplSection.appendChild(tmplTitle);

    for (const tmpl of config.templates) {
      const row = mk("div", "tm-row");
      const nameEl = mk("span", "tm-tmpl-name");
      nameEl.textContent = tmpl.name;
      const orderInp = mk("input", "tm-input tm-tmpl-order");
      orderInp.type = "text";
      orderInp.value = tmpl.tags.join(", ");
      orderInp.placeholder = "tag-ids, comma-separated";
      orderInp.oninput = () => {
        const newOrder = orderInp.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        config = reorderTemplate(config, tmpl.name, newOrder);
      };
      row.append(nameEl, orderInp);
      tmplSection.appendChild(row);
    }
    body.appendChild(tmplSection);
  }

  function close(): void {
    overlay.remove();
  }

  closeBtn.onclick = () => close();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    statusEl.textContent = "Saving…";
    try {
      await saveConfig(root, config);
      statusEl.textContent = "Saved.";
      onSave(config);
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (err) {
      statusEl.textContent = String(err);
    } finally {
      saveBtn.disabled = false;
    }
  };

  return { close };
}
