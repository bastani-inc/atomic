import assert from "node:assert/strict";
import { type ExtensionContext, IntercomBrokerUpgradeError } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { queryBrokerRouting } from "../../packages/intercom/broker/broker-routing.js";
import { type ExpectedRouting, IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded, upgradeBroker } from "../../packages/intercom/broker/spawn.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/** #4538: what a session does with the broker it finds, by the broker's protocol range, counted call by call. */

useTemporaryAgentDir();

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn(), upgradeBroker: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({ queryBrokerRouting: vi.fn() }));

const LEGACY = { min: 1, max: 1 };
const CURRENT = { min: 1, max: 2 };

let connects: Array<ExpectedRouting | undefined>;

beforeEach(() => {
	connects = [];
	vi.mocked(spawnBrokerIfNeeded).mockReset().mockResolvedValue(undefined);
	vi.mocked(upgradeBroker).mockReset();
	vi.mocked(queryBrokerRouting).mockReset();
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async (...args) => {
		connects.push(args[5]);
	});
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

function routing(protocol: { min: number; max: number }) {
	return { acrossMachines: false, hasSharedStorage: false, protocol };
}

interface ToolResult {
	isError: boolean;
	content: Array<{ text: string }>;
}

async function startSession(): Promise<{ status: () => Promise<ToolResult>; notices: string[] }> {
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	let tool: { execute(...args: unknown[]): Promise<ToolResult> } | undefined;
	const pi = {
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(registered: { name: string; execute(...args: unknown[]): Promise<ToolResult> }) {
			if (registered.name === "intercom") tool = registered;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
	};
	intercomHeavy(pi as never);
	const notices: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: { notify: (message: string, level: string) => notices.push(`${level}: ${message}`), setStatus() {} },
		sessionManager: { getSessionId: () => "upgrade-session", getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" } as never, ctx);
	return {
		notices,
		status: () => {
			assert.ok(tool);
			return tool.execute("status", { action: "status" }, undefined, undefined, ctx);
		},
	};
}

test("a session finding an older broker replaces it once, then registers verified with the successor (#4538)", async () => {
	vi.mocked(queryBrokerRouting).mockResolvedValueOnce(routing(LEGACY)).mockResolvedValueOnce(routing(CURRENT));
	vi.mocked(upgradeBroker).mockResolvedValue("upgraded");
	const session = await startSession();

	await session.status();

	assert.equal(vi.mocked(upgradeBroker).mock.calls.length, 1);
	assert.equal(vi.mocked(queryBrokerRouting).mock.calls.length, 2);
	assert.equal(vi.mocked(spawnBrokerIfNeeded).mock.calls.length, 2);
	assert.deepEqual(connects, [{ acrossMachines: false, verify: true }]);
	assert.deepEqual(session.notices, []);
});

test("a session finding a broker of this version or a newer one never replaces it (#4538)", async () => {
	for (const protocol of [CURRENT, { min: 1, max: 3 }]) {
		vi.mocked(queryBrokerRouting).mockResolvedValueOnce(routing(protocol));
		const session = await startSession();
		await session.status();
	}
	assert.equal(vi.mocked(upgradeBroker).mock.calls.length, 0);
	assert.deepEqual(connects, [
		{ acrossMachines: false, verify: true },
		{ acrossMachines: false, verify: true },
	]);
});

test("a failed replacement leaves the session on the older broker, on this machine only, warned once (#4538)", async () => {
	const failure = new IntercomBrokerUpgradeError({ phase: "stop", previousPid: 7, previousProtocolMax: 1 });
	vi.mocked(queryBrokerRouting).mockResolvedValue(routing(LEGACY));
	vi.mocked(upgradeBroker).mockRejectedValue(failure);
	const session = await startSession();

	await session.status();

	assert.deepEqual(connects, [{ acrossMachines: false, verify: false }]);
	assert.equal(session.notices.length, 1);
	assert.ok(session.notices[0]?.includes(`Replacing it failed: ${failure.message}`), session.notices[0]);
});

test("a broker sharing no protocol version is not replaced, and the session uses it on this machine only (#4538)", async () => {
	vi.mocked(queryBrokerRouting).mockResolvedValue(routing({ min: 3, max: 4 }));
	const session = await startSession();

	await session.status();

	assert.equal(vi.mocked(upgradeBroker).mock.calls.length, 0);
	assert.deepEqual(connects, [{ acrossMachines: false, verify: false }]);
	assert.equal(session.notices.length, 1);
	assert.doesNotMatch(session.notices[0] ?? "", /Replacing it failed/);
});

test("an unexpected failure while replacing the broker fails the connection instead of falling back (#4538)", async () => {
	vi.mocked(queryBrokerRouting).mockResolvedValue(routing(LEGACY));
	vi.mocked(upgradeBroker).mockRejectedValue(new Error("spawn lock unreadable"));
	const session = await startSession();

	const result = await session.status();

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /spawn lock unreadable/);
	assert.deepEqual(connects, []);
	assert.deepEqual(session.notices, []);
});
