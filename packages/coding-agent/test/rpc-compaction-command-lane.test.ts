import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import { createRpcInputLineHandler } from "../src/modes/rpc/rpc-input.js";
import { createRpcInputScheduler } from "../src/modes/rpc/rpc-input-scheduler.js";
import type { RpcOutputRecord } from "../src/modes/rpc/rpc-responses.js";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.js";
import { sleep, waitFor } from "./helpers/busy-submission-rig.js";
import { createHarness, type Harness } from "./suite/harness.js";

type CompactionInternals = {
	_applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined>;
};

const harnesses: Harness[] = [];
const heldCompactions: Array<() => void> = [];

afterEach(async () => {
	for (const release of heldCompactions.splice(0)) release();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function createEngine(invocations: string[]): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("workflow", {
					description: "Manage workflow runs",
					handler: async (args) => {
						invocations.push(args);
					},
				});
			},
		],
	});
	harnesses.push(harness);
	const release = Promise.withResolvers<undefined>();
	vi.spyOn(harness.session as unknown as CompactionInternals, "_applyVerbatimCompaction").mockImplementation(
		() => release.promise,
	);
	heldCompactions.push(() => release.resolve(undefined));
	return harness;
}

function connectInput(harness: Harness, detachCompaction: boolean, beginCommand?: () => () => void) {
	const records: RpcOutputRecord[] = [];
	const output = (record: RpcOutputRecord) => {
		records.push(record);
	};
	const handleCommand = createRpcCommandHandler({
		runtimeHost: { session: harness.session, services: { agentDir: harness.tempDir } } as AgentSessionRuntime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output,
		keybindings: KeybindingsManager.create(harness.tempDir),
		taskInspectorUi: { custom: async () => undefined as never },
		detachCompaction,
		beginCommand,
	});
	const dispatch = createRpcInputScheduler(
		createRpcInputLineHandler({
			output,
			pendingExtensionRequests: new Map(),
			handleCommand,
			checkShutdownRequested: async () => {},
		}),
	);
	return {
		send: (command: { id: string; type: string; message?: string }) => dispatch(JSON.stringify(command)),
		response: (id: string) =>
			records.find(
				(record): record is RpcResponse => "type" in record && record.type === "response" && record.id === id,
			),
		responseOrder: () =>
			records.flatMap((record) => ("type" in record && record.type === "response" && record.id ? [record.id] : [])),
	};
}

function releaseCompaction(): void {
	for (const release of heldCompactions.splice(0)) release();
}

describe("interactive engine command lane during a manual compaction", () => {
	test("answers /tasks, /model and extension commands before the compaction finishes (#4251)", async () => {
		const invocations: string[] = [];
		const engine = await createEngine(invocations);
		const input = connectInput(engine, true);

		input.send({ id: "compact", type: "compact" });
		await waitFor("the engine to start compacting", () => engine.session.isCompacting);
		input.send({ id: "tasks", type: "open_task_inspector" });
		input.send({ id: "models", type: "get_available_models" });
		input.send({ id: "connect", type: "prompt", message: "/workflow connect" });
		input.send({ id: "catalog", type: "get_commands" });

		await waitFor("commands sent during compaction to be answered", () =>
			["tasks", "models", "connect", "catalog"].every((id) => input.response(id) !== undefined),
		);
		assert.equal(engine.session.isCompacting, true, "compaction must still be running");
		assert.equal(input.response("compact"), undefined);
		assert.deepEqual(invocations, ["connect"]);
		for (const id of ["tasks", "models", "connect", "catalog"]) {
			assert.equal(input.response(id)?.success, true, id);
		}
		assert.deepEqual(input.response("connect"), {
			id: "connect",
			type: "response",
			command: "prompt",
			success: true,
			data: { disposition: "handled" },
		});

		releaseCompaction();
		await waitFor("the compact response", () => input.response("compact") !== undefined);
		assert.deepEqual(input.response("compact"), {
			id: "compact",
			type: "response",
			command: "compact",
			success: false,
			error: "Nothing to compact (session too small)",
		});
	});

	test("plain RPC keeps later commands behind a pending compact (#4251)", async () => {
		const engine = await createEngine([]);
		const input = connectInput(engine, false);

		input.send({ id: "compact", type: "compact" });
		await waitFor("the engine to start compacting", () => engine.session.isCompacting);
		input.send({ id: "state", type: "get_state" });
		await sleep(50);
		assert.equal(input.response("state"), undefined);

		releaseCompaction();
		await waitFor("both responses", () => input.response("state") !== undefined);
		assert.deepEqual(input.responseOrder(), ["compact", "state"]);
	});
});

test("detached compaction releases shutdown only after its response is written", async () => {
	const engine = await createEngine([]);
	let active = 0;
	let requested = false;
	let responseAtShutdown: RpcResponse | undefined;
	const input = connectInput(engine, true, () => {
		active++;
		return () => {
			active--;
			if (requested && active === 0) responseAtShutdown = input.response("compact");
		};
	});
	input.send({ id: "compact", type: "compact" });
	await waitFor("compaction to start", () => engine.session.isCompacting);
	requested = true;
	assert.equal(active, 1, "detached compaction must keep shutdown pending");
	assert.equal(responseAtShutdown, undefined);
	releaseCompaction();
	await waitFor("shutdown after compact response", () => responseAtShutdown !== undefined);
	assert.equal(active, 0);
	assert.equal(responseAtShutdown?.command, "compact");
});
