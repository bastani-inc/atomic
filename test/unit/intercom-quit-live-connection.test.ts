/**
 * A quit ends the session's lifetime before its shutdown handlers run, and that stops the broker starts Intercom waits
 * for. The session's live connection stays: an extension's shutdown handler that runs before Intercom's own still
 * uses it.
 */
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercom from "../../packages/intercom/index.js";
import { toolContext } from "../helpers/tool-context.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 4 } }),
}));
vi.mock("../../packages/intercom/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/intercom/config.js")>();
	return { ...actual, loadConfigAsync: async () => ({ ...actual.defaultConfig(), joinAtStartup: false }) };
});

const JOIN_ENV = "ATOMIC_INTERCOM_JOIN_AT_STARTUP";
const originalJoinEnv = process.env[JOIN_ENV];
beforeEach(() => {
	delete process.env[JOIN_ENV];
});
afterEach(() => {
	if (originalJoinEnv === undefined) delete process.env[JOIN_ENV];
	else process.env[JOIN_ENV] = originalJoinEnv;
	vi.restoreAllMocks();
});

test("a shutdown handler that runs before Intercom's own still reaches the broker while the session quits", async () => {
	// As the real start does first: an aborted start fails before it looks for a broker.
	vi.mocked(spawnBrokerIfNeeded).mockImplementation(async (_command, _args, _timeoutMs, _extensionDir, signal) => {
		signal?.throwIfAborted();
	});
	let registered = 0;
	let disconnected = 0;
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (this: IntercomClient) {
		registered += 1;
		Object.assign(this, { _sessionId: `intercom-${registered}` });
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => registered > disconnected);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockImplementation(async () => {
		disconnected = registered;
	});
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);

	let lifetimeEnded: boolean | undefined;
	let duringQuit: { isError?: boolean; content: unknown } | undefined;
	// Registered before Intercom, so its handler runs before Intercom's own.
	const earlier = (pi: ExtensionAPI) => {
		pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
			lifetimeEnded = ctx.getCurrentSessionSignal?.().aborted;
			const tool = harness.session.extensionRunner.getToolDefinition("intercom");
			assert.ok(tool, "the intercom tool is registered");
			duringQuit = await tool.execute(
				"tool-call-during-quit",
				{ action: "status" } as never,
				new AbortController().signal,
				undefined,
				toolContext(ctx),
			);
		});
	};
	const loader = createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([earlier, intercom]) });
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindExtensions({});
		const tool = harness.session.extensionRunner.getToolDefinition("intercom");
		assert.ok(tool, "the intercom tool is registered");
		await tool.execute(
			"tool-call-before-quit",
			{ action: "status" } as never,
			new AbortController().signal,
			undefined,
			toolContext(harness.session.extensionRunner.createContext()),
		);
		assert.equal(registered, 1, "the session connects before it quits");
	} finally {
		await harness.session.dispose();
		await harness.cleanup();
	}
	assert.equal(lifetimeEnded, true, "the handler runs once the session's lifetime has ended");
	assert.ok(duringQuit, "the handler used Intercom");
	assert.notEqual(
		duringQuit.isError,
		true,
		`a shutdown handler could not use Intercom: ${JSON.stringify(duringQuit.content)}`,
	);
});
