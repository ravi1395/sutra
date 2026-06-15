// Pure helper for inline debug value hints: maps identifier tokens on a source
// line to their current values from the paused scope. Kept standalone (not in
// editor.ts) so it unit-tests without pulling CodeMirror into the test bundle.

export interface InlineHint {
  col: number; // column at the end of the identifier token (0-based offset in the line)
  name: string;
  value: string;
}

/**
 * Map identifier tokens on a source line to their current values from `scope`.
 * Side-effect free; the CM6 widget layer consumes the result. Returns hints in
 * source order, capped at `max` to avoid clutter.
 */
export function matchIdentifiers(line: string, scope: Map<string, string>, max = 8): InlineHint[] {
  const hints: InlineHint[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) && hints.length < max) {
    const value = scope.get(m[0]);
    if (value !== undefined) hints.push({ col: m.index + m[0].length, name: m[0], value });
  }
  return hints;
}
