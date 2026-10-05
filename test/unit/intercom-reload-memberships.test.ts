import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

type LifecycleHandler = (event: { type: string; reason: string }, ctx: ExtensionContext) => unknown;
type ToolResult = { isError: boolean; content: Array<{ text: string }> };
interface IntercomTool {
	name: string;
	execute(
		id: string,
		params: { action: string; group?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

function sessionContext(sessionId: string): ExtensionContext {
	return {
		hasUI: false,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	} as unknown as ExtensionContext;
}

function loadGeneration(events: ReturnType<typeof createEventBus>) {
	const handlers = new Map<string, LifecycleHandler[]>();
	let intercomTool: IntercomTool | undefined;
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: IntercomTool) {
			if (tool.name === "intercom") intercomTool = tool;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getSessionName: () => undefined,
		events,
	};
	intercomHeavy(pi as never);
	return {
		async fire(name: "session_start" | "session_shutdown", reason: string, ctx: ExtensionContext) {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason }, ctx);
		},
		run(params: { action: string; group?: string }, ctx: ExtensionContext): Promise<ToolResult> {
			assert.ok(intercomTool, "the intercom tool is registered");
			return intercomTool.execute(params.action, params, undefined, undefined, ctx);
		},
	};
}

function recordBrokerRegistrations(): string[][] {
	const registrations: string[][] = [];
	let memberships: string[] = [];
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async (registration) => {
		memberships = [...(registration.groups ?? [])];
		registrations.push([...memberships]);
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockReturnValue(true);
	vi.spyOn(IntercomClient.prototype, "joinGroup").mockImplementation(async (group) => {
		memberships = [...new Set([...memberships, group])];
		return [...memberships];
	});
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
	vi.spyOn(IntercomClient.prototype, "updatePresence").mockReturnValue(true);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	return registrations;
}

test.each(["the successor starts first", "the retiring generation stops first"])(
	"a reloaded session re-registers its joined Intercom groups when %s (#3425)",
	async (order) => {
		const registrations = recordBrokerRegistrations();
		const events = createEventBus();
		const ctx = sessionContext("supervisor-session");
		const retiring = loadGeneration(events);
		await retiring.fire("session_start", "startup", ctx);
		const joined = await retiring.run({ action: "join", group: "workflow:run-1" }, ctx);
		assert.equal(joined.isError, false, joined.content[0]?.text);

		const successor = loadGeneration(events);
		if (order === "the successor starts first") {
			await successor.fire("session_start", "reload", ctx);
			await retiring.fire("session_shutdown", "reload", ctx);
		} else {
			await retiring.fire("session_shutdown", "reload", ctx);
			await successor.fire("session_start", "reload", ctx);
		}
		const status = await successor.run({ action: "status" }, ctx);
		assert.equal(status.isError, false, status.content[0]?.text);
		assert.deepEqual(registrations, [["default"], ["default", "workflow:run-1"]]);
		await successor.fire("session_shutdown", "quit", ctx);
	},
);

test("Intercom groups joined before a session ends are not restored by a later reload (#3425)", async () => {
	const registrations = recordBrokerRegistrations();
	const events = createEventBus();
	const ctx = sessionContext("resumed-session");
	const ended = loadGeneration(events);
	await ended.fire("session_start", "startup", ctx);
	const joined = await ended.run({ action: "join", group: "workflow:run-1" }, ctx);
	assert.equal(joined.isError, false, joined.content[0]?.text);
	await ended.fire("session_shutdown", "new", ctx);

	const reloaded = loadGeneration(events);
	await reloaded.fire("session_start", "reload", ctx);
	const status = await reloaded.run({ action: "status" }, ctx);
	assert.equal(status.isError, false, status.content[0]?.text);
	assert.deepEqual(registrations, [["default"], ["default"]]);
	await reloaded.fire("session_shutdown", "quit", ctx);
});
