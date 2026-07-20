import { test } from "bun:test";
import assert from "node:assert/strict";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { registerLateStageMessageRouter } from "../../packages/intercom/late-stage-message-router.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";

function intercomMessage(id: string, group?: string, channel?: "supervisor") {
  const from = { id: "sender", name: "reviewer", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1, group };
  const message = { id, timestamp: 1, content: { text: id } };
  return { customType: "intercom_message", content: id, display: true, details: { from, message, bodyText: id, channel } } as const;
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

test("completed-stage asks are left for the workflow post-mortem router regardless of listener order", () => {
  let handler: ((payload: unknown) => void | Promise<void>) | undefined;
  let parentDeliveries = 0;
  const pi = {
    events: { on(_name: string, next: typeof handler) { handler = next; return () => {}; } },
    async sendMessage() { parentDeliveries += 1; },
  };
  registerLateStageMessageRouter(pi as never, new InboundMessageAdmission(), () => new ReplyTracker());
  const message = intercomMessage("ask-1");
  (message.details.message as { expectsReply?: boolean }).expectsReply = true;
  const payload = {
    handled: false,
    batch: false,
    workflowRunId: "run-1",
    workflowStageId: "stage-a",
    messages: [message],
    options: { triggerTurn: true },
  };

  void handler?.(payload);
  assert.equal(payload.handled, false);
  assert.equal(parentDeliveries, 0);
});


test("late relay suppresses isolated peer chatter to a differently grouped parent", async () => {
  let handler: ((payload: unknown) => void | Promise<void>) | undefined;
  const delivered: string[] = [];
  const pi = {
    events: { on(_name: string, next: typeof handler) { handler = next; return () => {}; } },
    async sendMessage(message: ReturnType<typeof intercomMessage>) { delivered.push(message.content); },
  };
  registerLateStageMessageRouter(
    pi as never,
    new InboundMessageAdmission(),
    () => new ReplyTracker(),
    () => "default",
  );
  const payload = {
    handled: false,
    batch: false,
    messages: [intercomMessage("peer-chatter", "reviewers")],
    options: { triggerTurn: true },
  } as { handled: boolean; batch: boolean; messages: ReturnType<typeof intercomMessage>[]; options: object; completion?: Promise<void> };

  void handler?.(payload);
  await payload.completion;

  assert.equal(payload.handled, true);
  assert.deepEqual(delivered, []);
});


test("late relay still forwards supervisor-channel messages across groups", async () => {
  let handler: ((payload: unknown) => void | Promise<void>) | undefined;
  const delivered: string[] = [];
  const pi = {
    events: { on(_name: string, next: typeof handler) { handler = next; return () => {}; } },
    async sendMessage(message: ReturnType<typeof intercomMessage>) { delivered.push(message.content); },
  };
  registerLateStageMessageRouter(
    pi as never,
    new InboundMessageAdmission(),
    () => new ReplyTracker(),
    () => "default",
  );
  const payload = {
    handled: false,
    batch: false,
    messages: [intercomMessage("supervisor-update", "reviewers", "supervisor")],
    options: { triggerTurn: true },
  } as { handled: boolean; batch: boolean; messages: ReturnType<typeof intercomMessage>[]; options: object; completion?: Promise<void> };

  void handler?.(payload);
  await payload.completion;

  assert.deepEqual(delivered, ["supervisor-update"]);
});

test("late relay preserves same-group and implicit-default messages", async () => {
  let handler: ((payload: unknown) => void | Promise<void>) | undefined;
  const delivered: string[] = [];
  const pi = {
    events: { on(_name: string, next: typeof handler) { handler = next; return () => {}; } },
    async sendMessage(message: ReturnType<typeof intercomMessage>) { delivered.push(message.content); },
  };
  let ownerGroup = "reviewers";
  registerLateStageMessageRouter(
    pi as never,
    new InboundMessageAdmission(),
    () => new ReplyTracker(),
    () => ownerGroup,
  );
  const sameGroup = {
    handled: false,
    batch: false,
    messages: [intercomMessage("same-group", "reviewers")],
  } as { handled: boolean; batch: boolean; messages: ReturnType<typeof intercomMessage>[]; completion?: Promise<void> };
  void handler?.(sameGroup);
  await sameGroup.completion;

  ownerGroup = "default";
  const defaultGroup = {
    handled: false,
    batch: false,
    messages: [intercomMessage("default-group")],
  } as { handled: boolean; batch: boolean; messages: ReturnType<typeof intercomMessage>[]; completion?: Promise<void> };
  void handler?.(defaultGroup);
  await defaultGroup.completion;

  assert.deepEqual(delivered, ["same-group", "default-group"]);
});

test("late relay preserves legitimate result handoffs across groups", async () => {
  let handler: ((payload: unknown) => void | Promise<void>) | undefined;
  const delivered: string[] = [];
  const pi = {
    events: { on(_name: string, next: typeof handler) { handler = next; return () => {}; } },
    async sendMessage(message: ReturnType<typeof intercomMessage>) { delivered.push(message.content); },
  };
  registerLateStageMessageRouter(
    pi as never,
    new InboundMessageAdmission(),
    () => new ReplyTracker(),
    () => "default",
  );
  const base = intercomMessage("stage-result", "reviewers");
  const handoff = {
    ...base,
    details: { ...base.details, from: { ...base.details.from, id: "subagent-result", name: "subagent-result" } },
  };
  const payload = {
    handled: false,
    batch: false,
    messages: [handoff],
  } as { handled: boolean; batch: boolean; messages: ReturnType<typeof intercomMessage>[]; completion?: Promise<void> };

  void handler?.(payload);
  await payload.completion;

  assert.deepEqual(delivered, ["stage-result"]);
});
