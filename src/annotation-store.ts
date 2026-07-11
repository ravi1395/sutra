import { createDir, readFile, writeFile } from "./ipc";
import type { Annotation } from "./annotation-core";

export const ANNOTATIONS_FILE = ".sutra/annotations.json";
export const ANNOTATIONS_VERSION = 1;
export const ANNOTATIONS_GITIGNORE_ENTRY = ANNOTATIONS_FILE;

export interface AnnotationLoadResult { annotations: Annotation[]; warnings: string[]; }

/** Before the iframe reports its route after restart, the current route is
 * unknown. Returning nothing (rather than every route's annotations) avoids
 * exposing other pages' feedback through the MCP provider or the side list
 * during that short readiness window; both self-correct once `ready` fires. */
export function annotationsForRoute(annotations: readonly Annotation[], route: string): Annotation[] {
  return route ? annotations.filter((annotation) => annotation.route === route) : [];
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
    // Dedup key is the full route-scoped id: a hand-merged file can legitimately
    // carry the same `n` on different routes, and those must not collide.
    const seen = new Set<string>();
    for (const value of parsed.annotations) {
      if (!validAnnotation(value)) { continue; }
      const id = `${value.route}#${value.n}`;
      if (seen.has(id)) continue;
      seen.add(id);
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

/** File-system seam for annotation persistence; injected only by focused tests,
 * mirroring tasks.ts's TaskPersistence. */
export interface AnnotationPersistence {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  createDir(path: string): Promise<void>;
}

const defaultPersistence: AnnotationPersistence = { read: readFile, write: writeFile, createDir };

export async function loadAnnotations(root: string, persistence: AnnotationPersistence = defaultPersistence): Promise<AnnotationLoadResult> {
  try { return parseAnnotationsFile(await persistence.read(`${root}/${ANNOTATIONS_FILE}`)); }
  catch { return { annotations: [], warnings: [] }; }
}

export async function saveAnnotations(root: string, annotations: readonly Annotation[], persistence: AnnotationPersistence = defaultPersistence): Promise<void> {
  await persistence.createDir(`${root}/.sutra`);
  const path = `${root}/${ANNOTATIONS_FILE}`;
  // Gitignore is a first-save migration only. If a user deliberately
  // un-ignores the metadata after the first save, later edits preserve that
  // choice.
  const alreadySaved = await persistence.read(path).then(() => true).catch(() => false);
  if (!alreadySaved) {
    const gitignore = `${root}/.gitignore`;
    const current = await persistence.read(gitignore).catch(() => "");
    await persistence.write(gitignore, addAnnotationsGitignoreEntry(current));
  }
  await persistence.write(path, serializeAnnotations(annotations));
}

/** Quarantine a corrupt/partial annotations file before any repair-by-save can
 * overwrite it. Skips the write when an identical backup already exists, so
 * repeated loads of the same broken file don't clobber a user's recovered
 * `.bak` edits; a differing corrupt read is still backed up. */
export async function backupCorruptAnnotationsFile(root: string, persistence: AnnotationPersistence = defaultPersistence): Promise<void> {
  const path = `${root}/${ANNOTATIONS_FILE}`;
  const raw = await persistence.read(path).catch(() => null);
  if (raw === null) return;
  const bakPath = `${path}.bak`;
  const existing = await persistence.read(bakPath).catch(() => null);
  if (existing === raw) return;
  await persistence.write(bakPath, raw);
}
