import { test } from "bun:test";
import assert from "node:assert/strict";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const sender: SessionInfo = {
  id: "sender-1",
  name: "reviewer",
  cwd: "/repo",
  model: "test",
  pid: 1,
  startedAt: 1,
  lastActivity: 1,
};
const message: Message = {
  id: "message-1",
  timestamp: 1,
  content: { text: "review this" },
};

test("duplicate broker delivery cannot enqueue a second reply turn context", () => {
  const admission = new InboundMessageAdmission();
  const tracker = new ReplyTracker();
  for (const delivery of [message, { ...message }]) {
    if (!admission.accept(sender, delivery)) continue;
    const context = tracker.recordIncomingMessage(sender, delivery);
    tracker.queueTurnContext(context);
  }

  tracker.beginTurn();
  assert.equal(tracker.resolveReplyTarget({}).message.id, "message-1");
  tracker.endTurn();
  tracker.beginTurn();
  assert.throws(() => tracker.resolveReplyTarget({}), /No active intercom context/);
});

test("released reservation permits a stable broker delivery retry", () => {
  const admission = new InboundMessageAdmission();
  const first = admission.reserve(sender, message);
  assert.ok(first);
  assert.equal(admission.reserve(sender, { ...message }), undefined);

  admission.release(first);
  const retry = admission.reserve(sender, { ...message });
  assert.ok(retry);
  admission.commit(retry);
  assert.equal(admission.reserve(sender, { ...message }), undefined);
});

test("a concurrent duplicate joins the destination reservation failure", async () => {
  const admission = new InboundMessageAdmission();
  const owner = admission.admit(sender, message);
  const duplicate = admission.admit(sender, { ...message });
  assert.equal(owner.kind, "reserved");
  assert.equal(duplicate.kind, "pending");
  if (owner.kind !== "reserved" || duplicate.kind !== "pending") assert.fail("expected owner and pending duplicate");

  admission.release(owner.reservation, new Error("temporary destination failure"));
  await assert.rejects(duplicate.completion, /temporary destination failure/);
});

test("failed destination routing rolls back ask and turn reply context", () => {
  const tracker = new ReplyTracker();
  const ask = { ...message, expectsReply: true };
  const context = tracker.recordIncomingMessage(sender, ask);
  tracker.queueTurnContext(context);

  tracker.forgetIncomingMessage(context);
  assert.deepEqual(tracker.listPending(), []);
  tracker.beginTurn();
  assert.throws(() => tracker.resolveReplyTarget({}), /No active intercom context/);
});
