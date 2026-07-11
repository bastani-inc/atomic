import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { ForegroundDetachHandoff, handleForegroundInboundDelivery } from "../../packages/intercom/foreground-detach-handoff.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { agentConfig, successEvent, withFakeCli } from "./subagents-attempt-watchdog-helpers.js";

type Tool = { execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: object): Promise<{ content: Array<{ text: string }>; isError: boolean }> };

function fixture(kind: "intercom" | "supervisor") {
  let tool: Tool | undefined;
  const sent: Array<{ to: string; message: { messageId?: string; text: string; expectsReply?: boolean; replyTo?: string } }> = [];
  const waiterCalls: Array<{ from: string; replyTo: string }> = [];
  let waiter: { from: string; replyTo: string; resolve: (message: Message) => void } | undefined;
  const client = {
    sessionId: "child-id",
    async listSessions() { return []; },
    async send(to: string, message: { messageId?: string; text: string; expectsReply?: boolean; replyTo?: string }) {
      sent.push({ to, message });
      return { id: message.messageId ?? "sent", delivered: true };
    },
  };
  const pi = {
    registerTool(value: Tool) { tool = value; },
    appendEntry() {},
  };
  const common = {
    ensureConnected: async () => client,
    syncPresenceIdentity() {},
    resolveSessionTarget: async (_client: object, target: string) => target === "parent" ? "parent-id" : target,
    waitForReply(from: string, replyTo: string) {
      waiterCalls.push({ from, replyTo });
      return new Promise<Message>((resolve) => { waiter = { from, replyTo, resolve }; });
    },
    hasReplyWaiter: () => Boolean(waiter),
    rejectReplyWaiter() { waiter = undefined; },
  };
  if (kind === "intercom") {
    registerIntercomTool(pi as never, { ...common, confirmSend: false, replyTracker: new ReplyTracker() } as never);
  } else {
    registerContactSupervisorTool(pi as never, {
      ...common,
      childOrchestratorMetadata: { orchestratorTarget: "parent", runId: "run", agent: "worker", index: 2 },
    } as never);
  }
  return {
    sent,
    waiterCalls,
    get waiter() { return waiter; },
    get tool() { assert.ok(tool); return tool; },
    reply(text: string) {
      assert.ok(waiter);
      const current = waiter;
      waiter = undefined;
      current.resolve({ id: "reply", timestamp: 2, replyTo: current.replyTo, content: { text } });
    },
  };
}

const context = { sessionManager: { getSessionId: () => "child-session" }, hasUI: false };

describe("registered blocking intercom tools", () => {
  test("intercom ask waits for an exact threaded reply and resumes", async () => {
    const current = fixture("intercom");
    const execution = current.tool.execute("call", { action: "ask", to: "parent", message: "Choose" }, undefined, undefined, context);
    await Bun.sleep(0);
    assert.equal(current.sent.length, 1);
    const question = current.sent[0]!;
    assert.equal(question.to, "parent-id");
    assert.equal(question.message.expectsReply, true);
    assert.equal(typeof question.message.messageId, "string");
    assert.deepEqual(current.waiterCalls, [{ from: "parent-id", replyTo: question.message.messageId }]);
    assert.equal(current.waiter?.replyTo, question.message.messageId);
    current.reply("Approved");
    const result = await execution;
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /Approved/);
    assert.equal(context.sessionManager.getSessionId(), "child-session", "the same foreground child continues after its reply");
  });

  test("contact_supervisor need_decision uses the same threaded waiter path", async () => {
    const current = fixture("supervisor");
    const execution = current.tool.execute("call", { reason: "need_decision", message: "Choose" }, undefined, undefined, context);
    await Bun.sleep(0);
    assert.equal(current.sent.length, 1);
    assert.equal(current.sent[0]?.to, "parent-id");
    assert.equal(current.sent[0]?.message.expectsReply, true);
    assert.deepEqual(current.waiterCalls, [{ from: "parent-id", replyTo: current.sent[0]?.message.messageId }]);
    current.reply("Use option B");
    const result = await execution;
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /Use option B/);
  });

  test("send and progress_update return without creating a reply waiter", async () => {
    const send = fixture("intercom");
    const sent = await send.tool.execute("call", { action: "send", to: "parent", message: "Update" }, undefined, undefined, context);
    assert.equal(sent.isError, false);
    assert.equal(send.sent[0]?.message.expectsReply, undefined);
    assert.equal(send.waiterCalls.length, 0);

    const progress = fixture("supervisor");
    const updated = await progress.tool.execute("call", { reason: "progress_update", message: "Halfway" }, undefined, undefined, context);
    assert.equal(updated.isError, false);
    assert.equal(progress.sent[0]?.message.expectsReply, undefined);
    assert.equal(progress.waiterCalls.length, 0);
  });
});

type EventPayload = Record<string, unknown>;

