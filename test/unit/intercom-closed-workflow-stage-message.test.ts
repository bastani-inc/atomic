import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { routeClosedWorkflowStageMessage } from "../../packages/intercom/closed-workflow-stage-message.js";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import intercom from "../../packages/intercom/index.js";
import { registerCompletedStageIntercomAskRouter, type CompletedStageHandleResolver } from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
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

interface ComposedLateAskEvent {
  handled: boolean;
  completion?: Promise<void>;
  batch: boolean;
  workflowRunId: string;
  workflowStageId: string;
  messages: Array<{
    customType: "intercom_message";
    content: string;
    details: { from: SessionInfo; message: Message; bodyText: string };
  }>;
}

function productionComposition(
  order: "workflow-first" | "intercom-first",
  resolve: CompletedStageHandleResolver,
  onHeavyLateMessage?: (payload: unknown) => void,
) {
  const emitter = new EventEmitter();
  const lifecycleHandlers = new Map<string, Array<(...args: never[]) => void>>();
  const bus = {
    on(name: string, listener: (payload: unknown) => void) {
      emitter.on(name, listener);
      return () => emitter.off(name, listener);
    },
    emit(name: string, payload: unknown) { emitter.emit(name, payload); },
  };
  let heavyImports = 0;
  const pi = {
    events: bus,
    on(name: string, listener: (...args: never[]) => void) {
      const current = lifecycleHandlers.get(name) ?? [];
      current.push(listener);
      lifecycleHandlers.set(name, current);
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
  };
  const registerWorkflow = () => registerCompletedStageIntercomAskRouter(pi, resolve);
  const registerIntercom = () => intercom(pi as never, {
    async importHeavy() {
      heavyImports += 1;
      return {
        default(heavyPi: { events: { on(name: string, listener: (payload: unknown) => void): void } }) {
          if (onHeavyLateMessage) {
            heavyPi.events.on("atomic:workflow-stage-late-message", onHeavyLateMessage);
          }
        },
      };
    },
  });
  if (order === "workflow-first") {
    registerWorkflow();
    registerIntercom();
  } else {
    registerIntercom();
    registerWorkflow();
  }
  registerWorkflow();
  return { bus, get heavyImports() { return heavyImports; } };
}

test("production listener composition preserves the workflow owner's failed revival completion in either order", async () => {
  for (const order of ["workflow-first", "intercom-first"] as const) {
    let resolutions = 0;
    const composition = productionComposition(order, () => { resolutions += 1; return undefined; });
    const admission = new InboundMessageAdmission();
    const tracker = new ReplyTracker();
    const message = ask();
    const sent = Promise.withResolvers<{ to: string; options: { text: string; replyTo?: string; replyError?: string } }>();
    const client = {
      isConnected: () => true,
      async send(to: string, options: { text: string; replyTo?: string; replyError?: string }) {
        sent.resolve({ to, options });
        return { id: "failure-reply", delivered: true };
      },
    };
    routeClosedWorkflowStageMessage(
      { from: sender, message, bodyText: message.content.text },
      admission,
      tracker,
      null,
      () => {
        const event: ComposedLateAskEvent = {
          handled: false,
          batch: false,
          workflowRunId: "run-1",
          workflowStageId: "stage-a",
          messages: [{
            customType: "intercom_message",
            content: "exact ask",
            details: { from: sender, message, bodyText: message.content.text },
          }],
        };
        composition.bus.emit("atomic:workflow-stage-late-message", event);
        assert.equal(event.handled, true);
        assert.ok(event.completion);
        return event.completion;
      },
      () => client as never,
      () => true,
    );
    const failure = await Promise.race([
      sent.promise,
      Bun.sleep(100).then(() => { throw new Error(`correlated failure timed out for ${order}`); }),
    ]);
    const exact = "Completed workflow stage could not process intercom ask: Intercom ask target is unavailable: completed workflow stage run-1/stage-a was deleted or is no longer retained.";
    assert.deepEqual(failure, {
      to: sender.id,
      options: { text: exact, replyTo: message.id, replyError: exact },
    });
    assert.equal(resolutions, 1, "duplicate workflow listeners cannot double-fail");
    assert.equal(composition.heavyImports, 0, "the generic Intercom stub cannot steal a completed-stage ask");
  }
});

test("production listener composition revives a completed stage exactly once in either order", async () => {
  for (const order of ["workflow-first", "intercom-first"] as const) {
    const prompts: string[] = [];
    const handle: StageControlHandle = {
      runId: "run-1",
      stageId: "stage-a",
      stageName: "A",
      status: "completed",
      sessionId: "stage-a-session",
      sessionFile: "/tmp/stage-a.jsonl",
      isStreaming: false,
      messages: [],
      ensureAttached: async () => {},
      prompt: async (text) => { prompts.push(text); },
      steer: async () => {},
      followUp: async () => {},
      pause: async () => {},
      resume: async () => {},
      subscribe: () => () => {},
    };
    const composition = productionComposition(order, () => ({ ok: true, handle }));
    const event: ComposedLateAskEvent = {
      handled: false,
      batch: false,
      workflowRunId: "run-1",
      workflowStageId: "stage-a",
      messages: [{
        customType: "intercom_message",
        content: "exact retained turn",
        details: { from: sender, message: ask(), bodyText: "exact retained turn" },
      }],
    };
    composition.bus.emit("atomic:workflow-stage-late-message", event);
    assert.ok(event.completion);
    await event.completion;
    assert.deepEqual(prompts, ["exact retained turn"]);
    assert.equal(composition.heavyImports, 0);
  }
});

test("production listener composition retains ordinary late Intercom handling", async () => {
  for (const order of ["workflow-first", "intercom-first"] as const) {
    const relayed: unknown[] = [];
    const composition = productionComposition(
      order,
      () => { throw new Error("ordinary traffic must not resolve a completed-stage handle"); },
      (payload) => { relayed.push(payload); },
    );
    const message = { ...ask(), expectsReply: false };
    const event: ComposedLateAskEvent = {
      handled: false,
      batch: false,
      workflowRunId: "run-1",
      workflowStageId: "stage-a",
      messages: [{
        customType: "intercom_message",
        content: "ordinary notice",
        details: { from: sender, message, bodyText: "ordinary notice" },
      }],
    };
    composition.bus.emit("atomic:workflow-stage-late-message", event);
    assert.equal(event.handled, true);
    assert.ok(event.completion);
    await event.completion;
    assert.deepEqual(relayed, [event]);
    assert.equal(composition.heavyImports, 1);
  }
});

test("the ask tool receives the production-composed correlated revival failure without its long timeout", async () => {
  const composition = productionComposition("workflow-first", () => undefined);
  const targetAdmission = new InboundMessageAdmission();
  const targetTracker = new ReplyTracker();
  const callerWaiter = new ReplyWaiterSlot();
  const caller: SessionInfo = {
    id: "stage-b-intercom", name: "B", cwd: "/repo", model: "test",
    pid: 2, startedAt: 1, lastActivity: 1,
  };
  const target: SessionInfo = {
    id: "stage-a-intercom", name: "A", cwd: "/repo", model: "test",
    pid: 1, startedAt: 1, lastActivity: 1,
  };
  const targetClient = {
    isConnected: () => true,
    async send(_to: string, options: { text: string; replyTo?: string; replyError?: string }) {
      const routed = routeIncomingReply(callerWaiter.current(), target, {
        id: "correlated-failure",
        timestamp: Date.now(),
        replyTo: options.replyTo,
        replyError: options.replyError,
        content: { text: options.text },
      });
      assert.equal(routed, true);
      return { id: "correlated-failure", delivered: true };
    },
  };
  let registered: {
    execute(id: string, params: Record<string, string>, signal: AbortSignal | undefined, update: undefined, ctx: object): Promise<{
      content: Array<{ text: string }>;
      isError: boolean;
    }>;
  } | undefined;
  const callerClient = {
    sessionId: caller.id,
    async listSessions() { return [target]; },
    async send(_to: string, outgoing: { messageId?: string; text: string; expectsReply?: boolean }) {
      const inbound: Message = {
        id: outgoing.messageId ?? "missing",
        timestamp: Date.now(),
        expectsReply: outgoing.expectsReply,
        content: { text: outgoing.text },
      };
      routeClosedWorkflowStageMessage(
        { from: caller, message: inbound, bodyText: inbound.content.text },
        targetAdmission,
        targetTracker,
        null,
        () => {
          const event: ComposedLateAskEvent = {
            handled: false,
            batch: false,
            workflowRunId: "run-1",
            workflowStageId: "stage-a",
            messages: [{
              customType: "intercom_message",
              content: outgoing.text,
              details: { from: caller, message: inbound, bodyText: inbound.content.text },
            }],
          };
          composition.bus.emit("atomic:workflow-stage-late-message", event);
          assert.ok(event.completion);
          return event.completion;
        },
        () => targetClient as never,
        () => true,
      );
      return { id: inbound.id, delivered: true };
    },
  };
  registerIntercomTool({
    registerTool(tool: typeof registered) { registered = tool; },
    appendEntry() {},
  } as never, {
    ensureConnected: async () => callerClient,
    syncPresenceIdentity() {},
    resolveSessionTarget: async () => target.id,
    beginReplyWait(from: string, replyTo: string, signal?: AbortSignal) {
      return callerWaiter.begin(from, replyTo, signal);
    },
    hasReplyWaiter: () => callerWaiter.has(),
    confirmSend: false,
    replyTracker: new ReplyTracker(),
  } as never);
  assert.ok(registered);
  const started = performance.now();
  const result = await registered.execute(
    "tool-call",
    { action: "ask", to: target.id, message: "exact ask" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => caller.id }, hasUI: false },
  );
  assert.ok(performance.now() - started < 1_000, "failure must arrive well below the 10-minute ask timeout");
  const exact = "Completed workflow stage could not process intercom ask: Intercom ask target is unavailable: completed workflow stage run-1/stage-a was deleted or is no longer retained.";
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, `Failed: ${exact}`);
  assert.equal(callerWaiter.has(), false);
});
