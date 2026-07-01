import type { AgentChange, AgentTrackingStatus, ChangedFile } from "./ipc";

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

export function firstViewableAgentChange(changes: AgentChange[]): AgentChange | undefined {
  const ai = aiChanges(changes);
  const isViewable = (change: AgentChange) => change.status !== "D" && !change.binary;
  return ai.find(isViewable) ?? changes.find(isViewable) ?? ai[0] ?? changes[0];
}

/** Lowercase whisper-bar summary of agent activity; "" when nothing to say. */
export function whisperText(status: AgentTrackingStatus, activeFile: string | null, agentName = "agent"): string {
  const ai = aiChanges(status.changes);
  if (status.agentActive && activeFile && ai.some((change) => change.path === activeFile)) {
    return `${agentName} is editing ${activeFile.split("/").pop()}`;
  }
  if (ai.length === 0) return "";
  const noun = ai.length === 1 ? "change" : "changes";
  return `${ai.length} ${noun} woven by ${agentName}`;
}

export type BaseSource = "agent" | "git-head";

/** AI-authored, non-binary, non-deleted files with a recoverable base diff
 * against the captured agent base; everything else against git HEAD. */
export function baseSourceFor(change: AgentChange | undefined): BaseSource {
  if (change && !change.humanTouched && change.status !== "D" && !change.binary) return "agent";
  return "git-head";
}

export function isIntegratedAgentCommand(command: string): boolean {
  const first = command.trim().split(/\s+/, 1)[0] ?? "";
  const name = first.split("/").pop()?.toLowerCase();
  return name === "claude" || name === "codex";
}
