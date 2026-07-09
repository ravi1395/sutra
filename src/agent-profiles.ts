// Project-local agent profile schema. Profiles guide task/composer defaults;
// they never grant command or Git execution authority.
import { parseAutomationsFile } from "./automations";

export const AGENT_PROFILES_PATH = ".sutra/agent-profiles.json";
export const PROFILE_LIMIT = 20;
export const DEFAULT_ACCEPTANCE_LIMIT = 20;
export const AUTOMATION_ID_LIMIT = 20;
export const CONTEXT_SELECTOR_LIMIT = 8;
export const PROFILE_TEXT_LIMIT = 512;

export type AgentProfileMode = "explore" | "plan" | "implement" | "review" | "visual-qa";
export type ContextSelector =
  | "active-file"
  | "selection"
  | "chosen-files"
  | "git-changes"
  | "task-acceptance"
  | "task-evidence"
  | "unresolved-annotations"
  | "allowed-automations";

export interface AgentProfile {
  id: string;
  name: string;
  template: string;
  defaultMode: AgentProfileMode;
  defaultAcceptance: string[];
  allowedAutomationIds: string[];
  contextSelectors: ContextSelector[];
}

export interface AgentProfileLoader {
  isTrusted(root: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

interface AgentProfilesFile {
  version: 1;
  profiles: AgentProfile[];
}

const MODES: readonly AgentProfileMode[] = ["explore", "plan", "implement", "review", "visual-qa"];
const SELECTORS: readonly ContextSelector[] = [
  "active-file", "selection", "chosen-files", "git-changes", "task-acceptance", "task-evidence", "unresolved-annotations", "allowed-automations",
];

const profile = (
  id: string,
  name: string,
  template: string,
  defaultMode: AgentProfileMode,
  defaultAcceptance: string[],
  contextSelectors: ContextSelector[],
): AgentProfile => ({ id, name, template, defaultMode, defaultAcceptance, allowedAutomationIds: [], contextSelectors });

/** Always-present, provider-agnostic guidance profiles. */
export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  profile("explore", "Explore", "Explain", "explore", [], ["active-file", "selection", "chosen-files", "git-changes"]),
  profile("plan", "Plan", "Feature", "plan", ["State the implementation plan", "Identify verification"], ["active-file", "chosen-files", "git-changes", "task-acceptance"]),
  profile("implement", "Implement", "Feature", "implement", ["Implement the requested change", "Run relevant verification"], ["active-file", "selection", "chosen-files", "git-changes", "task-acceptance", "allowed-automations"]),
  profile("review", "Review", "Review", "review", ["Review linked changes", "Record outstanding risks"], ["active-file", "chosen-files", "git-changes", "task-acceptance", "task-evidence"]),
  profile("visual-qa", "Visual QA", "Review", "visual-qa", ["Check unresolved visual feedback"], ["active-file", "selection", "unresolved-annotations", "task-acceptance"]),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= PROFILE_TEXT_LIMIT;
}

function isStringList(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(isShortText);
}

function parseProfile(value: unknown, knownAutomationIds: ReadonlySet<string>): AgentProfile | null {
  if (!isRecord(value)
    || !isShortText(value.id)
    || !isShortText(value.name)
    || !isShortText(value.template)
    || !MODES.includes(value.defaultMode as AgentProfileMode)
    || !isStringList(value.defaultAcceptance, DEFAULT_ACCEPTANCE_LIMIT)
    || !isStringList(value.allowedAutomationIds, AUTOMATION_ID_LIMIT)
    || !isStringList(value.contextSelectors, CONTEXT_SELECTOR_LIMIT)) return null;

  if (new Set(value.allowedAutomationIds).size !== value.allowedAutomationIds.length
    || value.allowedAutomationIds.some((id) => !knownAutomationIds.has(id))
    || new Set(value.contextSelectors).size !== value.contextSelectors.length
    || value.contextSelectors.some((selector) => !SELECTORS.includes(selector as ContextSelector))) return null;

  return {
    id: value.id,
    name: value.name,
    template: value.template,
    defaultMode: value.defaultMode as AgentProfileMode,
    defaultAcceptance: [...value.defaultAcceptance],
    allowedAutomationIds: [...value.allowedAutomationIds],
    contextSelectors: value.contextSelectors as ContextSelector[],
  };
}

/**
 * Loads trusted project overlays. Any malformed record invalidates the project
 * file as a whole, ensuring callers always receive safe built-in guidance.
 */
export function resolveAgentProfiles(args: {
  rawJson: string | null;
  trusted: boolean;
  automationIds: readonly string[];
}): readonly AgentProfile[] {
  if (!args.trusted || !args.rawJson) return BUILTIN_AGENT_PROFILES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.rawJson);
  } catch {
    return BUILTIN_AGENT_PROFILES;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.length > PROFILE_LIMIT) {
    return BUILTIN_AGENT_PROFILES;
  }

  const knownAutomationIds = new Set(args.automationIds);
  const projectProfiles = parsed.profiles.map((candidate) => parseProfile(candidate, knownAutomationIds));
  if (projectProfiles.some((candidate) => candidate === null)) return BUILTIN_AGENT_PROFILES;
  const overrides = projectProfiles as AgentProfile[];
  if (new Set(overrides.map((candidate) => candidate.id)).size !== overrides.length) return BUILTIN_AGENT_PROFILES;

  const byId = new Map(overrides.map((candidate) => [candidate.id, candidate]));
  const merged = BUILTIN_AGENT_PROFILES.map((builtin) => byId.get(builtin.id) ?? builtin);
  const custom = overrides.filter((candidate) => !BUILTIN_AGENT_PROFILES.some((builtin) => builtin.id === candidate.id));
  return [...merged, ...custom];
}

/**
 * Trust-check before reading project profile data. This intentionally does not
 * share the composer's legacy local tag-trust state: only the backend-owned
 * workspace trust gate can authorize project profile overrides.
 */
export async function loadAgentProfiles(root: string, loader: AgentProfileLoader): Promise<readonly AgentProfile[]> {
  if (!(await loader.isTrusted(root).catch(() => false))) return BUILTIN_AGENT_PROFILES;
  const [rawJson, automationsJson] = await Promise.all([
    loader.readFile(`${root}/${AGENT_PROFILES_PATH}`).catch(() => null),
    loader.readFile(`${root}/.sutra/automations.json`).catch(() => null),
  ]);
  return resolveAgentProfiles({
    rawJson,
    trusted: true,
    automationIds: automationsJson ? parseAutomationsFile(automationsJson).map((automation) => automation.id) : [],
  });
}

export type { AgentProfilesFile };
