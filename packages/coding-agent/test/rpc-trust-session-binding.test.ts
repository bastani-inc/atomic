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
