// Tests for the DAP client: request/response correlation, reverse-request
// handling, state transitions, and the initialized-gated launch sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DapClient,
  detectAdapter,
  resolveLaunchConfig,
  requiresTrustPrompt,
  breakpointStore,
  buildSetBreakpointsArgs,
  breakpointStoreKey,
  loadBreakpointStore,
  saveBreakpointStore,
  type DapTransport,
} from "../src/debug";
import { bpGlyphChar } from "../src/editor";
import { popoverFieldsEnabled } from "../src/breakpoint-popover";

// node:test runs without DOM localStorage; per-root breakpoint persistence
// needs a shim (mirrors settings.test.ts — not relied upon across files).
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}

class MockTransport implements DapTransport {
  sent: any[] = [];
  private cb: (m: string) => void = () => {};
  onMessage(cb: (m: string) => void) {
    this.cb = cb;
  }
  send(m: string) {
    this.sent.push(JSON.parse(m));
  }
  emit(obj: any) {
    this.cb(JSON.stringify(obj));
  }
  lastRequest() {
    return this.sent.filter((m) => m.type === "request").at(-1);
  }
}

test("resolves a request by request_seq", async () => {
  const tr = new MockTransport();
  const c = new DapClient(tr);
  const p = c.request("threads");
  const seq = tr.lastRequest().seq;
  tr.emit({ type: "response", request_seq: seq, command: "threads", success: true, body: { threads: [1] } });
  assert.deepEqual(await p, { threads: [1] });
});

test("rejects a failed response", async () => {
  const tr = new MockTransport();
  const c = new DapClient(tr);
  const p = c.request("evaluate");
  const seq = tr.lastRequest().seq;
  tr.emit({ type: "response", request_seq: seq, command: "evaluate", success: false, message: "boom" });
  await assert.rejects(p, /boom/);
});

test("stopped event moves state to paused", () => {
  const tr = new MockTransport();
  const c = new DapClient(tr);
  tr.emit({ type: "event", event: "stopped", body: { reason: "breakpoint" } });
  assert.equal(c.state, "paused");
});

test("answers runInTerminal reverse request with a pid", async () => {
  const tr = new MockTransport();
  const c = new DapClient(tr);
  c.onRunInTerminal = async () => 4321;
  tr.emit({ seq: 99, type: "request", command: "runInTerminal", arguments: { args: ["python", "x.py"] } });
  await new Promise((r) => setTimeout(r, 0));
  const resp = tr.sent.find((m) => m.type === "response" && m.request_seq === 99);
  assert.ok(resp?.success && resp.body.processId === 4321);
});

test("config sequence fires on initialized event, not the launch response", async () => {
  const tr = new MockTransport();
  const c = new DapClient(tr);
  const order: string[] = [];
  // auto-ack every outgoing request; record command order
  const drive = setInterval(() => {
    const req = tr.sent.find((m) => m.type === "request" && !m.__acked);
    if (!req) return;
    req.__acked = true;
    order.push(req.command);
    tr.emit({ type: "response", request_seq: req.seq, command: req.command, success: true, body: {} });
    if (req.command === "initialize") tr.emit({ type: "event", event: "initialized" });
  }, 0);
  const bps = new Map([["/x.rs", [{ line: 1 }]]]);
  await c.launch({ type: "lldb", request: "launch", program: "/bin/true" }, bps);
  clearInterval(drive);
  // setBreakpoints is gated on the initialized event, which only fires after initialize
  assert.ok(order.indexOf("setBreakpoints") > order.indexOf("initialize"));
  assert.ok(order.indexOf("configurationDone") > order.indexOf("setExceptionBreakpoints"));
});

test("launch forwards adapter breakpoint verification to onVerified", async () => {
  const tr = new MockTransport();
  const c = new DapClient(tr);
  const drive = setInterval(() => {
    const req = tr.sent.find((m) => m.type === "request" && !m.__acked);
    if (!req) return;
    req.__acked = true;
    // setBreakpoints echoes back a verified breakpoint relocated to line 2.
    const body = req.command === "setBreakpoints" ? { breakpoints: [{ verified: true, line: 2 }] } : {};
    tr.emit({ type: "response", request_seq: req.seq, command: req.command, success: true, body });
    if (req.command === "initialize") tr.emit({ type: "event", event: "initialized" });
  }, 0);
  const verified: { path: string; bps: { verified?: boolean; line?: number }[] }[] = [];
  const bps = new Map([["/x.rs", [{ line: 1 }]]]);
  await c.launch({ type: "lldb", request: "launch", program: "/bin/true" }, bps, ["uncaught"], (path, b) =>
    verified.push({ path, bps: b }),
  );
  clearInterval(drive);
  assert.deepEqual(verified, [{ path: "/x.rs", bps: [{ verified: true, line: 2 }] }]);
});

