// annotation-core.ts — pure DOM-independent helpers for stable selector generation
export interface NodeShape {
  id: string | null;
  tag: string;       // lowercased tagName
  typeIndex: number; // 1-based index among same-tag siblings
  parent: NodeShape | null;
}

const UNSTABLE_ID = [
  /^:/,              // React useId (":r3:")
  /^(css|sc|emotion)-/i, // CSS-in-JS
  /[0-9a-f]{6,}/i,  // long hex-ish hash
];

export function isStableId(id: string): boolean {
  if (!id || !/^[A-Za-z][\w-]*$/.test(id)) return false;
  return !UNSTABLE_ID.some((re) => re.test(id));
}

export function selectorFor(node: NodeShape): string {
  if (node.id && isStableId(node.id)) return `#${node.id}`;
  const parts: string[] = [];
  let cur: NodeShape | null = node;
  while (cur) {
    if (cur.id && isStableId(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    parts.unshift(`${cur.tag}:nth-of-type(${cur.typeIndex})`);
    cur = cur.parent;
  }
  return parts.join(" > ");
}
