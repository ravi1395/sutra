// Assembles composer sections + routed chips into an XML-tagged prompt string.
// Pure: no DOM, no Tauri. Empty sections are omitted; <thinking> is a modifier
// (a prepended instruction), never an emitted tag.
import { templateTags, type TagConfig } from "./prompt-tags";

export interface FileChip { kind: "file"; path: string }
export interface SelectionChip {
  kind: "selection";
  path: string;
  lang: string;
  startLine: number;
  endLine: number;
  text: string;
}
export interface SkillChip { kind: "skill"; invocation: string }
export interface SubagentChip { kind: "subagent"; name: string }
export type Chip = FileChip | SelectionChip | SkillChip | SubagentChip;
export interface RoutedChip { chip: Chip; section: string }

const DEFAULT_CAP = 16384;
const THINKING_INSTRUCTION = "Think hard before answering.";

/** Auto-route a chip to its home tag id. */
export function defaultSection(chip: Chip): string {
  return chip.kind === "skill" || chip.kind === "subagent" ? "task" : "context";
}

/** CommonMark fence long enough to wrap content that may itself contain backticks. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Byte length without pulling in Buffer (works under esbuild/node). */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Chip → its token. Over-cap selections degrade to a @path:range reference. */
export function renderChip(chip: Chip, capBytes: number): string {
  switch (chip.kind) {
    case "file":
      return `@${chip.path}`;
    case "skill":
      return chip.invocation;
    case "subagent":
      return `use the ${chip.name} subagent to `;
    case "selection": {
      const range = `${chip.startLine}-${chip.endLine}`;
      if (byteLen(chip.text) > capBytes) return `@${chip.path}:${range}`;
      const fence = fenceFor(chip.text);
      return `${fence}${chip.lang} ${chip.path}:${range}\n${chip.text}\n${fence}`;
    }
  }
}

export interface BuildInput {
  config: TagConfig;
  templateName: string;
  text: Record<string, string>;
  chips: RoutedChip[];
  thinking: boolean;
  capBytes?: number;
}

/** Merge a section's free text + routed chips into one trimmed body. */
function sectionBody(id: string, input: BuildInput, cap: number): string {
  const parts: string[] = [];
  const t = (input.text[id] ?? "").trim();
  if (t) parts.push(t);
  for (const r of input.chips) {
    if (r.section === id) parts.push(renderChip(r.chip, cap));
  }
  return parts.join("\n").trim();
}

export function buildPrompt(input: BuildInput): string {
  const cap = input.capBytes ?? DEFAULT_CAP;
  const blocks: string[] = [];
  for (const tag of templateTags(input.config, input.templateName)) {
    const body = sectionBody(tag.id, input, cap);
    if (body) blocks.push(`<${tag.id}>\n${body}\n</${tag.id}>`);
  }
  if (blocks.length === 0) return "";
  const joined = blocks.join("\n\n");
  return input.thinking ? `${THINKING_INSTRUCTION}\n\n${joined}` : joined;
}
