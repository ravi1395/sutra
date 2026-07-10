import type { Annotation } from "./annotation-core";

export const MAX_CONTEXT_ANNOTATIONS = 20;
export const MAX_CONTEXT_BYTES = 16 * 1024;

export interface AnnotationContextPack {
  text: string;
  includedIds: string[];
  omittedIds: string[];
  staleIds: string[];
}

export function annotationId(annotation: Pick<Annotation, "route" | "n">): string {
  return `${annotation.route}#${annotation.n}`;
}

function line(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : "";
}

/** Build a deterministic, bounded prompt context. Raw HTML/styles are omitted
 * deliberately: annotations must not exfiltrate form values or frame data. */
export function buildAnnotationContextPack(
  annotations: readonly Annotation[],
  taskAnnotationIds: readonly string[],
  currentRoot: string,
  currentRoute: string,
  includeStaleIds: readonly string[] = [],
): AnnotationContextPack {
  const wanted = new Set(taskAnnotationIds);
  const allowStale = new Set(includeStaleIds);
  // The annotation file is already root-scoped by its persistence path. A
  // task may legitimately collect feedback from several routes, so retain
  // every linked route and identify it inside each block.
  const candidates = annotations
    .filter((a) => wanted.has(annotationId(a)))
    .sort((left, right) => Number(right.route === currentRoute) - Number(left.route === currentRoute));
  const includedIds: string[] = [];
  const omittedIds: string[] = [];
  const staleIds: string[] = [];
  const candidateIds = new Set(candidates.map((annotation) => annotationId(annotation)));
  // Deleted/corrupt annotations can leave a durable task id behind. Surface
  // that dangling link instead of silently staging an incomplete pack.
  omittedIds.push(...taskAnnotationIds.filter((id) => !candidateIds.has(id)));
  const sections: string[] = [`Visual feedback for ${currentRoot}`, `Route: ${currentRoute}`];
  const selected = new Set<string>();
  const routes = [...new Set(candidates.map((annotation) => annotation.route))];
  // Reserve one deterministic annotation per linked route before filling the
  // remaining budget. This prevents a busy route from starving another route.
  const firstByRoute = routes.map((route) => candidates.find((annotation) => annotation.route === route)!);
  const firstIds = new Set(firstByRoute.map((annotation) => annotationId(annotation)));
  const ordered = [...firstByRoute, ...candidates.filter((annotation) => !firstIds.has(annotationId(annotation)))];
  for (const annotation of ordered) {
    const id = annotationId(annotation);
    if (selected.has(id)) continue;
    if (annotation.stale) staleIds.push(id);
    if (annotation.stale && !allowStale.has(id)) { omittedIds.push(id); continue; }
    if (includedIds.length >= MAX_CONTEXT_ANNOTATIONS) { omittedIds.push(id); continue; }
    const block = [
      `Annotation ${annotation.n}${annotation.stale ? " [STALE]" : ""}`,
      line("Route", annotation.route),
      line("Feedback", annotation.feedback.trim()),
      line("Selector", annotation.selector),
      line("Tag", annotation.tag),
      line("Test id", annotation.hints.testid),
      line("Role", annotation.hints.role),
      line("ARIA label", annotation.hints.aria),
      line("Visible text hint", annotation.hints.text),
    ].filter(Boolean).join("\n");
    const next = [...sections, block].join("\n\n");
    if (new TextEncoder().encode(next).length > MAX_CONTEXT_BYTES) { omittedIds.push(id); continue; }
    sections.push(block);
    includedIds.push(id);
    selected.add(id);
  }
  return { text: sections.join("\n\n"), includedIds, omittedIds, staleIds };
}