function joinedBus(emitter: EventEmitter, order: string[]) {
  return {
    on(channel: string, handler: (payload: EventPayload) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    emit(channel: string, payload: EventPayload) {
      if (channel.endsWith("detach-request")) order.push(String(payload.phase));
      emitter.emit(channel, payload);
    },
  };
}

for (const kind of ["intercom", "supervisor"] as const) {
  test(`joined production inbound handoff resumes ${kind === "intercom" ? "generic ask" : "contact_supervisor need_decision"}`, async () => {
	const gateName = `reply-gate-${kind}`;
	const fakeScript = `import { existsSync } from "node:fs";\nimport { join } from "node:path";\nconst gate = join(process.cwd(), ${JSON.stringify(gateName)});\nconst timer = setInterval(() => { if (!existsSync(gate)) return; clearInterval(timer); console.log(${JSON.stringify(successEvent("eventual recovered child result"))}); }, 5);`;
	await withFakeCli(fakeScript, async (dir) => {
      const emitter = new EventEmitter();
      const order: string[] = [];
      const bus = joinedBus(emitter, order);
      const piForHandoff = { events: bus };
      const childTarget = "subagent-worker-joined-1";
      const recovered: Array<{ finalOutput?: string; exitCode: number }> = [];
      const foreground = runSync(dir, [{ ...agentConfig(), systemPrompt: "Intercom orchestration channel" }], "fake-worker", "task", {
        cwd: dir,
        runId: "joined",
        index: 0,
        intercomSessionName: childTarget,
        allowIntercomDetach: true,
        intercomEvents: bus,
        onDetachedExit: (value) => recovered.push(value),
      });

      let registered: Tool | undefined;
      let waiter: { replyTo: string; resolve: (message: Message) => void } | undefined;
      const surfaced: Message[] = [];
      const handoff = new ForegroundDetachHandoff(piForHandoff as never, 1000);
      const from: SessionInfo = { id: "child-id", name: childTarget, cwd: dir, model: "test", pid: 1, startedAt: 1, lastActivity: 1, status: "thinking" };
      const client = {
        sessionId: "child-id",
        async listSessions() { return []; },
        async send(_to: string, outgoing: { messageId?: string; text: string; expectsReply?: boolean; replyTo?: string }) {
          const message: Message = { id: outgoing.messageId ?? "missing", timestamp: Date.now(), expectsReply: outgoing.expectsReply, replyTo: outgoing.replyTo, content: { text: outgoing.text } };
          await handleForegroundInboundDelivery({
            handoff, from, message, generation: 7, isCurrent: () => true,
            surface: () => { order.push("surface"); surfaced.push(message); },
            onUnclaimed: () => { throw new Error("exact foreground owner was not found"); },
          });
          return { id: message.id, delivered: true };
        },
      };
      const common = {
        ensureConnected: async () => client,
        syncPresenceIdentity() {},
        resolveSessionTarget: async () => "parent-id",
        waitForReply(_from: string, replyTo: string) { return new Promise<Message>((resolve) => { waiter = { replyTo, resolve }; }); },
        hasReplyWaiter: () => Boolean(waiter),
        rejectReplyWaiter() { waiter = undefined; },
      };
      const toolPi = { registerTool(value: Tool) { registered = value; }, appendEntry() {} };
      if (kind === "intercom") registerIntercomTool(toolPi as never, { ...common, confirmSend: false, replyTracker: new ReplyTracker() } as never);
      else registerContactSupervisorTool(toolPi as never, { ...common, childOrchestratorMetadata: { orchestratorTarget: "parent", runId: "joined", agent: "worker", index: 0 } } as never);
      assert.ok(registered);
      const toolExecution = kind === "intercom"
        ? registered.execute("call", { action: "ask", to: "parent", message: "Choose" }, undefined, undefined, context)
        : registered.execute("call", { reason: "need_decision", message: "Choose" }, undefined, undefined, context);

      const detached = await foreground;
      assert.equal(detached.detached, true);
      assert.equal(surfaced.length, 1);
      assert.deepEqual(order.slice(0, 3), ["probe", "commit", "surface"]);
      assert.equal(waiter?.replyTo, surfaced[0]?.id);
		order.push("reply");
		const routed = routeIncomingReply(waiter ? { ...waiter, from: "parent-id" } : undefined, {
			id: "parent-id", name: "parent", cwd: dir, model: "test", pid: 2,
			startedAt: 1, lastActivity: 1, status: "waiting",
		}, { id: "parent-reply", timestamp: Date.now(), replyTo: surfaced[0]?.id, content: { text: "Approved" } });
		assert.equal(routed, true, "production routing seam accepts the exact threaded parent reply");
		const resumed = await toolExecution;
      assert.equal(resumed.isError, false);
      assert.match(resumed.content[0]?.text ?? "", /Approved/);
      order.push("continued");
		writeFileSync(join(dir, gateName), "reply received");
      for (let attempt = 0; attempt < 40 && recovered.length === 0; attempt++) await Bun.sleep(10);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.exitCode, 0);
      assert.match(recovered[0]?.finalOutput ?? "", /eventual recovered child result/);
      assert.ok(order.indexOf("continued") > order.indexOf("reply"));
    });
  });
}
