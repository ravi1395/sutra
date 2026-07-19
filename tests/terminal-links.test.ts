import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyLink,
  extractPathCandidates,
  resolveLinkPath,
  FileLinkProvider,
  type MtimeProbe,
} from "../src/terminal";
import type { ILink } from "@xterm/xterm";

// ---- classifyLink ----

test("classifyLink: loopback hosts are localhost, everything else is external", () => {
  assert.equal(classifyLink("http://localhost:5173/x"), "localhost");
  assert.equal(classifyLink("http://127.0.0.1:8080"), "localhost");
  assert.equal(classifyLink("http://[::1]:9/"), "localhost");
  assert.equal(classifyLink("http://0.0.0.0:3000"), "localhost");
  assert.equal(classifyLink("https://github.com"), "external");
  assert.equal(classifyLink("not a url"), "external"); // unparsable -> external, never mis-routed
});

// ---- extractPathCandidates ----

test("extractPathCandidates: extracts path-ish tokens with optional :line (col dropped)", () => {
  assert.deepEqual(extractPathCandidates("src/main.ts:42"), [{ path: "src/main.ts", line: 42 }]);
  assert.deepEqual(extractPathCandidates("./a/b.rs:10:5"), [{ path: "./a/b.rs", line: 10 }]);
  assert.deepEqual(extractPathCandidates("~/x.txt"), [{ path: "~/x.txt" }]);
  assert.deepEqual(extractPathCandidates("/abs/p.ts"), [{ path: "/abs/p.ts" }]);
  assert.deepEqual(extractPathCandidates("error in (src/lib.rs:7)"), [{ path: "src/lib.rs", line: 7 }]);
});

test("extractPathCandidates: bare words with no separator/extension/:line are not extracted", () => {
  assert.deepEqual(extractPathCandidates("foo"), []);
  assert.deepEqual(extractPathCandidates("just some plain words here"), []);
});

// ---- resolveLinkPath ----

test("resolveLinkPath: tries abs-as-is -> ~ -> cwd -> workspace root in order, first hit wins", async () => {
  const calls: string[] = [];
  const ctx = { cwd: "/root/proj", workspaceRoot: "/root/other", home: "/home/user" };
  const probe: MtimeProbe = async (p) => {
    calls.push(p);
    if (p === "/root/other/~/x.txt") return 1; // only the workspace-root attempt validates
    throw new Error("ENOENT");
  };
  const resolved = await resolveLinkPath("~/x.txt", ctx, probe);
  assert.equal(resolved, "/root/other/~/x.txt");
  assert.deepEqual(calls, [
    "~/x.txt", // absolute as-is (literal)
    "/home/user/x.txt", // ~ expansion
    "/root/proj/~/x.txt", // relative against session cwd
    "/root/other/~/x.txt", // relative against workspace root
  ]);
});

test("resolveLinkPath: a candidate that never validates yields no link", async () => {
  const ctx = { cwd: "/root/proj", workspaceRoot: "/root/other", home: "/home/user" };
  const probe: MtimeProbe = async () => {
    throw new Error("ENOENT");
  };
  const resolved = await resolveLinkPath("nope/nope.ts", ctx, probe);
  assert.equal(resolved, null);
});

test("resolveLinkPath: a relative token never probes the bare literal (only cwd/root joins); an absolute token still probes as-is", async () => {
  const ctx = { cwd: "/root/proj", workspaceRoot: "/root/other", home: "/home/user" };

  const relCalls: string[] = [];
  const relProbe: MtimeProbe = async (p) => {
    relCalls.push(p);
    throw new Error("ENOENT"); // nothing validates — only the probed set matters here
  };
  await resolveLinkPath("src/main.ts", ctx, relProbe);
  assert.deepEqual(relCalls, [
    "/root/proj/src/main.ts", // relative against session cwd
    "/root/other/src/main.ts", // relative against workspace root
  ]);

  const absCalls: string[] = [];
  const absProbe: MtimeProbe = async (p) => {
    absCalls.push(p);
    if (p === "/abs/p.ts") return 1;
    throw new Error("ENOENT");
  };
  const resolved = await resolveLinkPath("/abs/p.ts", ctx, absProbe);
  assert.equal(resolved, "/abs/p.ts");
  assert.deepEqual(absCalls, ["/abs/p.ts"]); // absolute as-is, no cwd/root joins attempted
});

// ---- FileLinkProvider (modifier gating + range on a real one-line buffer) ----

/** Minimal fake single-line, unwrapped xterm buffer sufficient for FileLinkProvider —
 *  only the IBuffer/IBufferLine/IBufferCell surface it actually reads. */
function makeFakeTerm(lineText: string) {
  const chars = Array.from(lineText);
  const line = {
    isWrapped: false,
    length: chars.length,
    getCell(x: number, cell: { _set: (c: string, w: number) => void }) {
      if (x >= chars.length) return undefined;
      cell._set(chars[x], 1);
      return cell;
    },
    translateToString: () => lineText,
  };
  return {
    buffer: {
      active: {
        getLine: (y: number) => (y === 0 ? line : undefined),
        getNullCell: () => {
          let ch = "";
          let width = 0;
          return {
            getChars: () => ch,
            getWidth: () => width,
            _set: (c: string, w: number) => {
              ch = c;
              width = w;
            },
          };
        },
      },
    },
  };
}

/** Same fake, but multiple rows — `wrapped[i]` marks row i as a continuation of row i-1,
 *  exercising getWindowedLine's backward/forward wrap-chain walk and mapStrIdx's cross-row
 *  advance (the provider must read the LOGICAL line, not just the hovered visual row). */
