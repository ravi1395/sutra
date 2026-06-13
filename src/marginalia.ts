import type { DiffKind, Hunk } from "./diff";

export const AI_STITCH_MAX_PX = 120;

export interface AiRange {
  startLine: number;
  endLine: number;
  agent: string;
}

export type MarginEntry =
  | { kind: "hunk"; topPx: number; heightPx: number; hunkIndex: number; color: DiffKind }
  | { kind: "ai"; topPx: number; heightPx: number; agent: string };

/** Compute editor marginalia entries for the document given line height. */
export function marginEntries(
  hunks: readonly Hunk[],
  ai: readonly AiRange[],
  lineHeightPx: number,
): MarginEntry[] {
  const out: MarginEntry[] = [];
  const lineHeight = Math.max(1, lineHeightPx);

  hunks.forEach((hunk, hunkIndex) => {
    out.push({
      kind: "hunk",
      topPx: hunk.newFrom * lineHeight,
      heightPx: Math.max(1, hunk.newTo - hunk.newFrom) * lineHeight,
      hunkIndex,
      color: hunk.kind,
    });
  });

  for (const range of ai) {
    out.push({
      kind: "ai",
      topPx: range.startLine * lineHeight,
      heightPx: Math.min(AI_STITCH_MAX_PX, Math.max(1, range.endLine - range.startLine + 1) * lineHeight),
      agent: range.agent,
    });
  }

  return out.sort((a, b) => a.topPx - b.topPx);
}
