import { test } from "bun:test";
import assert from "node:assert/strict";
import { retryStableDelivery } from "../../packages/intercom/stable-delivery-retry.js";

test("a rejected closed-stage route retries the same stable producer key", async () => {
  const scheduled: Array<() => void> = [];
  const keys: string[] = [];
  let attempts = 0;
  const completion = retryStableDelivery({
    deliver: async () => {
      keys.push("intercom:late-message");
      attempts += 1;
      if (attempts === 1) throw new Error("temporary main-chat failure");
    },
    isCurrent: () => true,
    schedule: (retry) => { scheduled.push(retry); },
  });

  await Promise.resolve();
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  await Promise.resolve();
  await completion;
  assert.deepEqual(keys, ["intercom:late-message", "intercom:late-message"]);
});

test("a synchronous route throw gets one final retry after generation retirement", async () => {
  const scheduled: Array<() => void> = [];
  let current = true;
  let attempts = 0;
  const completion = retryStableDelivery({
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synchronous route failure");
    },
    isCurrent: () => current,
    schedule: (retry) => { scheduled.push(retry); },
  });
  await Promise.resolve();
  assert.equal(scheduled.length, 1);

  current = false;
  scheduled.shift()?.();
  await completion;
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 0);
});
