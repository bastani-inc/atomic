import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.js";
import { createHarness } from "./suite/harness.js";

// #2873: runtime replacement and the RPC command both request a rebind after resume.
test("RPC rebind starts a session once and can reattach after disposal", async () => {
	const harness = await createHarness();
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused factory");
		},
	);
	const binding = new RpcSessionBinding({
		runtimeHost: runtime,
		output: () => {},
		pendingExtensionRequests: new Map(),
		requestShutdown: () => {},
	});
	const bind = vi.spyOn(harness.session, "bindExtensions");
	try {
		await binding.rebindSession();
		await binding.rebindSession();
		assert.equal(bind.mock.calls.length, 1);
		binding.disposeSubscriptions();
		await binding.rebindSession();
		assert.equal(bind.mock.calls.length, 2);
	} finally {
		binding.disposeSubscriptions();
		harness.cleanup();
	}
});

// #4711: RPC admits commands before the startup bind settles, so `new_session` can retire the
// session whose extensions are still starting. That bind must yield to the replacement, not
// reject with SessionClosed and take the process down.
test("RPC startup bind yields to a session replacement that retires its session mid-start", async () => {
	const discovering = Promise.withResolvers<void>();
	const releaseDiscover = Promise.withResolvers<void>();
	const first = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("resources_discover", async () => {
					discovering.resolve();
					await releaseDiscover.promise;
					return {};
				});
			},
		],
	});
	const second = await createHarness();
	const runtime = new AgentSessionRuntime(
		first.session,
		{ cwd: first.tempDir, agentDir: first.tempDir } as never,
		async () =>
			({
				session: second.session,
				services: {
					cwd: second.tempDir,
					agentDir: second.tempDir,
					settingsManager: second.settingsManager,
					modelRuntime: second.session.modelRuntime,
					resourceLoader: second.session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			}) as never,
	);
	const binding = new RpcSessionBinding({
		runtimeHost: runtime,
		output: () => {},
		pendingExtensionRequests: new Map(),
		requestShutdown: () => {},
	});
	runtime.setRebindSession(() => binding.rebindSession());
	try {
		const startupBind = binding.rebindSession();
		await discovering.promise;
		const replacement = runtime.newSession();
		// The replacement retires the starting session before its discovery resumes.
		await vi.waitFor(() => assert.equal(first.session._disposed, true));
		releaseDiscover.resolve();

		assert.deepEqual(await replacement, { cancelled: false });
		await startupBind;
		assert.equal(binding.currentSession, second.session);
	} finally {
		releaseDiscover.resolve();
		binding.disposeSubscriptions();
		second.cleanup();
		first.cleanup();
	}
});

// #4711: closing stdin during startup shuts the runtime down while the startup bind is pending.
test("RPC startup bind settles quietly when shutdown closes its session mid-start", async () => {
	const discovering = Promise.withResolvers<void>();
	const releaseDiscover = Promise.withResolvers<void>();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("resources_discover", async () => {
					discovering.resolve();
					await releaseDiscover.promise;
					return {};
				});
			},
		],
	});
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused factory");
		},
	);
	const binding = new RpcSessionBinding({
		runtimeHost: runtime,
		output: () => {},
		pendingExtensionRequests: new Map(),
		requestShutdown: () => {},
	});
	try {
		const startupBind = binding.rebindSession();
		await discovering.promise;
		const shutdown = runtime.dispose();
		await vi.waitFor(() => assert.equal(harness.session._disposed, true));
		releaseDiscover.resolve();

		await startupBind;
		await shutdown;
	} finally {
		releaseDiscover.resolve();
		binding.disposeSubscriptions();
		harness.cleanup();
	}
});
