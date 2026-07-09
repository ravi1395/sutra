import { strict as assert } from "node:assert";
import test from "node:test";
import { TaskStartGate, mayPersistTaskForRoot, runGuardedTaskOperation } from "../src/tasks-panel";

test("TaskStartGate rejects rapid reentrant Start claims until the first releases", () => {
  const gate = new TaskStartGate();
  assert.equal(gate.claim("task-1"), true);
  assert.equal(gate.claim("task-1"), false);
  gate.release("task-1");
  assert.equal(gate.claim("task-1"), true);
});

test("task persistence requires current root and current backend trust", () => {
  assert.equal(mayPersistTaskForRoot("/root-a", "/root-a", true), true);
  assert.equal(mayPersistTaskForRoot("/root-a", "/root-b", true), false);
  assert.equal(mayPersistTaskForRoot("/root-a", "/root-a", false), false);
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

test("create-style operation writes nothing when its root changes during trust lookup", async () => {
  let root: string | null = "/a";
  const trust = deferred<boolean>();
  let writes = 0;
  const operation = runGuardedTaskOperation({ root: "/a", getRoot: () => root, isTrusted: () => trust.promise, write: async () => { writes++; } });
  root = "/b";
  trust.resolve(true);
  assert.equal(await operation, "rejected");
  assert.equal(writes, 0);
});

test("trust revocation during persisted Start prevents delivery and follow-up writes", async () => {
  let trusted = true;
  const write = deferred<void>();
  let writes = 0;
  let deliveries = 0;
  const operation = runGuardedTaskOperation({
    root: "/a", getRoot: () => "/a", isTrusted: async () => trusted,
    write: async () => { writes++; await write.promise; }, deliver: async () => { deliveries++; },
  });
  await Promise.resolve();
  trusted = false;
  write.resolve();
  assert.equal(await operation, "rejected");
  assert.equal(writes, 1);
  assert.equal(deliveries, 0);
});

test("root switch during persisted Start prevents delivery without cross-root write", async () => {
  let root: string | null = "/a";
  const write = deferred<void>();
  const writes: string[] = [];
  let deliveries = 0;
  const operation = runGuardedTaskOperation({
    root: "/a", getRoot: () => root, isTrusted: async () => true,
    write: async () => { writes.push("/a"); await write.promise; }, deliver: async () => { deliveries++; },
  });
  await Promise.resolve();
  root = "/b";
  write.resolve();
  assert.equal(await operation, "rejected");
  assert.deepEqual(writes, ["/a"]);
  assert.equal(deliveries, 0);
});
