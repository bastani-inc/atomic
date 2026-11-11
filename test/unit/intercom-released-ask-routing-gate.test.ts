import assert from "node:assert/strict";
import type { ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: true, hasSharedStorage: true, protocol: { min: 1, max: 3 } }),
}));

const { createEventBus } = await import("../../packages/coding-agent/src/core/event-bus.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { spawnBrokerIfNeeded } = await import("../../packages/intercom/broker/spawn.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");

type Routing = import("../../packages/intercom/types.js").BrokerMultiNodeStatus["status"] | undefined;
type LifecycleHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;

const ROUTINGS: readonly Routing[] = ["on", "off", "starting", "unavailable", undefined];
const ctx = {
	hasUI: false,
	cwd: process.cwd(),
	model: { id: "test-model" },
	isIdle: () => true,
	ui: { notify() {} },
	sessionManager: {
		getSessionId: () => "019f0000-aaaa-7bbb-8ccc-eeeeeeeeeeee",
		getBranch: () => [],
		getEntries: () => [],
	},
} as unknown as ExtensionContext;

let connected = true;
let routing: Routing = "on";
let connects = 0;

beforeEach(() => {
	connected = true;
	routing = "on";
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	connects = 0;
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async () => {
		connects++;
	});
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => connected);
	vi.spyOn(IntercomClient.prototype, "sessionId", "get").mockReturnValue("asker-session");
	vi.spyOn(IntercomClient.prototype, "multiNodeRouting", "get").mockImplementation(() => routing);
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
	vi.spyOn(IntercomClient.prototype, "reserveReleasedChildren").mockResolvedValue();
});

afterEach(() => vi.restoreAllMocks());

async function startedTools(connect = true): Promise<Map<string, ToolDefinition>> {
	const handlers = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	intercomHeavy({
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
	} as never);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	if (!connect) return tools;
	await tools.get("intercom")?.execute("list-call", { action: "list" } as never, undefined, undefined, ctx as never);
	assert.ok(connects > 0, "the session connected");
	return tools;
}

function detachable(tools: Map<string, ToolDefinition>, name: string, params: object): boolean {
	const predicate = tools.get(name)?.detachable;
	assert.equal(typeof predicate, "function", name);
	return typeof predicate === "function" && predicate(params as never);
}

test("a session's ask and supervisor question may be released with local or multi-node routing, never while routing is unsettled (#4386)", async () => {
	const tools = await startedTools();
	for (const status of ROUTINGS) {
		routing = status;
		const expected = status === "on" || status === "off";
		assert.equal(detachable(tools, "intercom", { action: "ask" }), expected, `ask: ${status}`);
		assert.equal(
			detachable(tools, "contact_supervisor", { reason: "need_decision" }),
			expected,
			`decision: ${status}`,
		);
		assert.equal(detachable(tools, "intercom", { action: "send" }), false, `a send never waits: ${status}`);
	}
	connected = false;
	routing = "starting";
	assert.equal(detachable(tools, "intercom", { action: "ask" }), true, "admitted before its connection exists");
});

test("an ask made before the session has any connection is admitted and decided once it connects (#4386)", async () => {
	routing = "starting";
	const tools = await startedTools(false);
	assert.equal(connects, 0);
	assert.equal(detachable(tools, "intercom", { action: "ask" }), true);
	assert.equal(detachable(tools, "contact_supervisor", { reason: "interview_request" }), true);
});
