import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";

type ToolResult = {
  content: Array<{ text: string }>;
  isError: boolean;
};

type Tool = {
  execute(
    id: string,
    params: { action?: string; to?: string; message?: string },
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: object,
  ): Promise<ToolResult>;
};

function session(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd: "/worktree",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    status: "idle",
  };
}

function ask(id: string): Message {
  return {
    id,
    timestamp: 1,
    expectsReply: true,
    content: { text: `question ${id}` },
  };
}

function toolFixture(replyTracker: ReplyTracker, sessions: SessionInfo[] = []) {
  let tool: Tool | undefined;
  const sent: Array<{
    to: string;
    messageId?: string;
    replyTo?: string;
    expectsReply?: boolean;
  }> = [];
  const client = {
    sessionId: "self-session-id",
    async listSessions(): Promise<SessionInfo[]> { return sessions; },
    async send(to: string, message: {
      messageId?: string;
      replyTo?: string;
      expectsReply?: boolean;
    }) {
      sent.push({
        to,
        ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
        ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
        ...(message.expectsReply !== undefined ? { expectsReply: message.expectsReply } : {}),
      });
      return { id: message.messageId ?? "reply-message", delivered: true };
    },
  };
  const waiterSlot = new ReplyWaiterSlot();
  registerIntercomTool({
    registerTool(value: Tool) { tool = value; },
    appendEntry() {},
  } as never, {
    ensureConnected: async () => client,
    syncPresenceIdentity() {},
    confirmSend: false,
    beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiterSlot.begin(from, replyTo, signal),
    replyTracker,
    hasReplyWaiter: () => waiterSlot.has(),
  } as never);
  assert.ok(tool);
  return { tool, sent, waiterSlot };
}

const context = {
  sessionManager: { getSessionId: () => "atomic-session" },
  hasUI: false,
};

