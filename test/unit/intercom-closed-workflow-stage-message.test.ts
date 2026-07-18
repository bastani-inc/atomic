import { test } from "bun:test";
import assert from "node:assert/strict";
import { routeClosedWorkflowStageMessage } from "../../packages/intercom/closed-workflow-stage-message.js";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const sender: SessionInfo = {
  id: "stage-b-intercom", name: "B", cwd: "/repo", model: "test",
  pid: 2, startedAt: 1, lastActivity: 1,
};

function ask(): Message {
  return {
    id: "ask-b-to-a",
    timestamp: 1,
    expectsReply: true,
    content: { text: "exact ask" },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not settle");
    await Bun.sleep(2);
  }
}

test("failed completed-stage revival sends an actionable error on the exact ask thread and cleans target context", async () => {
  const admission = new InboundMessageAdmission();
  const tracker = new ReplyTracker();
  const message = ask();
  const sent: Array<{ to: string; options: { text: string; replyTo?: string; replyError?: string } }> = [];
  const client = {
    isConnected: () => true,
    async send(to: string, options: { text: string; replyTo?: string; replyError?: string }) {
      sent.push({ to, options });
      return { id: "failure-reply", delivered: true };
    },
  };

  routeClosedWorkflowStageMessage(
    { from: sender, message, bodyText: message.content.text },
    admission,
    tracker,
    null,
    async () => { throw new Error("target is not resumable"); },
    () => client as never,
    () => true,
  );
  await waitFor(() => sent.length === 1);

  assert.equal(sent[0]?.to, sender.id);
  assert.equal(sent[0]?.options.replyTo, message.id);
  assert.match(sent[0]?.options.replyError ?? "", /not resumable/);
  assert.deepEqual(tracker.listPending(), []);
  assert.equal(admission.admit(sender, message).kind, "duplicate", "terminal failure response commits dedupe ownership");
});

test("successful completed-stage handoff retains the exact pending ask for the revived turn", async () => {
  const admission = new InboundMessageAdmission();
  const tracker = new ReplyTracker();
  const message = ask();
  let delivered = false;
  routeClosedWorkflowStageMessage(
    { from: sender, message, bodyText: message.content.text },
    admission,
    tracker,
    null,
    async () => { delivered = true; },
    () => null,
    () => true,
  );
  await waitFor(() => delivered);

  tracker.beginTurn();
  const target = tracker.resolveReplyTarget({});
  assert.equal(target.from.id, sender.id);
  assert.equal(target.message.id, message.id);
  assert.equal(admission.admit(sender, message).kind, "duplicate");
});

test("ordinary late notifications keep the external route without claiming target reply context", async () => {
  const admission = new InboundMessageAdmission();
  const tracker = new ReplyTracker();
  const message = { ...ask(), expectsReply: false };
  let deliveries = 0;
  routeClosedWorkflowStageMessage(
    { from: sender, message, bodyText: message.content.text },
    admission,
    tracker,
    null,
    async () => { deliveries += 1; },
    () => null,
    () => true,
  );
  await waitFor(() => deliveries === 1);
  assert.deepEqual(tracker.listPending(), []);
  assert.equal(admission.admit(sender, message).kind, "reserved", "destination late router retains admission ownership");
});
