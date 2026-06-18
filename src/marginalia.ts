export const AI_STITCH_MAX_PX = 120;

export interface AiRange {
  startLine: number;
  endLine: number;
  agent: string;
}

export interface MarginEntry {
  topPx: number;
  heightPx: number;
  agent: string;
}

/** Compute AI-attribution stitch entries for the editor margin, sorted top-down. */
export function marginEntries(ai: readonly AiRange[], lineHeightPx: number): MarginEntry[] {
  const lineHeight = Math.max(1, lineHeightPx);
  return ai
    .map((range) => ({
      topPx: range.startLine * lineHeight,
      heightPx: Math.min(AI_STITCH_MAX_PX, Math.max(1, range.endLine - range.startLine + 1) * lineHeight),
      agent: range.agent,
    }))
    .sort((a, b) => a.topPx - b.topPx);
}