describe("Intercom displayed session ID targeting", () => {
  test("targeted reply accepts the unique short session ID shown by list", async () => {
    const first = session("aa56071e-1111-4222-8333-123456789abc", "first");
    const second = session("bb67082f-1111-4222-8333-123456789abc", "second");
    const replies = new ReplyTracker();
    replies.recordIncomingMessage(first, ask("question-first"));
    replies.recordIncomingMessage(second, ask("question-second"));
    const current = toolFixture(replies);

    const result = await current.tool.execute(
      "reply-call",
      { action: "reply", to: first.id.slice(0, 8), message: "answer" },
      undefined,
      undefined,
      context,
    );

    assert.equal(result.isError, false, result.content[0]?.text);
    assert.deepEqual(current.sent, [{ to: first.id, replyTo: "question-first" }]);
  });

  test("blocking ask accepts the ID exactly as displayed by list and correlates the reply", async () => {
    const self = session("self-session-id", "self");
    const recipient = session("aa56071e-1111-4222-8333-123456789abc", "recipient");
    const current = toolFixture(new ReplyTracker(), [self, recipient]);
    const listed = await current.tool.execute(
      "list-call",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    const displayedId = recipient.id.slice(0, 8);
    assert.match(listed.content[0]?.text ?? "", new RegExp(`recipient \\(${displayedId}\\)`));

    const execution = current.tool.execute(
      "ask-call",
      { action: "ask", to: displayedId, message: "question" },
      undefined,
      undefined,
      context,
    );
    await Bun.sleep(0);
    const waiter = current.waiterSlot.current();
    const routed = waiter === null ? false : routeIncomingReply(waiter, recipient, {
      id: "threaded-reply",
      timestamp: 2,
      replyTo: waiter.replyTo,
      content: { text: "answer" },
    });
    const result = await execution;

    assert.equal(routed, true);
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.equal(current.sent[0]?.to, recipient.id);
    assert.match(result.content[0]?.text ?? "", /answer/);
  });

  test("send accepts the unique short session ID shown by list", async () => {
    const self = session("self-session-id", "self");
    const recipient = session("cc78193a-1111-4222-8333-123456789abc", "recipient");
    const current = toolFixture(new ReplyTracker(), [self, recipient]);
    const listed = await current.tool.execute("list", { action: "list" }, undefined, undefined, context);
    const displayedId = recipient.id.slice(0, 8);
    assert.match(listed.content[0]?.text ?? "", new RegExp(`recipient \\(${displayedId}\\)`));

    const result = await current.tool.execute(
      "send",
      { action: "send", to: displayedId, message: "hello" },
      undefined,
      undefined,
      context,
    );

    assert.equal(result.isError, false, result.content[0]?.text);
    assert.equal(current.sent[0]?.to, recipient.id);
  });

  test("colliding displayed prefixes fail clearly instead of selecting a session", async () => {
    const self = session("self-session-id", "self");
    const first = session("dd892a4b-1111-4222-8333-123456789abc", "first");
    const second = session("dd892a4b-9999-4222-8333-123456789abc", "second");
    const current = toolFixture(new ReplyTracker(), [self, first, second]);

    const result = await current.tool.execute(
      "send",
      { action: "send", to: "dd892a4b", message: "hello" },
      undefined,
      undefined,
      context,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Ambiguous session ID prefix "dd892a4b"/);
    assert.match(result.content[0]?.text ?? "", new RegExp(first.id));
    assert.match(result.content[0]?.text ?? "", new RegExp(second.id));
    assert.deepEqual(current.sent, []);
  });

  test("blocking ask rejects a colliding displayed prefix before sending", async () => {
    const self = session("self-session-id", "self");
    const first = session("de903b5c-1111-4222-8333-123456789abc", "first");
    const second = session("de903b5c-9999-4222-8333-123456789abc", "second");
    const current = toolFixture(new ReplyTracker(), [self, first, second]);

    const result = await current.tool.execute(
      "ask",
      { action: "ask", to: "de903b5c", message: "question" },
      undefined,
      undefined,
      context,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Ambiguous session ID prefix "de903b5c"/);
    assert.deepEqual(current.sent, []);
  });

  test("targeted reply rejects a colliding displayed prefix before sending", async () => {
    const first = session("df014c6d-1111-4222-8333-123456789abc", "first");
    const second = session("df014c6d-9999-4222-8333-123456789abc", "second");
    const replies = new ReplyTracker();
    replies.recordIncomingMessage(first, ask("question-first"));
    replies.recordIncomingMessage(second, ask("question-second"));
    const current = toolFixture(replies);

    const result = await current.tool.execute(
      "reply",
      { action: "reply", to: "df014c6d", message: "answer" },
      undefined,
      undefined,
      context,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Ambiguous session ID prefix "df014c6d"/);
    assert.deepEqual(current.sent, []);
  });

  test("exact names and exact full IDs take precedence over prefix matching", async () => {
    const self = session("self-session-id", "self");
    const byName = session("ee903b5c-1111-4222-8333-123456789abc", "target-alias");
    const byId = session("target-alias-full-id", "other");
    const current = toolFixture(new ReplyTracker(), [self, byName, byId]);

    const nameResult = await current.tool.execute(
      "send-name",
      { action: "send", to: "target-alias", message: "by name" },
      undefined,
      undefined,
      context,
    );
    const idResult = await current.tool.execute(
      "send-id",
      { action: "send", to: byId.id, message: "by id" },
      undefined,
      undefined,
      context,
    );

    assert.equal(nameResult.isError, false, nameResult.content[0]?.text);
    assert.equal(idResult.isError, false, idResult.content[0]?.text);
    assert.deepEqual(current.sent.map((entry) => entry.to), [byName.id, byId.id]);
  });

  test("a short self ID is rejected before delivery", async () => {
    const self = session("self-session-id", "self");
    const selfClient = toolFixture(new ReplyTracker(), [self]);

    const result = await selfClient.tool.execute(
      "send-self",
      { action: "send", to: "self-ses", message: "loop" },
      undefined,
      undefined,
      context,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Cannot message the current session/);
    assert.deepEqual(selfClient.sent, []);
  });
});
