/**
 * Contract for the workflow-internal stage delivery-activity channel.
 *
 * Only an *accepted idle* delivery reports `delivery_start`, because only that
 * delivery starts a new turn whose Working period the attached chat must own
 * before the public `agent_start` is published. Streaming steer/follow-up, a
 * rejected admission, and a slash-command style "handled" send must not open a
 * lifecycle the UI would have to guess its way out of.
 *
 * cross-ref: packages/workflows/src/runs/foreground/stage-delivery-activity.ts
 */
import { describe, test } from "bun:test";
import { StageDeliveryActivity, type StageDeliveryActivityEvent } from "../../packages/workflows/src/runs/foreground/stage-delivery-activity.js";
import type { AgentSessionAdapter, InternalStageContext, StageSessionRuntime } from "./stage-runner-helpers.js";
import { assert, createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

function recordActivity(ctx: InternalStageContext): {
  readonly events: StageDeliveryActivityEvent[];
  readonly types: () => string[];
} {
  const events: StageDeliveryActivityEvent[] = [];
  ctx.__subscribeDeliveryActivity((event) => events.push(event));
  return { events, types: () => events.map((event) => event.type) };
}

function contextFor(session: StageSessionRuntime): InternalStageContext {
  const agentSession: AgentSessionAdapter = { async create() { return session; } };
  return createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;
}

describe("StageDeliveryActivity", () => {
  test("settles outstanding deliveries exactly once on dispose", () => {
    const activity = new StageDeliveryActivity();
    const events: StageDeliveryActivityEvent[] = [];
    activity.subscribe((event) => events.push(event));

    const first = activity.start();
    const second = activity.start();
    activity.settle(first);
    activity.settle(first);
    activity.dispose();

    assert.deepEqual(events, [
      { type: "delivery_start", deliveryId: first },
      { type: "delivery_start", deliveryId: second },
      { type: "delivery_settled", deliveryId: first },
      { type: "delivery_settled", deliveryId: second },
    ]);
    assert.notEqual(first, second);
  });

  test("unsubscribed listeners stop receiving events", () => {
    const activity = new StageDeliveryActivity();
    const events: StageDeliveryActivityEvent[] = [];
    const unsubscribe = activity.subscribe((event) => events.push(event));
    unsubscribe();
    activity.settle(activity.start());
    assert.deepEqual(events, []);
  });

  test("replays active deliveries to a late subscriber in insertion order", () => {
    const activity = new StageDeliveryActivity();
    const first = activity.start();
    const second = activity.start();
    const alreadySettled = activity.start();
    activity.settle(alreadySettled);

    const events: StageDeliveryActivityEvent[] = [];
    activity.subscribe((event) => events.push(event));

    assert.deepEqual(events, [
      { type: "delivery_start", deliveryId: first },
      { type: "delivery_start", deliveryId: second },
    ]);
  });

  test("a replayed delivery still settles live for the late subscriber", () => {
    const activity = new StageDeliveryActivity();
    const deliveryId = activity.start();
    const events: StageDeliveryActivityEvent[] = [];
    activity.subscribe((event) => events.push(event));

    activity.settle(deliveryId);

    assert.deepEqual(events, [
      { type: "delivery_start", deliveryId },
      { type: "delivery_settled", deliveryId },
    ]);
  });

  test("a delivery started during replay is seen live exactly once", () => {
    const activity = new StageDeliveryActivity();
    const existing = activity.start();
    const events: StageDeliveryActivityEvent[] = [];
    let nested: number | undefined;
    activity.subscribe((event) => {
      events.push(event);
      // Registering the listener before replay means a reentrant start is seen
      // live exactly once rather than being dropped or replayed twice.
      if (nested === undefined && event.deliveryId === existing) nested = activity.start();
    });

    assert.deepEqual(events.map((event) => event.deliveryId), [existing, nested]);
    assert.equal(events.every((event) => event.type === "delivery_start"), true);
  });

  test("an unsubscribed late listener stops receiving replayed deliveries", () => {
    const activity = new StageDeliveryActivity();
    activity.start();
    const events: StageDeliveryActivityEvent[] = [];
    const unsubscribe = activity.subscribe((event) => events.push(event));
    assert.equal(events.length, 1);
    unsubscribe();

    activity.start();
    assert.equal(events.length, 1);
  });
});

describe("stage runner delivery activity", () => {
  test("an accepted idle delivery starts before the turn resolves and settles after", async () => {
    const turn = Promise.withResolvers<void>();
    const { session } = makeMockSession({
      async sendUserMessage() {
        await turn.promise;
      },
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    const delivery = ctx.__sendUserMessage("workflow-authored follow-up");
    await Promise.resolve();
    assert.deepEqual(activity.types(), ["delivery_start"]);

    turn.resolve();
    assert.equal(await delivery, "prompt");
    assert.deepEqual(activity.types(), ["delivery_start", "delivery_settled"]);
    assert.equal(activity.events[0]!.deliveryId, activity.events[1]!.deliveryId);
  });

  test("streaming steer and follow-up deliveries report no activity", async () => {
    const { session } = makeMockSession({
      isStreaming: true,
      async sendUserMessage() {},
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    assert.equal(await ctx.__sendUserMessage("queued while streaming"), "followUp");
    assert.equal(await ctx.__sendUserMessage("steer while streaming", { deliverAs: "steer" }), "steer");

    assert.deepEqual(activity.types(), []);
  });

  test("a delivery rejected at admission reports no activity", async () => {
    const handled: string[] = [];
    const { session } = makeMockSession({
      async sendUserMessage(text) {
        handled.push(String(text));
      },
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    await assert.rejects(
      ctx.__sendUserMessage("rejected", undefined, () => {
        throw new DOMException("workflow exited", "AbortError");
      }),
      /workflow exited/,
    );

    assert.deepEqual(activity.types(), []);
    assert.deepEqual(handled, []);
  });

  test("a handled delivery that starts no turn still settles", async () => {
    const { session } = makeMockSession({
      async sendUserMessage(_text, options) {
        options?.__workflowDelivery?.delivered?.("handled");
      },
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    assert.equal(await ctx.__sendUserMessage("/slash-style"), "handled");
    assert.deepEqual(activity.types(), ["delivery_start", "delivery_settled"]);
  });

  test("a failed delivery settles instead of leaving a stuck lifecycle", async () => {
    const { session } = makeMockSession({
      async sendUserMessage() {
        throw new Error("prompt preflight failed");
      },
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    await assert.rejects(ctx.__sendUserMessage("doomed"), /prompt preflight failed/);
    assert.deepEqual(activity.types(), ["delivery_start", "delivery_settled"]);
  });

  test("runtimes without native sendUserMessage still report their idle prompt", async () => {
    const prompts: string[] = [];
    const { session } = makeMockSession({
      async prompt(text) {
        prompts.push(text);
      },
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    assert.equal(await ctx.__sendUserMessage("fallback idle prompt"), "prompt");
    assert.deepEqual(activity.types(), ["delivery_start", "delivery_settled"]);
    assert.deepEqual(prompts, ["fallback idle prompt"]);
  });

  test("disposing the stage settles an in-flight delivery", async () => {
    const turn = Promise.withResolvers<void>();
    const { session } = makeMockSession({
      async sendUserMessage() {
        await turn.promise;
      },
    });
    const ctx = contextFor(session);
    await ctx.__ensureSession();
    const activity = recordActivity(ctx);

    const delivery = ctx.__sendUserMessage("in flight at disposal");
    await Promise.resolve();
    assert.deepEqual(activity.types(), ["delivery_start"]);

    await ctx.__dispose();
    assert.deepEqual(activity.types(), ["delivery_start", "delivery_settled"]);

    turn.resolve();
    await delivery;
  });
});
