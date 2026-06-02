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
      let oursEnd = i + 1;
      let theirsStart = -1;
      let theirsEnd = -1;
      let theirsMarkerLine = -1;

      // Skip to separator (======= or |||||||)
      while (i < lines.length && !lines[i].startsWith("=======")) {
        i++;
      }
      if (i >= lines.length) {
        i = oursStart + 1;
        continue;
      }
      oursEnd = i; // Line before the separator
      theirsStart = i; // = marker line

      // Skip base section if present (|||||||)
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        if (lines[i].startsWith("|||||||")) {
          // Move past base marker; find the end marker
          while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
            i++;
          }
        } else {
          i++;
        }
      }

      if (i >= lines.length) {
        i = oursStart + 1;
        continue;
      }

      theirsEnd = i; // Line number of the >>>>>>> marker (exclusive for theirs content)
      theirsMarkerLine = i;

      regions.push({
        oursStart,
        oursEnd,
        theirsStart,
        theirsEnd,
        theirsMarkerLine,
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
