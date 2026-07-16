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
