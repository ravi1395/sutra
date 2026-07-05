// Tests for the updater's pure progress math (progressPercent) and the
// cold-boot check-with-retry policy (checkWithRetry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressPercent, checkWithRetry } from "../src/updater";

// A no-op sleep so retry tests run instantly (delays are exercised for count, not timing).
const noSleep = (): Promise<void> => Promise.resolve();
// Minimal Update stand-in — checkWithRetry only forwards it to onAvailable.
const fakeUpdate = (version: string) => ({ version }) as never;

test("progressPercent returns null when total is unknown", () => {
  assert.equal(progressPercent(0, 0), null);
  assert.equal(progressPercent(500, -1), null);
});

test("progressPercent rounds the download fraction to an integer", () => {
  assert.equal(progressPercent(0, 200), 0);
  assert.equal(progressPercent(50, 200), 25);
  assert.equal(progressPercent(199, 200), 100); // 99.5 → rounds to 100
});

test("progressPercent clamps to the 0–100 range", () => {
  assert.equal(progressPercent(300, 200), 100); // over-count never exceeds 100
  assert.equal(progressPercent(-10, 200), 0);
});

test("checkWithRetry surfaces the update on first success (no folder required)", async () => {
  let calls = 0;
  const seen: string[] = [];
  await checkWithRetry(
    () => {
      calls++;
      return Promise.resolve(fakeUpdate("9.9.9"));
    },
    (u) => seen.push((u as { version: string }).version),
    [0, 0, 0],
    noSleep,
  );
  assert.equal(calls, 1); // definitive result → no further attempts
  assert.deepEqual(seen, ["9.9.9"]);
});

test("checkWithRetry retries a transient cold-boot failure, then surfaces the update", async () => {
  let calls = 0;
  const seen: string[] = [];
  await checkWithRetry(
    () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error("network not ready"));
      return Promise.resolve(fakeUpdate("2.0.2"));
    },
    (u) => seen.push((u as { version: string }).version),
    [0, 0, 0, 0],
    noSleep,
  );
  assert.equal(calls, 3); // failed twice, succeeded on the third
  assert.deepEqual(seen, ["2.0.2"]);
});

test("checkWithRetry stops immediately when already up to date", async () => {
  let calls = 0;
  let announced = false;
  await checkWithRetry(
    () => {
      calls++;
      return Promise.resolve(null);
    },
    () => {
      announced = true;
    },
    [0, 0, 0],
    noSleep,
  );
  assert.equal(calls, 1); // null is a definitive answer — do not retry
  assert.equal(announced, false);
});

test("checkWithRetry gives up after exhausting all attempts", async () => {
  let calls = 0;
  let announced = false;
  await checkWithRetry(
    () => {
      calls++;
      return Promise.reject(new Error("still failing"));
    },
    () => {
      announced = true;
    },
    [0, 0, 0],
    noSleep,
  );
  assert.equal(calls, 3); // one attempt per delay, then give up
  assert.equal(announced, false);
});
