// Pure ranking/token logic behind the <task> CM6 completion sources. The CM6
// wiring (Task 10) calls these; keeping them pure makes them testable without
// a live editor. `invocation` is produced by scan_agent_assets (kind-specific).
export interface AssetOption {
  kind: "skill" | "command" | "subagent";
  name: string;
  invocation: string;
}

/** Case-insensitive subsequence match: every query char appears in order. */
function subseq(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

export function matchFiles(query: string, files: string[], cap = 20): string[] {
  return files
    .filter((f) => subseq(query, f))
    .sort((a, b) => a.length - b.length)
    .slice(0, cap);
}

export function matchAssets(query: string, assets: AssetOption[], cap = 20): AssetOption[] {
  return assets
    .filter((a) => subseq(query, a.name))
    .sort((a, b) => a.name.length - b.name.length)
    .slice(0, cap);
}

export function fileToken(path: string): string {
  return `@${path}`;
}

export function assetToken(a: AssetOption): string {
  return a.invocation;
}
