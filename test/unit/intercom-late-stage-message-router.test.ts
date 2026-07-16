import { test } from "bun:test";
import assert from "node:assert/strict";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { registerLateStageMessageRouter } from "../../packages/intercom/late-stage-message-router.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";

function intercomMessage(id: string) {
  const from = { id: "sender", name: "reviewer", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
  const message = { id, timestamp: 1, content: { text: id } };
  return { customType: "intercom_message", content: id, display: true, details: { from, message, bodyText: id } } as const;
}

test("fallback batch commits successful members and retries only the failed suffix", async () => {
  let handler: ((payload: unknown) => void | Promise<void>) | undefined;
  let rejectSecond = true;
  const delivered: string[] = [];
  const pi = {
    events: { on(_name: string, next: typeof handler) { handler = next; return () => {}; } },
    async sendMessage(message: ReturnType<typeof intercomMessage>) {
      if (message.content === "second" && rejectSecond) { rejectSecond = false; throw new Error("second failed"); }
      delivered.push(message.content);
    },
  };
  registerLateStageMessageRouter(pi as never, new InboundMessageAdmission(), () => new ReplyTracker());
  const messages = [intercomMessage("first"), intercomMessage("second")];
  const route = () => {
    const payload = { handled: false, batch: true, messages, options: { triggerTurn: true } } as { handled: boolean; batch: boolean; messages: typeof messages; options: object; completion?: Promise<void> };
    void handler?.(payload);
    assert.ok(payload.completion);
    return payload.completion;
  };

  await assert.rejects(route(), /second failed/);
  await route();
  assert.deepEqual(delivered, ["first", "second"]);
});
