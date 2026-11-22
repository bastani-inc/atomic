import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClientApi, type RpcCommandBody } from "../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { assertRpcSuccess } from "../src/modes/rpc/rpc-error-decoding.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const pairs: EngineHostPair[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
	while (pairs.length > 0) await pairs.pop()?.cleanup();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

class QuietRpcClient extends RpcClientApi {
	private nextId = 0;

	constructor(private readonly handle: ReturnType<typeof createRpcCommandHandler>) {
		super();
	}

	protected async request(command: RpcCommandBody): Promise<RpcResponse> {
		const id = `quiet-${++this.nextId}`;
		const answer = await this.handle({ ...command, id } as RpcCommand);
		assert.ok(answer);
		return answer;
	}

	protected data<T>(response: RpcResponse): T {
		assertRpcSuccess(response);
		return (response as Extract<RpcResponse, { success: true; data: unknown }>).data as T;
	}

	async requestInternal<T>(command: RpcCommandBody): Promise<T> {
		return this.data<T>(await this.request(command));
	}

	onEvent() {
		return () => {};
	}

	onGenerationEnded() {
		return () => {};
	}

	getGeneration() {
		return 1;
	}
}

test("persisted model selection mirrors the saved default model and scope when model_select transiently switches models (#5237)", async () => {
	let switchBack: () => Promise<void> = async () => {};
	const provider = "isolated-ack-saved-model";
	const pair = await createEngineHostPair({
		provider,
		models: [
			{ id: "current", reasoning: true },
			{ id: "chosen", reasoning: true },
		],
		engineExtensions: [
			(atomic) => {
				atomic.on("model_select", async (event) => {
					if (event.model.id === "chosen") await switchBack();
				});
			},
		],
	});
	pairs.push(pair);

	const current = pair.engine.getModel("current")!;
	const chosen = pair.engine.getModel("chosen")!;
	switchBack = () => pair.engine.session.setModel(current);

	pair.engine.settingsManager.setEnabledModels([`${provider}/current`]);
	pair.hostHarness.settingsManager.setEnabledModels([`${provider}/current`]);
	pair.engine.session.setScopedModels([{ model: current }]);
	pair.hostHarness.session.setScopedModels([{ model: current }]);

	await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.initializeFromEngine();
	await pair.drain();

	await pair.runtime.session.setModel(chosen, { persist: true, thinkingLevel: "high" });
	await pair.drain();

	assert.equal(pair.engine.session.model?.id, "current");
	assert.equal(pair.runtime.session.model?.id, "current");
	assert.equal(pair.engine.settingsManager.getGlobalSettings().defaultModel, "chosen");
	assert.equal(pair.hostHarness.settingsManager.getGlobalSettings().defaultModel, "chosen");
	assert.deepEqual(pair.engine.settingsManager.getGlobalSettings().enabledModels, [
		`${provider}/current`,
		`${provider}/chosen`,
	]);
	assert.deepEqual(pair.hostHarness.settingsManager.getGlobalSettings().enabledModels, [
		`${provider}/current`,
		`${provider}/chosen`,
	]);
});

test.each(["set", "cycle"] as const)(
	"a %s state acknowledgement does not overwrite a newer thinking_level_changed event delivered in the same read (#5237)",
	async (operation) => {
		const pair = await createEngineHostPair({
			models: [
				{ id: "current-model", reasoning: true },
				{ id: "other-model", reasoning: true },
			],
		});
		pairs.push(pair);

		await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
		await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
		await pair.engine.session.setThinkingLevel("medium");
		await pair.runtime.initializeFromEngine();
		await pair.drain();

		const other = pair.engine.getModel("other-model")!;
		const stateHeld = Promise.withResolvers<void>();
		pair.holdHostTrafficFrom((record) => {
			const matches = record.type === "response" && record.command === "get_state";
			if (matches) stateHeld.resolve();
			return matches;
		});

		const selection =
			operation === "set" ? pair.runtime.session.setModel(other) : pair.runtime.session.cycleModel("forward");
		try {
			await stateHeld.promise;
			await pair.engine.session.setThinkingLevel("high");
			await pair.drain();
		} finally {
			await pair.releaseHostTraffic();
			await selection;
		}
		await pair.drain();

		assert.equal(pair.engine.session.thinkingLevel, "high");
		assert.equal(pair.runtime.session.thinkingLevel, "high");
	},
);

test("isolated cycleModel applies the resulting thinking level from the state acknowledgement without event delivery (#5237)", async () => {
	const engine = await createHarness({
		provider: "isolated-ack-cycle",
		models: [
			{ id: "current", reasoning: true },
			{ id: "next", reasoning: true },
		],
	});
	const host = await createHarness();
	harnesses.push(engine, host);

	const unused = async () => {
		throw new Error("unused runtime factory");
	};
	const engineHost = new AgentSessionRuntime(
		engine.session,
		{ cwd: engine.tempDir, agentDir: engine.tempDir } as never,
		unused,
	);
	const handler = createRpcCommandHandler({
		runtimeHost: engineHost,
		getSession: () => engine.session,
		rebindSession: async () => {},
		output: () => {},
	});
	const local = new AgentSessionRuntime(host.session, { cwd: host.tempDir, agentDir: host.tempDir } as never, unused);
	const runtime = new IsolatedInteractiveRuntime(local, unused, new QuietRpcClient(handler) as never);

	await engine.session.setThinkingLevel("low");
	engine.session.setScopedModels([
		{ model: engine.getModel("current")!, thinkingLevel: "low" },
		{ model: engine.getModel("next")!, thinkingLevel: "high" },
	]);
	await runtime.initializeFromEngine();
	assert.equal(runtime.session.thinkingLevel, "low");

	const result = await runtime.session.cycleModel("forward");
	assert.equal(result?.model.id, "next");
	assert.equal(result?.thinkingLevel, "high");
	assert.equal(engine.session.thinkingLevel, "high");
	assert.equal(runtime.session.thinkingLevel, "high");
});
