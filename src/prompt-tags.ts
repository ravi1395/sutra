// Tag/template schema for the prompt composer plus a trust-gated loader.
// Pure: no DOM, no Tauri. The repo-supplied config carries auto-injected
// default text, so it is only honored for trusted workspaces.

export type TagInput =
  | "text"
  | "textarea"
  | "chips"
  | "chips+text"
  | "bullet"
  | "pairs"
  | "dropdown";

export interface TagDef {
  id: string;
  label: string;
  input: TagInput;
  default: string;
  placeholder: string;
  defaultOn: boolean;
}

export interface Template {
  name: string;
  tags: string[];
}

export interface TagConfig {
  version: number;
  tags: TagDef[];
  templates: Template[];
  activeTemplate: string;
}

const tag = (
  id: string,
  input: TagInput,
  defaultOn: boolean,
  placeholder = "",
  def = "",
): TagDef => ({ id, label: id, input, default: def, placeholder, defaultOn });

export const DEFAULT_CONFIG: TagConfig = {
  version: 1,
  tags: [
    tag("role", "text", true, "persona / expertise", "You are a senior engineer working in this repo."),
    tag("context", "chips+text", true, "background + files"),
    tag("task", "textarea", true, "the actual ask"),
    tag("constraints", "bullet", true, "rules, do/don't, scope"),
    tag("output", "dropdown", true, "format: diff / JSON / file / prose"),
    tag("examples", "pairs", false, "few-shot in/out pairs"),
    tag("success_criteria", "bullet", false, "acceptance / observable outcome"),
    tag("references", "chips", false, "doc links, ticket ids"),
    tag("tone", "text", false, "voice / register"),
  ],
  templates: [
    { name: "Bug fix", tags: ["role", "context", "task", "constraints", "success_criteria", "output"] },
    { name: "Feature", tags: ["role", "context", "task", "constraints", "examples", "output"] },
    { name: "Review", tags: ["role", "context", "task", "output"] },
    { name: "Explain", tags: ["role", "context", "task"] },
  ],
  activeTemplate: "Feature",
};

const INPUTS: TagInput[] = ["text", "textarea", "chips", "chips+text", "bullet", "pairs", "dropdown"];

function isTagDef(v: unknown): v is TagDef {
  const t = v as TagDef;
  return !!t && typeof t.id === "string" && t.id.length > 0 && INPUTS.includes(t.input);
}

/** Validate untrusted JSON into a TagConfig; any structural problem → DEFAULT_CONFIG. */
export function normalizeConfig(raw: unknown): TagConfig {
  const c = raw as TagConfig;
  if (!c || c.version !== 1 || !Array.isArray(c.tags) || !Array.isArray(c.templates)) {
    return DEFAULT_CONFIG;
  }
  const tags = c.tags.filter(isTagDef).map((t) => ({
    id: t.id,
    label: typeof t.label === "string" ? t.label : t.id,
    input: t.input,
    default: typeof t.default === "string" ? t.default : "",
    placeholder: typeof t.placeholder === "string" ? t.placeholder : "",
    defaultOn: !!t.defaultOn,
  }));
  if (tags.length === 0) return DEFAULT_CONFIG;
  const templates = c.templates
    .filter((t) => t && typeof t.name === "string" && Array.isArray(t.tags))
    .map((t) => ({ name: t.name, tags: t.tags.filter((x) => typeof x === "string") }));
  if (templates.length === 0) return DEFAULT_CONFIG;
  const activeTemplate = templates.some((t) => t.name === c.activeTemplate)
    ? c.activeTemplate
    : templates[0].name;
  return { version: 1, tags, templates, activeTemplate };
}

/** Load the repo config only when the workspace is trusted; else built-in defaults. */
export function resolveConfig(args: { rawJson: string | null; trusted: boolean }): TagConfig {
  if (!args.trusted || !args.rawJson) return DEFAULT_CONFIG;
  try {
    return normalizeConfig(JSON.parse(args.rawJson));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Tags enabled by a template, in template order, skipping unknown ids. */
export function templateTags(config: TagConfig, name: string): TagDef[] {
  const byId = new Map(config.tags.map((t) => [t.id, t]));
  const tpl = config.templates.find((t) => t.name === name);
  if (!tpl) return [];
  return tpl.tags.map((id) => byId.get(id)).filter((t): t is TagDef => !!t);
}
