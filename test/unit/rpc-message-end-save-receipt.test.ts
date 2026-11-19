import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { RpcSessionBinding } from "../../packages/coding-agent/src/modes/rpc/rpc-session-binding.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";

test("an RPC message_end carries the saved entry ID and sequence of the message it ends (#5593)", async () => {
	const harness = await createHarness();
	harness.setResponses([fauxAssistantMessage("hello")]);
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
			throw new Error("unused runtime factory");
		},
	);
	const output: Record<string, unknown>[] = [];
	const binding = new RpcSessionBinding({
		runtimeHost: runtime,
		output: (record) => output.push(JSON.parse(JSON.stringify(record)) as Record<string, unknown>),
		pendingExtensionRequests: new Map(),
		customUi: new EngineCustomUiService(() => {}, new KeybindingsManager()),
		requestShutdown: () => {},
	});
	try {
		await binding.rebindSession();
		await harness.session.prompt("respond");
		const ends = output.filter((record) => record.type === "message_end");
		const manager = harness.sessionManager;
		const saved = manager.getEntries().filter((entry) => entry.type === "message");
		assert.deepEqual(
			ends.map((end) => [(end.message as { role: string }).role, end.entryId, end.seq]),
			saved.map((entry) => [entry.message.role, entry.id, manager.getEntrySeq(entry.id)]),
		);
		for (const record of output.filter((event) => event.type !== "message_end")) {
			assert.equal(Object.hasOwn(record, "seq"), false, `${String(record.type)} carries no save receipt`);
		}
	} finally {
		binding.disposeSubscriptions();
		await harness.cleanup();
	}
});
