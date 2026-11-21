/**
 * A reload the host rejects leaves the session alive with a new lifetime and its Intercom runtime in place: that runtime
 * still connects afterwards, although the reload's start ended the lifetime its broker starts followed.
 */
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@bastani/atomic";
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

test("a session whose reload the host rejected still connects to Intercom when its broker is gone", async () => {
	const startSignals: AbortSignal[] = [];
	// As the real start does first: an aborted start fails before it looks for a broker.
	vi.mocked(spawnBrokerIfNeeded).mockImplementation(async (_command, _args, _timeoutMs, _extensionDir, signal) => {
		if (signal) startSignals.push(signal);
		signal?.throwIfAborted();
	});
	let registered = 0;
	let lostAt = 0;
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (this: IntercomClient) {
		registered += 1;
		Object.assign(this, { _sessionId: `intercom-${registered}` });
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => registered > lostAt);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);

	const lifecycle: string[] = [];
	const recorder = (pi: ExtensionAPI) => {
		pi.on("session_start", (event) => {
			lifecycle.push(`start:${(event as { reason?: string }).reason}`);
		});
		pi.on("session_shutdown", (event) => {
			lifecycle.push(`shutdown:${(event as { reason?: string }).reason}`);
		});
	};
	const loader = createTestResourceLoader({
		extensionsResult: await createTestExtensionsResult([intercom, recorder]),
	});
	loader.prepareReload = async () => {
		throw new Error("candidate rejected");
	};
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindExtensions({});
		const ctx = harness.session.extensionRunner.createContext();
		const tool = harness.session.extensionRunner.getToolDefinition("intercom");
		assert.ok(tool, "the intercom tool is registered");
		// The session uses Intercom once, so its runtime is loaded and connected before the reload.
		await tool.execute(
			"tool-call-0",
			{ action: "list" } as never,
			new AbortController().signal,
			undefined,
			toolContext(harness.session.extensionRunner.createContext()),
		);
		assert.equal(registered, 1, "the session connects before the reload");
		await assert.rejects(harness.session.reload(), /candidate rejected/);
		assert.equal(ctx.getCurrentSessionSignal?.().aborted, false, "the rejected reload left the session alive");
		// Later its broker goes away (a restart, an idle retirement): the next use connects again.
		lostAt = registered;
		const result = await tool.execute(
			"tool-call",
			{ action: "list" } as never,
			new AbortController().signal,
			undefined,
			toolContext(harness.session.extensionRunner.createContext()),
		);
		const text = JSON.stringify(result.content);
		assert.deepEqual(
			lifecycle,
			["start:startup"],
			"the rejected reload neither shut the session down nor started it",
		);
		assert.equal(registered, 2, `the session could not connect after the rejected reload: ${text.slice(0, 300)}`);
		assert.equal(startSignals.at(-1)?.aborted, false, "its broker start follows the session's new lifetime");
	} finally {
		await harness.session.dispose();
		await harness.cleanup();
	}
});
