import { test } from "bun:test";
import assert from "node:assert/strict";
import { registerCompletedStageIntercomAskRouter } from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";

interface LateAskEvent {
  handled: boolean;
  completion?: Promise<void>;
  batch: boolean;
  workflowRunId: string;
  workflowStageId: string;
  messages: Array<{
    customType: "intercom_message";
    content: string;
    details: {
      from: { id: string };
      message: { id: string; expectsReply: true; content: { text: string } };
    };
  }>;
}

function askEvent(overrides: Partial<LateAskEvent> = {}): LateAskEvent {
  return {
    handled: false,
    batch: false,
    workflowRunId: "run-1",
    workflowStageId: "stage-a",
    messages: [{
      customType: "intercom_message",
      content: "**From B**\n\nReturn the exact summary",
      details: {
        from: { id: "stage-b-session" },
        message: { id: "ask-1", expectsReply: true, content: { text: "Return the exact summary" } },
      },
    }],
    ...overrides,
  };
}

function eventHarness() {
  let listener: ((event: unknown) => void) | undefined;
  return {
    pi: {
      events: {
        on(_name: string, callback: (event: unknown) => void) {
          listener = callback;
          return () => { listener = undefined; };
        },
      },
    },
    emit(event: LateAskEvent) {
      listener?.(event);
      return event;
    },
  };
}

function completedHandle(prompt: (text: string) => Promise<void>): StageControlHandle {
  return {
    runId: "run-1",
    stageId: "stage-a",
    stageName: "A",
    status: "completed",
    sessionId: "stage-a-session",
    sessionFile: "/tmp/stage-a.jsonl",
    isStreaming: false,
    messages: [],
    ensureAttached: async () => {},
    prompt,
    steer: async () => {},
    followUp: async () => {},
    pause: async () => {},
    resume: async () => {},
    subscribe: () => () => {},
  };
}

test("completed-stage ask schedules one post-mortem turn with the exact inbound text", async () => {
  const harness = eventHarness();
  const prompts: string[] = [];
  registerCompletedStageIntercomAskRouter(harness.pi as never, () => ({
    ok: true,
    handle: completedHandle(async (text) => { prompts.push(text); }),
  }));

  const event = harness.emit(askEvent());
  assert.equal(event.handled, true);
  assert.ok(event.completion);
  await event.completion;
  assert.deepEqual(prompts, ["**From B**\n\nReturn the exact summary"]);
});

test("concurrent duplicate wakeups serialize onto the retained completed conversation", async () => {
  const harness = eventHarness();
  const first = Promise.withResolvers<void>();
  const order: string[] = [];
  registerCompletedStageIntercomAskRouter(harness.pi as never, () => ({
    ok: true,
    handle: completedHandle(async (text) => {
      order.push(`start:${text}`);
      if (text === "first") await first.promise;
      order.push(`end:${text}`);
    }),
  }));

  const firstEvent = harness.emit(askEvent({ messages: [{ ...askEvent().messages[0]!, content: "first" }] }));
  const secondEvent = harness.emit(askEvent({ messages: [{ ...askEvent().messages[0]!, content: "second", details: { ...askEvent().messages[0]!.details, message: { ...askEvent().messages[0]!.details.message, id: "ask-2" } } }] }));
  await Bun.sleep(0);
  assert.deepEqual(order, ["start:first"]);
  first.resolve();
  await Promise.all([firstEvent.completion, secondEvent.completion]);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
});

test("unknown, non-resumable, and failed-to-resume targets reject promptly and actionably", async () => {
  for (const result of [
    undefined,
    { ok: false as const, reason: "not_terminal" as const },
    { ok: true as const, handle: completedHandle(async () => { throw new Error("session reopen failed"); }) },
  ]) {
    const harness = eventHarness();
    registerCompletedStageIntercomAskRouter(harness.pi as never, () => result);
    const started = performance.now();
    const event = harness.emit(askEvent());
    assert.equal(event.handled, true);
    await assert.rejects(event.completion!, /completed workflow stage|not resumable|session reopen failed/);
    assert.ok(performance.now() - started < 1_000, "failure must be bounded rather than waiting for ask timeout");
  }
});

test("ordinary completed-stage sends retain the existing late-message route", () => {
  const harness = eventHarness();
  registerCompletedStageIntercomAskRouter(harness.pi as never, () => { throw new Error("must not resolve"); });
  const event = askEvent();
  event.messages[0]!.details.message.expectsReply = false as never;
  harness.emit(event);
  assert.equal(event.handled, false);
  assert.equal(event.completion, undefined);
});
