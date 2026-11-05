import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import {
	RELEASED_CHILD_REPLY_EVENT,
	type ReleasedChildReplyRequest,
} from "../../packages/intercom/released-reply-wait.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "intercom-released-reply-"));
afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
});
vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
type LifecycleHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;
const ctx = {
	hasUI: false,
	cwd: process.cwd(),
	model: { id: "vendor-model-a" },
	isIdle: () => true,
	ui: { notify() {} },
	sessionManager: { getSessionId: () => "owner", getBranch: () => [], getEntries: () => [] },
} as never as ExtensionContext;
const from = {
	id: "peer",
	name: "peer",
	cwd: "/repo",
	model: "vendor-model-a",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
	group: "default",
} satisfies SessionInfo;
const message: Message = { id: "reply-1", replyTo: "q-1", timestamp: 1, content: { text: "answer" } };
let active: IntercomClient | undefined;
let confirmations: Array<[string, boolean]>;
beforeEach(() => {
	active = undefined;
	confirmations = [];
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (this: IntercomClient) {
		active = this;
	});
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "isConnected").mockReturnValue(true);
	vi.spyOn(IntercomClient.prototype, "sessionId", "get").mockReturnValue("owner");
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
	vi.spyOn(IntercomClient.prototype, "acknowledgeReleasedChildReply").mockImplementation((id, accepted) => {
		confirmations.push([id, accepted]);
		return true;
	});
});
afterEach(() => vi.restoreAllMocks());

async function owner() {
	const handlers = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	const events = createEventBus();
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
		appendEntry() {},
		getSessionName: () => undefined,
		events,
	};
	intercomHeavy(pi as never);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	const tool = tools.get("intercom");
	assert.ok(tool);
	await tool.execute("list-1", { action: "list" }, undefined, undefined, ctx as never);
	assert.ok(active);
	return { events, client: active };
}

for (const accepted of [true, false]) {
	test(`the broker reply is ${accepted ? "accepted" : "refused"} only after the owner finishes saving it (#4326)`, async () => {
		const h = await owner();
		const saved = Promise.withResolvers<boolean>();
		let received: ReleasedChildReplyRequest | undefined;
		h.events.on(RELEASED_CHILD_REPLY_EVENT, (value) => {
			received = value as ReleasedChildReplyRequest;
			received.completion = saved.promise;
		});
		h.client.emit("released_child_reply", { childName: "child", replyTo: "q-1", from, message });
		assert.equal(received?.childName, "child");
		assert.deepEqual(confirmations, []);
		saved.resolve(accepted);
		await vi.waitFor(() => assert.deepEqual(confirmations, [["reply-1", accepted]]));
	});
}
