import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";

const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousIntercomGroup = process.env.ATOMIC_INTERCOM_GROUP;
process.env.ATOMIC_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "intercom-released-ask-wait-"));
delete process.env.ATOMIC_INTERCOM_GROUP;

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousIntercomGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
	else process.env.ATOMIC_INTERCOM_GROUP = previousIntercomGroup;
});

import { IntercomClient, type SendOptions } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { releasedReplyMailbox } from "../../packages/intercom/released-reply-mailbox.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));

type LifecycleHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

const SESSION_ID = "019f0000-aaaa-7bbb-8ccc-eeeeeeeeeeee";
const REPLIER: SessionInfo = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "replier",
	cwd: "/repo",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
	group: "default",
};

const ctx = {
	hasUI: false,
	cwd: process.cwd(),
	model: { id: "test-model" },
	isIdle: () => true,
	ui: { notify() {} },
	sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [], getEntries: () => [] },
} as unknown as ExtensionContext;

let questions: Array<{ to: string; options: SendOptions }> = [];
let connected = true;

beforeEach(() => {
	questions = [];
	connected = true;
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	vi.spyOn(IntercomClient.prototype, "connect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockImplementation(async () => {
		connected = false;
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => connected);
	vi.spyOn(IntercomClient.prototype, "sessionId", "get").mockReturnValue("asker-session");
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([REPLIER]);
	vi.spyOn(IntercomClient.prototype, "reserveReleasedChildren").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "send").mockImplementation(async (to, options) => {
		questions.push({ to, options });
		return { id: options.messageId ?? "unknown", delivered: true };
	});
});

afterEach(() => vi.restoreAllMocks());

function startHeavy() {
	const handlers = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	const appended: string[] = [];
	let released = false;
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string) {
			if (released) throw new Error("This extension ctx is stale after session replacement or reload.");
			appended.push(customType);
		},
		getSessionName: () => undefined,
		events: createEventBus(),
	};
	intercomHeavy(pi as never);
	return {
		tools,
		appended,
		async fire(name: string) {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "quit" }, ctx);
		},
		release() {
			released = true;
		},
	};
}

describe("an ask that outlives its released session (#4326)", () => {
	test("the ask's wait survives the session's shutdown and resolves with the reply delivered to the process mailbox (#4326)", async () => {
		const harness = startHeavy();
		await harness.fire("session_start");
		const tool = harness.tools.get("intercom");
		assert.ok(tool);
		const call = new AbortController();
		const pending: Promise<ToolResult> = tool.execute(
			"call-1",
			{ action: "ask", to: "replier", message: "Which file?" },
			call.signal,
			undefined,
			ctx as never,
		);
		await vi.waitFor(() => assert.equal(questions.length, 1));
		const questionId = questions[0]?.options.messageId;
		assert.ok(questionId);
		assert.equal(questions[0]?.options.expectsReply, true);
		await vi.waitFor(() => assert.ok(harness.appended.includes("intercom_sent")));
		const appendedBeforeRelease = [...harness.appended];
		const before = releasedReplyMailbox().size;

		await harness.fire("session_shutdown");
		harness.release();
		assert.equal(releasedReplyMailbox().size, before + 1, "the running wait is kept, not rejected");

		const reply: Message = { id: "reply-1", timestamp: 2, replyTo: questionId, content: { text: "src/config.ts" } };
		assert.equal(releasedReplyMailbox().deliver(REPLIER, reply), true);
		const result = await pending;
		assert.equal(result.isError, false);
		assert.deepEqual(result.content, [{ type: "text", text: "**Reply from replier:**\nsrc/config.ts" }]);
		assert.equal(releasedReplyMailbox().size, before);
		assert.deepEqual(harness.appended, appendedBeforeRelease, "nothing is written to the released session");
	});

	test("a cancelled ask is rejected at shutdown as before and leaves nothing in the mailbox (#4326)", async () => {
		const harness = startHeavy();
		await harness.fire("session_start");
		const tool = harness.tools.get("intercom");
		assert.ok(tool);
		const call = new AbortController();
		const pending = tool.execute(
			"call-2",
			{ action: "ask", to: "replier", message: "Which file?" },
			call.signal,
			undefined,
			ctx as never,
		);
		await vi.waitFor(() => assert.equal(questions.length, 1));
		const before = releasedReplyMailbox().size;
		call.abort();
		await harness.fire("session_shutdown");
		const result = await pending;
		assert.equal(result.isError, true);
		assert.equal(releasedReplyMailbox().size, before);
	});
});
