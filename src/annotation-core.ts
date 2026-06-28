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
  /^[0-9a-f]{6,}$/i,  // long hex-ish hash (whole-id match)
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

export interface LocationShape { pathname: string; search: string; hash: string }
export interface RouteOpts { hashRouting?: boolean }

export function routeKey(targetOrigin: string, loc: LocationShape, opts: RouteOpts = {}): string {
  const base = `${targetOrigin}${loc.pathname}${loc.search}`;
  return opts.hashRouting ? `${base}${loc.hash}` : base;
}

export interface Hints { testid?: string; role?: string; aria?: string; text?: string }
export interface Annotation {
  n: number; selector: string; tag: string; html: string;
  styles: Record<string, string>; hints: Hints; feedback: string;
  route: string; stale?: boolean; ambiguous?: boolean;
}
export interface PickedPayload {
  selector: string; tag: string; html: string;
  styles: Record<string, string>; hints: Hints; ambiguous?: boolean;
}
export type AnnAction =
  | { type: "picked"; payload: PickedPayload; route: string }
  | { type: "setFeedback"; n: number; text: string }
  | { type: "remove"; n: number }
  | { type: "reanchorResult"; route: string; resolved: string[] };

export function reduce(state: Annotation[], action: AnnAction): Annotation[] {
  switch (action.type) {
    case "picked": {
      const n = state.reduce((m, a) => Math.max(m, a.n), 0) + 1;
      return [...state, { ...action.payload, n, feedback: "", route: action.route }];
    }
    case "setFeedback":
      return state.map((a) => (a.n === action.n ? { ...a, feedback: action.text } : a));
    case "remove":
      return state.filter((a) => a.n !== action.n);
    case "reanchorResult":
      return state.map((a) =>
        a.route === action.route
          ? { ...a, stale: !action.resolved.includes(a.selector) }
          : a,
      );
  }
}

export function isTrustedMessage(
  e: { origin: string; source: unknown },
  expectedOrigin: string,
  expectedSource: unknown,
): boolean {
  return e.origin === expectedOrigin && e.source === expectedSource;
}

export type UiQuery = "openTabs" | "selection" | "annotations";
export interface UiProviders {
  openTabs: () => unknown;
  selection: () => unknown;
  annotations: () => unknown;
}
export function resolveUiQuery(
  query: string,
  p: UiProviders,
): { ok: true; payload: unknown } | { ok: false } {
  switch (query) {
    case "openTabs":
      return { ok: true, payload: { tabs: p.openTabs() } };
    case "selection":
      return { ok: true, payload: p.selection() };
    case "annotations":
      return { ok: true, payload: p.annotations() };
    default:
      return { ok: false };
  }
}
