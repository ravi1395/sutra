// Pure computation of handoff candidates: which files a task's linked turns
// touched (reviewed), which changed files no linked turn claims (unlinked),
// and which reviewed files drifted after review (stale). No git writes, no
// IPC calls, no process spawns — every input is supplied by the caller so
// this stays independently testable and reusable from any future UI/IPC seam.
import type { GitStatusEntry, Turn } from "./ipc";

/** Content hash lookup keyed by repo-relative path.
 *
 * Open-question default (per plan): the reviewed-hash source is the turn
 * snapshot blob store (content-addressed objects; see turns.rs) for files a
 * linked turn touched. This module does not call Rust or compute hashes
 * itself — a later phase resolves turns.rs snapshots into this map and
 * passes it in. A path with no entry has no reviewed baseline. */
export type HashMap = Readonly<Record<string, string>>;

export type HandoffFileOrigin = "linked" | "unlinked";

export interface HandoffCandidateFile {
  path: string;
  /** Raw git status for this path ("M" | "A" | "D"). */
  gitStatus: GitStatusEntry["status"];
  /** "linked" = touched by at least one of the task's linked turns (has a
   * reviewed baseline, if the caller supplied one). "unlinked" = changed
   * outside every linked turn — no baseline exists, ever ("Files changed
   * OUTSIDE any turn have NO baseline -> classify as unlinked/unreviewed,
   * never 'reviewed'" per plan). */
  origin: HandoffFileOrigin;
  /** Reviewed content hash from the caller-supplied HashMap, or null when no
   * linked turn recorded a baseline for this path. */
  reviewedHash: string | null;
  /** Current content hash from the caller-supplied HashMap, or null when the
   * path is deleted or the caller has no current hash for it. */
  currentHash: string | null;
  /** Explicit flag for a deleted path (git status "D"); deleted paths are
   * always represented here, never dropped silently. */
  deleted: boolean;
  /** True when a reviewed baseline exists and the current content no longer
   * matches it (includes: reviewed then deleted). Warning-only — never
   * implies auto-selection. */
  stale: boolean;
  /** Whether a handoff UI should pre-check this file. Only linked,
   * non-stale, non-deleted files default to selected; unlinked and stale
   * files are always surfaced unselected (criteria 1 and 3). */
  selectedByDefault: boolean;
}

export interface HandoffCandidates {
  enabled: boolean;
  /** Explicit "nothing to hand off" / disabled reason; null when enabled. */
  disabledReason: string | null;
  files: readonly HandoffCandidateFile[];
}

export interface HandoffInput {
  /** Current git status for the root. `null` means no usable git status was
   * available to the caller — e.g. not a Git repository, or a git command
   * failed (a later phase also uses this sentinel for a detached HEAD with
   * no usable diff base). This module never spawns git itself; it only
   * reacts to what the caller already resolved. */
  gitStatus: readonly GitStatusEntry[] | null;
  /** The task's linked turns (already resolved from Task.turnIds by the
   * caller, e.g. `getTurns(root).filter(t => task.turnIds.includes(t.id))`).
   * Only `files[].path` membership is used here. */
  linkedTurns: readonly Pick<Turn, "id" | "files">[];
  /** Reviewed baseline hash per path; see HashMap doc. */
  reviewedHashes: HashMap;
  /** Current content hash per path, for paths that still exist. */
  currentHashes: HashMap;
}

const disabled = (reason: string): HandoffCandidates => ({ enabled: false, disabledReason: reason, files: [] });

/** Compute handoff candidates for one task from its linked turns and the
 * current git status. Pure: no I/O, no mutation, deterministic on its inputs. */
export function computeHandoffCandidates(input: HandoffInput): HandoffCandidates {
  if (input.gitStatus === null) {
    return disabled("No git status available (not a Git repository, or no usable diff base for the current HEAD).");
  }
  if (input.gitStatus.length === 0) {
    return disabled("Nothing to hand off — no changed files.");
  }

  const linkedPaths = new Set<string>();
  for (const turn of input.linkedTurns) {
    for (const file of turn.files) linkedPaths.add(file.path);
  }

  const files: HandoffCandidateFile[] = input.gitStatus
    .map((entry): HandoffCandidateFile => {
      const deleted = entry.status === "D";
      const origin: HandoffFileOrigin = linkedPaths.has(entry.path) ? "linked" : "unlinked";
      // Unlinked paths never have a reviewed baseline, regardless of what a
      // caller's hash map happens to contain for that path.
      const reviewedHash = origin === "linked" ? input.reviewedHashes[entry.path] ?? null : null;
      const currentHash = deleted ? null : input.currentHashes[entry.path] ?? null;
      const stale = reviewedHash !== null && currentHash !== reviewedHash;
      const selectedByDefault = origin === "linked" && !stale && !deleted;
      return { path: entry.path, gitStatus: entry.status, origin, reviewedHash, currentHash, deleted, stale, selectedByDefault };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { enabled: true, disabledReason: null, files };
}

/** Files touched by a linked turn (the reviewed set) — may still include
 * stale entries; see `staleWarnings`. */
export function reviewedFiles(candidates: HandoffCandidates): HandoffCandidateFile[] {
  return candidates.files.filter((file) => file.origin === "linked");
}

/** Changed files no linked turn claims. Never auto-selected (criterion 3);
 * a handoff UI must surface these separately for explicit user choice. */
export function unlinkedFiles(candidates: HandoffCandidates): HandoffCandidateFile[] {
  return candidates.files.filter((file) => file.origin === "unlinked");
}

/** Reviewed files whose content changed after review (or were deleted after
 * review). Warning-only — never auto-selected (criterion 1). */
export function staleWarnings(candidates: HandoffCandidates): HandoffCandidateFile[] {
  return candidates.files.filter((file) => file.stale);
}
