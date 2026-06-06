import type { AgentChange, ChangedFile } from "./ipc";

export interface ReviewFile extends ChangedFile {
  humanTouched?: boolean;
  binary?: boolean;
}

export function mergeChangedFiles(gitFiles: ChangedFile[], agentChanges: AgentChange[]): ReviewFile[] {
  const files = new Map<string, ReviewFile>();
  for (const file of gitFiles) files.set(file.path, file);
  for (const change of agentChanges) files.set(change.path, change);
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export function aiChanges(changes: AgentChange[]): AgentChange[] {
  return changes.filter((change) => !change.humanTouched);
}

export function agentBannerText(changes: AgentChange[]): string {
  const count = aiChanges(changes).length;
  const unsafe = changes.filter((change) => change.humanTouched).length;
  const files = count === 1 ? "file" : "files";
  const suffix = unsafe === 0
    ? ""
    : `; ${unsafe} ${unsafe === 1 ? "needs" : "need"} manual review`;
  return `Integrated agent changed ${count} ${files}${suffix}.`;
}

export function firstViewableAgentChange(changes: AgentChange[]): AgentChange | undefined {
  const ai = aiChanges(changes);
  const isViewable = (change: AgentChange) => change.status !== "D" && !change.binary;
  return ai.find(isViewable) ?? changes.find(isViewable) ?? ai[0] ?? changes[0];
}

export function isIntegratedAgentCommand(command: string): boolean {
  const first = command.trim().split(/\s+/, 1)[0] ?? "";
  const name = first.split("/").pop()?.toLowerCase();
  return name === "claude" || name === "codex";
}
