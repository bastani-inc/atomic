import { describe, test } from "bun:test";
import { StageSessionPause } from "../../packages/workflows/src/runs/foreground/stage-runner-pause.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { assert, makeMockSession } from "./stage-runner-helpers.js";

type Settlement =
  | { readonly status: "resolved" }
  | { readonly status: "rejected"; readonly error: Error }
  | { readonly status: "pending" };

function normalizeError(error: Error | DOMException | string): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

async function observeSettlement(promise: Promise<object>): Promise<Settlement> {
  return Promise.race([
    promise.then<Settlement, Settlement>(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error: normalizeError(error as Error | DOMException | string) }),
    ),
    new Promise<Settlement>((resolve) => setTimeout(() => resolve({ status: "pending" }), 10)),
  ]);
}

describe("StageSessionPause error settlement", () => {
  test("pauseQueuedMessages rejection resets every boundary and preserves the pause error over rollback failure", async () => {
    const pauseError = new Error("pause queue gate rejected");
    let rollbackCalls = 0;
    const { session } = makeMockSession({
      pauseQueuedMessages() { throw pauseError; },
      async resumeQueuedMessages() {
        rollbackCalls += 1;
        throw new Error("rollback release also rejected");
      },
    });
    const control = new StageSessionPause(() => session);
    const pause = control.requestPause();
    const waiting = control.currentResume();
    assert.ok(waiting);

    await assert.rejects(pause, (error) => error === pauseError);
    const settlement = await observeSettlement(waiting);

    assert.equal(rollbackCalls, 1);
    assert.deepEqual(settlement, { status: "rejected", error: pauseError });
    assert.equal(control.currentResume(), undefined);
    assert.equal(control.isPaused(), false);
  });

  test("abort rejection resets every boundary and preserves the abort error over rollback failure", async () => {
    const abortError = new Error("ordinary abort rejected");
    let rollbackCalls = 0;
    let nativePaused = false;
    const { session } = makeMockSession({
      pauseQueuedMessages() { nativePaused = true; },
      async abort() { throw abortError; },
      async resumeQueuedMessages() {
        rollbackCalls += 1;
        throw new Error("rollback after abort also rejected");
      },
    });
    Object.defineProperty(session, "queuedMessagesPaused", { get: () => nativePaused });
    const control = new StageSessionPause(() => session);
    const pause = control.requestPause();
    const waiting = control.currentResume();
    assert.ok(waiting);

    await assert.rejects(pause, (error) => error === abortError);
    const settlement = await observeSettlement(waiting);

    assert.equal(rollbackCalls, 2);
    assert.deepEqual(settlement, { status: "rejected", error: abortError });
    assert.equal(control.currentResume(), undefined);
    assert.equal(control.isPaused(), false);
  });

  test("abort rejection rollback retries after observing the native abort boundary", async () => {
    const abortError = new Error("native abort boundary rejected");
    let nativePaused = false;
    let rollbackAttempts = 0;
    const { session } = makeMockSession({
      pauseQueuedMessages() { nativePaused = true; },
      async abort() { throw abortError; },
      async resumeQueuedMessages() {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) throw abortError;
        nativePaused = false;
        return false;
      },
    });
    Object.defineProperty(session, "queuedMessagesPaused", { get: () => nativePaused });
    const control = new StageSessionPause(() => session);

    await assert.rejects(control.requestPause(), (error) => error === abortError);

    assert.equal(rollbackAttempts, 2);
    assert.equal(nativePaused, false);
    assert.equal(control.isPaused(), false);
  });

  test("explicit queue release failure stays paused and retries the same held generation exactly once", async () => {
    const resumeError = new Error("explicit queue release rejected");
    const unhandledRejections: object[] = [];
    const onUnhandledRejection: NodeJS.UnhandledRejectionListener = (reason) => {
      unhandledRejections.push(reason instanceof Object ? reason : new Error(String(reason)));
    };
    let nativePaused = false;
    let resumeAttempts = 0;
    let heldDeliveryCalls = 0;
    const { session } = makeMockSession({
      pauseQueuedMessages() { nativePaused = true; },
      async abort() {},
      async resumeQueuedMessages() {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw resumeError;
        nativePaused = false;
        return true;
      },
    });
    const control = new StageSessionPause(() => session);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await control.requestPause();
      const waiting = control.currentResume();
      assert.ok(waiting);
      const heldDelivery = control.deferRunnerOwnedDelivery(async () => {
        heldDeliveryCalls += 1;
        return "delivered";
      });
      assert.ok(heldDelivery);

      await assert.rejects(control.resume("retryable message"), (error) => error === resumeError);
      assert.deepEqual(await observeSettlement(waiting), { status: "pending" });
      assert.equal(control.currentResume(), waiting);
      assert.equal(control.isPaused(), true);
      assert.equal(nativePaused, true);
      assert.equal(resumeAttempts, 1);
      assert.equal(heldDeliveryCalls, 0);

      const resumed = await control.resume("retryable message");
      const resolution = await waiting;
      assert.deepEqual(resumed, { releasedQueuedMessages: true, runnerOwnedDeliveryPending: true });
      assert.equal(resolution.message, "retryable message");
      assert.equal(await heldDelivery, "delivered");
      await resolution.runnerOwnedDeliverySettlement;
      await Bun.sleep(10);

      assert.equal(control.isPaused(), false);
      assert.equal(nativePaused, false);
      assert.equal(resumeAttempts, 2);
      assert.equal(heldDeliveryCalls, 1);
      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("a clean request after a failed generation is independent and reports released work", async () => {
    let generation = 0;
    const { session } = makeMockSession({
      pauseQueuedMessages() { generation += 1; },
      async abort() { if (generation === 1) throw new Error("first generation failed"); },
      async resumeQueuedMessages() { return generation === 2; },
    });
    const control = new StageSessionPause(() => session as StageSessionRuntime);
    await assert.rejects(control.requestPause(), /first generation failed/);

    await control.requestPause();
    const waiting = control.currentResume();
    assert.ok(waiting);
    const resumed = await control.resume("second generation");

    assert.deepEqual(resumed, { releasedQueuedMessages: true, runnerOwnedDeliveryPending: false });
    const resolution = await waiting;
    assert.deepEqual(
      { message: resolution.message, releasedQueuedMessages: resolution.releasedQueuedMessages, runnerOwnedDeliveryPending: resolution.runnerOwnedDeliveryPending },
      { message: "second generation", releasedQueuedMessages: true, runnerOwnedDeliveryPending: false },
    );
    await resolution.runnerOwnedDeliverySettlement;
    assert.equal(control.isPaused(), false);
  });
});
