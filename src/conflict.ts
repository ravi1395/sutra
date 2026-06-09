// Merge conflict parsing and resolution helpers.

export interface ConflictRegion {
  oursStart: number; // Line number of <<<<<< marker
  oursEnd: number;   // Exclusive line number (line before =======)
  theirsStart: number; // Line number of ======= marker
  theirsEnd: number;   // Exclusive line number (line before >>>>>>>)
  theirsMarkerLine: number; // Line number of >>>>>>> marker
}

/// Parse conflict regions marked by <<<<<<<, =======, >>>>>>>. Ignores ||||||| base markers.
export function parseConflicts(text: string): ConflictRegion[] {
  const lines = text.split("\n");
  const regions: ConflictRegion[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const oursStart = i;
      i++;

      // Ours content runs until the diff3 base marker (|||||||) or the separator.
      while (
        i < lines.length &&
        !lines[i].startsWith("=======") &&
        !lines[i].startsWith("|||||||")
      ) {
        i++;
      }
      const oursEnd = i; // first marker line after ours content

      // Skip a diff3 base section (||||||| ... ) up to the separator.
      if (i < lines.length && lines[i].startsWith("|||||||")) {
        while (i < lines.length && !lines[i].startsWith("=======")) {
          i++;
        }
      }
      if (i >= lines.length) {
        i = oursStart + 1;
        continue;
      }
      const theirsStart = i; // ======= marker line

      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        i++;
      }
      if (i >= lines.length) {
        i = oursStart + 1;
        continue;
      }

      regions.push({
        oursStart,
        oursEnd,
        theirsStart,
        theirsEnd: i, // >>>>>>> marker line (exclusive end of theirs content)
        theirsMarkerLine: i,
      });

      i++;
    } else {
      i++;
    }
  }

  return regions;
}

/// Return the document with the given conflict region resolved to our version.
export function acceptOurs(text: string, region: ConflictRegion): string {
  const lines = text.split("\n");
  // Remove from <<<<<<< to ======= (inclusive)
  // Keep from after ======= to before >>>>>>>
  // Then remove to end of >>>>>>>> (exclusive after)
  const ourLines = lines.slice(region.oursStart + 1, region.oursEnd);
  const before = lines.slice(0, region.oursStart);
  const after = lines.slice(region.theirsMarkerLine + 1);
  return [...before, ...ourLines, ...after].join("\n");
}

/// Return the document with the given conflict region resolved to their version.
export function acceptTheirs(text: string, region: ConflictRegion): string {
  const lines = text.split("\n");
  // Remove from <<<<<<< to after =======
  // Keep from after ======= to before >>>>>>>
  // Then remove to end of >>>>>>>> (exclusive after)
  const theirLines = lines.slice(region.theirsStart + 1, region.theirsEnd);
  const before = lines.slice(0, region.oursStart);
  const after = lines.slice(region.theirsMarkerLine + 1);
  return [...before, ...theirLines, ...after].join("\n");
}

export type ConflictChoice = "ours" | "theirs" | "both";

/// Re-parse `text` and resolve the conflict at `index`. Returns null when the
/// index no longer matches a region (stale UI) so callers never apply stale
/// line ranges to a changed document.
export function resolveConflictAtIndex(
  text: string,
  index: number,
  choice: ConflictChoice,
): string | null {
  const regions = parseConflicts(text);
  const region = regions[index];
  if (!region) return null;
  if (choice === "ours") return acceptOurs(text, region);
  if (choice === "theirs") return acceptTheirs(text, region);
  return acceptBoth(text, region);
}

/// Return the document with both ours and theirs content, removing conflict markers.
export function acceptBoth(text: string, region: ConflictRegion): string {
  const lines = text.split("\n");
  // Keep ours (oursStart+1 to oursEnd), keep theirs (theirsStart+1 to theirsEnd)
  const ourLines = lines.slice(region.oursStart + 1, region.oursEnd);
  const theirLines = lines.slice(region.theirsStart + 1, region.theirsEnd);
  const before = lines.slice(0, region.oursStart);
  const after = lines.slice(region.theirsMarkerLine + 1);
  return [...before, ...ourLines, ...theirLines, ...after].join("\n");
}