test("detects codelldb from Cargo.toml (socket, not from workspace)", () => {
  const spec = detectAdapter(new Set(["Cargo.toml"]), "/usr/local/bin/codelldb");
  assert.equal(spec?.type, "lldb");
  assert.equal(spec?.transport.kind, "socket");
  assert.equal(spec?.fromWorkspace, false);
});

test("does not detect Rust adapter when codelldb path is missing", () => {
  assert.equal(detectAdapter(new Set(["Cargo.toml"]), null), null);
});

test("detects debugpy from pyproject.toml", () => {
  const spec = detectAdapter(new Set(["pyproject.toml"]), null);
  assert.equal(spec?.type, "python");
  assert.deepEqual((spec?.transport as any).args, ["-m", "debugpy.adapter"]);
});

test("returns null when no signal matches", () => {
  assert.equal(detectAdapter(new Set(["README.md"]), null), null);
});

test("workspace-sourced adapter command requires a trust prompt the first time", () => {
  const spec = {
    type: "custom",
    transport: { kind: "stdio", command: "/repo/x", args: [] },
    fromWorkspace: true,
  } as const;
  assert.equal(requiresTrustPrompt(spec, new Set(), "/repo"), true);
  assert.equal(requiresTrustPrompt(spec, new Set(["/repo"]), "/repo"), false);
});

test("auto-detected (non-workspace) adapter never prompts", () => {
  const spec = {
    type: "lldb",
    transport: { kind: "stdio", command: "codelldb", args: [] },
    fromWorkspace: false,
  } as const;
  assert.equal(requiresTrustPrompt(spec, new Set(), "/repo"), false);
});

test("breakpointStore persists across sessions (module-level)", () => {
  breakpointStore.set("/a.rs", [{ line: 10 }]);
  assert.deepEqual(breakpointStore.get("/a.rs"), [{ line: 10 }]);
  breakpointStore.delete("/a.rs");
});

test("Rust launch config uses built Cargo binary", async () => {
  const resolved = await resolveLaunchConfig(
    { type: "lldb", transport: { kind: "socket", host: "127.0.0.1", port: 0 }, fromWorkspace: false },
    "/repo",
    "/repo/src/main.rs",
    {
      readText: async () => '[package]\nname = "my-crate"\n',
      exists: async (path) => path === "/repo/target/debug/my-crate",
    },
  );
  assert.deepEqual(resolved, {
    ok: true,
    config: { type: "lldb", request: "launch", program: "/repo/target/debug/my-crate" },
  });
});

test("Rust launch config asks for cargo build when binary is missing", async () => {
  const resolved = await resolveLaunchConfig(
    { type: "lldb", transport: { kind: "socket", host: "127.0.0.1", port: 0 }, fromWorkspace: false },
    "/repo",
    "/repo/src/main.rs",
    {
      readText: async () => '[package]\nname = "my-crate"\n',
      exists: async () => false,
    },
  );
  assert.deepEqual(resolved, { ok: false, error: "Run cargo build first" });
});

test("Go launch config uses package directory and debug mode", async () => {
  const resolved = await resolveLaunchConfig(
    { type: "go", transport: { kind: "stdio", command: "dlv", args: ["dap"] }, fromWorkspace: false },
    "/repo",
    "/repo/cmd/app/main.go",
    { readText: async () => "", exists: async () => true },
  );
  assert.deepEqual(resolved, {
    ok: true,
    config: { type: "go", request: "launch", program: "/repo/cmd/app", mode: "debug" },
  });
});

// ---- Phase 1: condition/hitCondition/logMessage fields + persistence ----

test("field serialization: setBreakpoints request carries condition/hitCondition/logMessage when the adapter supports all three", () => {
  const caps = {
    supportsConditionalBreakpoints: true,
    supportsHitConditionalBreakpoints: true,
    supportsLogPoints: true,
  };
  const bps = [{ line: 5, condition: "x == 3", hitCondition: ">= 2", logMessage: "hit {x}" }];
  const { args, dropped } = buildSetBreakpointsArgs("/a.rs", bps, caps);
  assert.deepEqual(args, {
    source: { path: "/a.rs" },
    breakpoints: [{ line: 5, condition: "x == 3", hitCondition: ">= 2", logMessage: "hit {x}" }],
  });
  assert.deepEqual(dropped, []);
});

