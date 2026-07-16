import { test } from "bun:test";
import assert from "node:assert/strict";
import { retryStableDelivery } from "../../packages/intercom/stable-delivery-retry.js";

test("a rejected closed-stage route retries the same stable producer key", async () => {
  const scheduled: Array<() => void> = [];
  const keys: string[] = [];
  let attempts = 0;
  retryStableDelivery({
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
  assert.deepEqual(keys, ["intercom:late-message", "intercom:late-message"]);
});

test("a synchronous route throw schedules retry only while the generation is current", () => {
  const scheduled: Array<() => void> = [];
  let current = true;
  retryStableDelivery({
    deliver: (() => { throw new Error("synchronous route failure"); }) as () => Promise<void>,
    isCurrent: () => current,
    schedule: (retry) => { scheduled.push(retry); },
  });
  assert.equal(scheduled.length, 1);

  current = false;
  scheduled.shift()?.();
  assert.equal(scheduled.length, 0);
});