function makeFakeTermRows(rows: string[], wrapped: boolean[]) {
  const lines = rows.map((text, i) => {
    const chars = Array.from(text);
    return {
      isWrapped: wrapped[i],
      length: chars.length,
      getCell(x: number, cell: { _set: (c: string, w: number) => void }) {
        if (x >= chars.length) return undefined;
        cell._set(chars[x], 1);
        return cell;
      },
      translateToString: () => text,
    };
  });
  return {
    buffer: {
      active: {
        getLine: (y: number) => lines[y],
        getNullCell: () => {
          let ch = "";
          let width = 0;
          return {
            getChars: () => ch,
            getWidth: () => width,
            _set: (c: string, w: number) => {
              ch = c;
              width = w;
            },
          };
        },
      },
    },
  };
}

// isMod() checks metaKey on Mac, ctrlKey elsewhere (src/shortcuts.ts); IS_MAC reads
// navigator.userAgent, which under node:test is not a Mac UA, so ctrlKey is what gates here
// (matches tests/shortcuts.test.ts's own "non-Mac" comment for the same reason).
function fakeMouseEvent(mod: boolean): MouseEvent {
  return { metaKey: false, ctrlKey: mod } as unknown as MouseEvent;
}

test("FileLinkProvider: surfaces only validated paths, with a correct buffer range", async () => {
  const text = "cargo build failed at src/main.ts:42 — see log";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const term = makeFakeTerm(text) as any;
  const activated: Array<{ absPath: string; line?: number }> = [];
  const provider = new FileLinkProvider(
    term,
    () => "/root/proj",
    () => "/root/other",
    async (p) => {
      if (p === "/root/proj/src/main.ts") return 1;
      throw new Error("ENOENT");
    },
    (absPath, line) => activated.push({ absPath, line }),
  );

  const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
  assert.ok(links && links.length === 1, "expected exactly one resolved link");
  const link = links![0];
  assert.equal(link.text, "src/main.ts:42");
  const startIdx = text.indexOf("src/main.ts:42");
  assert.deepEqual(link.range.start, { x: startIdx + 1, y: 1 });
  assert.deepEqual(link.range.end, { x: startIdx + "src/main.ts:42".length, y: 1 });

  // Modifier gating: no-op without isMod.
  link.activate(fakeMouseEvent(false), link.text);
  assert.deepEqual(activated, []);

  // Modifier-click activates with the resolved path + extracted line.
  link.activate(fakeMouseEvent(true), link.text);
  assert.deepEqual(activated, [{ absPath: "/root/proj/src/main.ts", line: 42 }]);
});

test("FileLinkProvider: reads the logical wrapped line, not just the hovered visual row", async () => {
  // A path token straddling the wrap boundary: row0 ends mid-path, row1 (isWrapped) continues it.
  const row0 = "cargo build failed at src/ver";
  const row1 = "ylong/main.ts:9 — see log";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const term = makeFakeTermRows([row0, row1], [false, true]) as any;
  const activated: Array<{ absPath: string; line?: number }> = [];
  const provider = new FileLinkProvider(
    term,
    () => "/root/proj",
    () => null,
    async (p) => {
      if (p === "/root/proj/src/verylong/main.ts") return 1;
      throw new Error("ENOENT");
    },
    (absPath, line) => activated.push({ absPath, line }),
  );

  // Hover the SECOND (continuation) row — the provider must still recover the full logical line.
  const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(2, resolve));
  assert.ok(links && links.length === 1, "expected exactly one resolved link spanning both rows");
  const link = links![0];
  assert.equal(link.text, "src/verylong/main.ts:9");

  const full = row0 + row1;
  const token = "src/verylong/main.ts:9";
  const startIdx = full.indexOf(token);
  const endIdx = startIdx + token.length; // exclusive
  const rowColFor = (charIdx: number) =>
    charIdx < row0.length ? { row: 0, col: charIdx } : { row: 1, col: charIdx - row0.length };
  const startRC = rowColFor(startIdx);
  const endRC = rowColFor(endIdx);

  assert.deepEqual(link.range.start, { x: startRC.col + 1, y: startRC.row + 1 });
  assert.deepEqual(link.range.end, { x: endRC.col, y: endRC.row + 1 });
  // The range genuinely spans the two rows (proves the cross-row advance, not a single-row fluke).
  assert.equal(startRC.row, 0);
  assert.equal(endRC.row, 1);

  link.activate(fakeMouseEvent(true), link.text);
  assert.deepEqual(activated, [{ absPath: "/root/proj/src/verylong/main.ts", line: 9 }]);
});

test("FileLinkProvider: a line with no path-ish tokens yields no links", async () => {
  const term = makeFakeTerm("just some plain words here") as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const provider = new FileLinkProvider(
    term,
    () => null,
    () => null,
    async () => 1,
    () => {},
  );
  const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
  assert.equal(links, undefined);
});

// ---- WebLinksAddon (URL) modifier gating — verified at the source level: the handler wired in
// TerminalManager.create() is not independently callable without a live xterm+DOM instance
// (same constraint terminal-settings.test.ts works under for other create()-internal wiring). ----

test("terminal.ts: URL link activation is gated on isMod — plain click is a no-op, no fallback open", () => {
  const terminalTs = readFileSync("src/terminal.ts", "utf8");
  assert.match(
    terminalTs,
    /const webLinks = new WebLinksAddon\(\(event: MouseEvent, uri: string\) => \{\s*if \(!isMod\(event\)\) return;\s*this\.onUrlActivate\?\.\(uri, classifyLink\(uri\)\);\s*\}\);/,
  );
  // No unconditional window.open fallback left over from the old always-on behavior.
  assert.doesNotMatch(terminalTs, /window\.open\(uri/);
});