test("field serialization: a plain breakpoint sends only line, no optional keys", () => {
  const caps = { supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true };
  const { args } = buildSetBreakpointsArgs("/a.rs", [{ line: 9 }], caps);
  assert.deepEqual(args.breakpoints, [{ line: 9 }]);
});

test("capability gating (send path): adapter without supportsLogPoints drops logMessage and reports it", () => {
  const caps = { supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true };
  const { args, dropped } = buildSetBreakpointsArgs("/a.rs", [{ line: 5, condition: "x==3", logMessage: "hit" }], caps);
  assert.equal(args.breakpoints[0].condition, "x==3");
  assert.equal("logMessage" in args.breakpoints[0], false);
  assert.deepEqual(dropped, [{ path: "/a.rs", line: 5, field: "logMessage" }]);
});

test("capability gating (popover): fields default enabled with unknown capabilities, disabled per-flag once known", () => {
  assert.deepEqual(popoverFieldsEnabled(undefined), { condition: true, hitCondition: true, logMessage: true });
  assert.deepEqual(
    popoverFieldsEnabled({ supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true }),
    { condition: true, hitCondition: true, logMessage: false },
  );
});

test("glyph selection: verified breakpoint glyph follows field presence — plain/conditional/logpoint", () => {
  assert.equal(bpGlyphChar({ verified: true }), "●");
  assert.equal(bpGlyphChar({ verified: true, condition: "x > 1" }), "◆");
  assert.equal(bpGlyphChar({ verified: true, hitCondition: ">= 3" }), "◆");
  assert.equal(bpGlyphChar({ verified: true, logMessage: "hit {x}" }), "◇");
});

test("glyph selection: unverified breakpoint always shows the hollow dot regardless of fields", () => {
  assert.equal(bpGlyphChar({ verified: false, condition: "x > 1" }), "◌");
  assert.equal(bpGlyphChar({ verified: false, logMessage: "hit" }), "◌");
  assert.equal(bpGlyphChar({}), "◌");
});

test("logpoint no-pause model: a logMessage alongside a condition still renders as a logpoint, not conditional", () => {
  assert.equal(bpGlyphChar({ verified: true, condition: "x > 1", logMessage: "hit {x}" }), "◇");
});

test("persistence round-trip: saved condition/hitCondition/logMessage survive a fresh load; verified is not persisted", () => {
  const root = "/repo/persist-a";
  breakpointStore.clear();
  breakpointStore.set("/repo/persist-a/src/lib.rs", [
    { line: 3, verified: true },
    { line: 7, verified: true, condition: "n == 3" },
    { line: 12, verified: true, logMessage: "n={n}" },
  ]);
  saveBreakpointStore(root);
  breakpointStore.clear();
  loadBreakpointStore(root);
  assert.deepEqual(breakpointStore.get("/repo/persist-a/src/lib.rs"), [
    { line: 3 },
    { line: 7, condition: "n == 3" },
    { line: 12, logMessage: "n={n}" },
  ]);
  breakpointStore.clear();
});

test("persistence is per-root: saving under one root never leaks into another root's load", () => {
  breakpointStore.clear();
  breakpointStore.set("/repo/root-a/x.rs", [{ line: 1 }]);
  saveBreakpointStore("/repo/root-a");
  breakpointStore.clear();
  loadBreakpointStore("/repo/root-b");
  assert.equal(breakpointStore.size, 0);
  breakpointStore.clear();
});

test("corrupt/absent stored value recovers to a fresh empty store without throwing", () => {
  breakpointStore.set("/stale.rs", [{ line: 1 }]);
  assert.doesNotThrow(() => loadBreakpointStore("/repo/never-saved"));
  assert.equal(breakpointStore.size, 0);

  breakpointStore.set("/stale.rs", [{ line: 1 }]);
  localStorage.setItem(breakpointStoreKey("/repo/corrupt"), "{not valid json");
  assert.doesNotThrow(() => loadBreakpointStore("/repo/corrupt"));
  assert.equal(breakpointStore.size, 0);
});
