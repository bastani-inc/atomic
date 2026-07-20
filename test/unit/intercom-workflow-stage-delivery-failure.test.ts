import { test } from "bun:test";
import assert from "node:assert/strict";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import { createWorkflowStageDeliveryFailureHandler, sendWorkflowStageDeliveryFailure } from "../../packages/intercom/workflow-stage-delivery-failure.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const asker: SessionInfo = {
  id: "asking-stage",
  name: "asking-stage",
  cwd: "/repo",
  model: "test",
  pid: 1,
  startedAt: 1,
  lastActivity: 1,
};
const target: SessionInfo = {
  ...asker,
  id: "target-stage",
  name: "target-stage",
};
const ask: Message = {
  id: "mid-turn-ask",
  timestamp: 1,
  expectsReply: true,
  content: { text: "Can you review this?" },
};

test("a destination-side running-stage admission failure rejects the exact ask without its long timeout", async () => {
  const waiter = new ReplyWaiterSlot();
  const admission = waiter.begin(target.id, ask.id);
  assert.equal(admission.ok, true);
  if (!admission.ok) throw new Error("reply waiter admission failed");
  const pending = admission.wait.promise;
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(asker, ask);
  const started = performance.now();
  const sent = await sendWorkflowStageDeliveryFailure(
    { from: asker, message: ask, bodyText: ask.content.text },
    new Error("Intercom session retired before inbound delivery"),
    tracker,
    () => ({
      isConnected: () => true,
      async send(to: string, options: { text: string; replyTo?: string; replyError?: string }) {
        assert.equal(to, asker.id);
        const routed = routeIncomingReply(waiter.current(), target, {
          id: "delivery-failure",
          timestamp: Date.now(),
          replyTo: options.replyTo,
          replyError: options.replyError,
          content: { text: options.text },
        });
        assert.equal(routed, true);
        return { id: "delivery-failure", delivered: true };
      },
    }) as never,
    () => true,
    "Running workflow stage could not admit intercom ask",
  );

  assert.equal(sent, true);
  const reply = await pending;
  assert.equal(
    reply.replyError,
    "Running workflow stage could not admit intercom ask: Intercom session retired before inbound delivery",
  );
  assert.ok(performance.now() - started < 1_000);
  assert.equal(waiter.has(), false);
  assert.equal(tracker.listPending().length, 0);
});

test("open-stage failure settlement is awaited and sends one correlated error across duplicate callbacks", async () => {
  const inbound = new InboundMessageAdmission();
  const reserved = inbound.admit(asker, ask);
  assert.equal(reserved.kind, "reserved");
  if (reserved.kind !== "reserved") throw new Error("inbound admission failed");
  const tracker = new ReplyTracker();
  const replyContext = tracker.recordIncomingMessage(asker, ask);
  let sends = 0;
  const finish = createWorkflowStageDeliveryFailureHandler({
    entry: { from: asker, message: ask, bodyText: ask.content.text },
    admission: inbound,
    reservation: reserved.reservation,
    tracker,
    replyContext,
    currentClient: () => ({
      isConnected: () => true,
      async send() {
        sends += 1;
        await Bun.sleep(10);
        return { id: "failure", delivered: true };
      },
    }) as never,
    commit: () => inbound.commit(reserved.reservation),
  });

  await Promise.all([finish(new Error("retired")), finish(new Error("duplicate callback"))]);
  assert.equal(sends, 1);
  assert.equal(inbound.admit(asker, ask).kind, "duplicate");
  assert.deepEqual(tracker.listPending(), []);
});
