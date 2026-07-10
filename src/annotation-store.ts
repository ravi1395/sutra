import { createDir, readFile, writeFile } from "./ipc";
import type { Annotation } from "./annotation-core";

export const ANNOTATIONS_FILE = ".sutra/annotations.json";
export const ANNOTATIONS_VERSION = 1;
export const ANNOTATIONS_GITIGNORE_ENTRY = ANNOTATIONS_FILE;

export interface AnnotationLoadResult { annotations: Annotation[]; warnings: string[]; }

/** Before the iframe reports its route after restart, the state is still
 * safely root-scoped by this store. Returning the hydrated set avoids an
 * empty MCP response during that short readiness window. */
export function annotationsForRoute(annotations: readonly Annotation[], route: string): Annotation[] {
  return route ? annotations.filter((annotation) => annotation.route === route) : [...annotations];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validAnnotation(value: unknown): value is Annotation {
  if (!record(value)) return false;
  return typeof value.n === "number" && Number.isFinite(value.n)
    && typeof value.selector === "string" && typeof value.tag === "string"
    && typeof value.html === "string" && record(value.styles)
    && record(value.hints) && typeof value.feedback === "string"
    && typeof value.route === "string"
    && (value.stale === undefined || typeof value.stale === "boolean")
    && (value.ambiguous === undefined || typeof value.ambiguous === "boolean");
}

export function parseAnnotationsFile(raw: string): AnnotationLoadResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== ANNOTATIONS_VERSION || !Array.isArray(parsed.annotations)) {
      return { annotations: [], warnings: ["Annotations file has an unsupported format."] };
    }
    const annotations: Annotation[] = [];
    const seen = new Set<number>();
    for (const value of parsed.annotations) {
      if (!validAnnotation(value)) { continue; }
      if (seen.has(value.n)) continue;
      seen.add(value.n);
      annotations.push(value);
    }
    const skipped = parsed.annotations.length - annotations.length;
    return { annotations, warnings: skipped ? [`Ignored ${skipped} invalid or duplicate annotation(s).`] : [] };
  } catch {
    return { annotations: [], warnings: ["Annotations file is malformed; no annotations were written."] };
  }
}

export function serializeAnnotations(annotations: readonly Annotation[]): string {
  return `${JSON.stringify({ version: ANNOTATIONS_VERSION, annotations }, null, 2)}\n`;
}

export function addAnnotationsGitignoreEntry(contents: string): string {
  if (contents.split(/\r?\n/).includes(ANNOTATIONS_GITIGNORE_ENTRY)) return contents;
  return `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${ANNOTATIONS_GITIGNORE_ENTRY}\n`;
}

export async function loadAnnotations(root: string): Promise<AnnotationLoadResult> {
  try { return parseAnnotationsFile(await readFile(`${root}/${ANNOTATIONS_FILE}`)); }
  catch { return { annotations: [], warnings: [] }; }
}

export async function saveAnnotations(root: string, annotations: readonly Annotation[]): Promise<void> {
  await createDir(`${root}/.sutra`);
  const path = `${root}/${ANNOTATIONS_FILE}`;
  // Gitignore is a first-save migration only. If a user deliberately
  // un-ignores the metadata after the first save, later edits preserve that
  // choice.
  const alreadySaved = await readFile(path).then(() => true).catch(() => false);
  if (!alreadySaved) {
    const gitignore = `${root}/.gitignore`;
    const current = await readFile(gitignore).catch(() => "");
    await writeFile(gitignore, addAnnotationsGitignoreEntry(current));
  }
  await writeFile(path, serializeAnnotations(annotations));
}
