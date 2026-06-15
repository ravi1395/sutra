// Tests for the DAP client: request/response correlation, reverse-request
// handling, state transitions, and the initialized-gated launch sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DapClient, type DapTransport } from "../src/debug";

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
