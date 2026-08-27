import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { RpcClientApi, type RpcCommandBody } from "../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import type { RpcEvent, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

const unusedCreateRuntime = (async () => {
	throw new Error("unused runtime factory");
}) as CreateAgentSessionRuntimeFactory;

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
	};
}

function persistHandler(harness: Harness) {
	const runtimeHost = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, unusedCreateRuntime);
	return createRpcCommandHandler({
		runtimeHost,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: () => {},
	});
}

function assertRpcSuccess(
	response: RpcResponse | undefined,
	label: string,
): asserts response is RpcResponse & { success: true } {
	if (!response?.success) {
		throw new Error(response && "error" in response ? response.error : `${label} failed`);
	}
}

class RecordingRpcClient extends RpcClientApi {
	readonly commands: RpcCommandBody[] = [];

	protected async request(command: RpcCommandBody): Promise<RpcResponse> {
		this.commands.push(command);
		if (command.type === "set_model") {
			return {
				type: "response",
				command: "set_model",
				success: true,
				data: { provider: command.provider, id: command.modelId },
			} as RpcResponse;
		}
		if (command.type === "cycle_model") {
			return { type: "response", command: "cycle_model", success: true, data: null };
		}
		if (command.type === "set_thinking_level") {
			return { type: "response", command: "set_thinking_level", success: true, data: { level: command.level } };
		}
		throw new Error(`unexpected command ${command.type}`);
	}

	protected data<T>(response: RpcResponse): T {
		if (!response.success) throw new Error(response.error);
		return "data" in response ? (response.data as T) : (undefined as T);
	}
}

function engineBridgeClient(handle: ReturnType<typeof createRpcCommandHandler>) {
	return {
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		getCommands: async () => [],
		async getState() {
			const response = await handle({ id: "get-state", type: "get_state" });
			assertRpcSuccess(response, "get_state");
			return response.data;
		},
		async requestInternal(command: { type: string }) {
			const response = await handle({ id: command.type, type: command.type } as Parameters<typeof handle>[0]);
			assertRpcSuccess(response, command.type);
			return "data" in response ? response.data : undefined;
		},
		async setModel(provider: string, modelId: string, options?: { persist?: boolean }) {
			const response = await handle({
				id: "set-model",
				type: "set_model",
				provider,
				modelId,
				...(options?.persist === true ? { persist: true } : {}),
			});
			assertRpcSuccess(response, "set_model");
			return response.data;
		},
		async cycleModel(direction?: "forward" | "backward", options?: { persist?: boolean }) {
			const response = await handle({
				id: "cycle-model",
				type: "cycle_model",
				direction,
				...(options?.persist === true ? { persist: true } : {}),
			});
			assertRpcSuccess(response, "cycle_model");
			return response.data;
		},
		async setThinkingLevel(
			level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
			options?: { persist?: boolean },
		) {
			const response = await handle({
				id: "set-thinking",
				type: "set_thinking_level",
				level,
				...(options?.persist === true ? { persist: true } : {}),
			});
			assertRpcSuccess(response, "set_thinking_level");
			return response.data;
		},
	} as unknown as RpcClient;
}

describe("RPC persist boundary", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function twoModelHarness(options: HarnessOptions = {}) {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			...options,
		});
		harnesses.push(harness);
		harness.settingsManager.setDefaultModelAndProvider(harness.getModel().provider, harness.getModel().id);
		return harness;
	}

	async function isolatedPair(options: HarnessOptions = {}) {
		const engine = await twoModelHarness(options);
		const host = await twoModelHarness(options);
		const handle = persistHandler(engine);
		const localRuntime = new AgentSessionRuntime(host.session, servicesFor(host) as never, unusedCreateRuntime);
		const runtime = new IsolatedInteractiveRuntime(localRuntime, unusedCreateRuntime, engineBridgeClient(handle));
		await runtime.initializeFromEngine();
		return { engine, host, runtime };
	}

	it("persists defaultProvider/defaultModel when set_model includes persist", async () => {
		const harness = await twoModelHarness();
		const next = harness.getModel("faux-2");
		if (!next) throw new Error("missing faux-2");
		const handle = persistHandler(harness);

		const response = await handle({
			id: "persist",
			type: "set_model",
			provider: next.provider,
			modelId: next.id,
			persist: true,
		});

		assert.partialDeepStrictEqual(response, { id: "persist", command: "set_model", success: true });
		assert.equal(harness.session.model?.id, "faux-2");
		assert.equal(harness.settingsManager.getDefaultProvider(), next.provider);
		assert.equal(harness.settingsManager.getDefaultModel(), "faux-2");
	});

	it("keeps session-only set_model out of settings.json defaults", async () => {
		const harness = await twoModelHarness();
		const next = harness.getModel("faux-2");
		if (!next) throw new Error("missing faux-2");
		const handle = persistHandler(harness);

		const response = await handle({
			id: "session-only",
			type: "set_model",
			provider: next.provider,
			modelId: next.id,
		});

		assert.partialDeepStrictEqual(response, { id: "session-only", command: "set_model", success: true });
		assert.equal(harness.session.model?.id, "faux-2");
		assert.equal(harness.settingsManager.getDefaultModel(), "faux-1");
	});

	it("persists a thinking default when set_thinking_level includes persist", async () => {
		const harness = await twoModelHarness();
		const current = harness.getModel();
		const handle = persistHandler(harness);

		const response = await handle({
			id: "persist-thinking",
			type: "set_thinking_level",
			level: "high",
			persist: true,
		});

		assert.partialDeepStrictEqual(response, {
			id: "persist-thinking",
			command: "set_thinking_level",
			success: true,
			data: { level: "high", provider: current.provider, modelId: current.id },
		});
		assert.equal(harness.session.thinkingLevel, "high");
		assert.equal(harness.settingsManager.getModelThinkingLevel(current.provider, current.id), "high");
	});

	it("keeps session-only set_thinking_level out of saved thinking defaults", async () => {
		const harness = await twoModelHarness();
		const current = harness.getModel();
		const handle = persistHandler(harness);

		const response = await handle({
			id: "session-thinking",
			type: "set_thinking_level",
			level: "low",
		});

		assert.partialDeepStrictEqual(response, { id: "session-thinking", command: "set_thinking_level", success: true });
		assert.equal(harness.session.thinkingLevel, "low");
		assert.equal(harness.settingsManager.getModelThinkingLevel(current.provider, current.id), undefined);
	});

	it("returns and persists the clamped thinking level from set_thinking_level", async () => {
		const harness = await twoModelHarness({
			models: [{ id: "faux-1", name: "One", reasoning: false }],
		});
		const current = harness.getModel();
		const handle = persistHandler(harness);

		const response = await handle({
			id: "clamp-thinking",
			type: "set_thinking_level",
			level: "high",
			persist: true,
		});

		assert.partialDeepStrictEqual(response, {
			id: "clamp-thinking",
			command: "set_thinking_level",
			success: true,
			data: { level: "off", provider: current.provider, modelId: current.id },
		});
		assert.equal(harness.session.thinkingLevel, "off");
		assert.equal(harness.settingsManager.getModelThinkingLevel(current.provider, current.id), "off");
	});

	it("persists defaultProvider/defaultModel when cycle_model includes persist", async () => {
		const harness = await twoModelHarness();
		const handle = persistHandler(harness);

		const response = await handle({ id: "cycle-persist", type: "cycle_model", persist: true });

		assert.partialDeepStrictEqual(response, {
			id: "cycle-persist",
			command: "cycle_model",
			success: true,
			data: { model: { id: "faux-2" } },
		});
		assert.equal(harness.settingsManager.getDefaultModel(), "faux-2");
	});

	it("puts persist on the set_model / cycle_model / set_thinking_level wire when requested", async () => {
		const client = new RecordingRpcClient();

		await client.setModel("anthropic", "claude-sonnet-4-5", { persist: true });
		await client.setModel("anthropic", "claude-opus-4-8");
		await client.cycleModel("forward", { persist: true });
		await client.cycleModel("backward");
		await client.setThinkingLevel("high", { persist: true });
		await client.setThinkingLevel("low");

		assert.deepEqual(client.commands, [
			{ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5", persist: true },
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
			{ type: "cycle_model", direction: "forward", persist: true },
			{ type: "cycle_model", direction: "backward" },
			{ type: "set_thinking_level", level: "high", persist: true },
			{ type: "set_thinking_level", level: "low" },
		]);
	});

	it("saves settings defaults when the isolated engine proxy setModel persist flag reaches the handler", async () => {
		const { engine, host, runtime } = await isolatedPair();
		const next = engine.getModel("faux-2");
		if (!next) throw new Error("missing faux-2");

		await runtime.session.setModel(next, { persist: true });

		assert.equal(engine.session.model?.id, "faux-2");
		assert.equal(engine.settingsManager.getDefaultProvider(), next.provider);
		assert.equal(engine.settingsManager.getDefaultModel(), "faux-2");
		assert.equal(host.settingsManager.getDefaultProvider(), next.provider);
		assert.equal(host.settingsManager.getDefaultModel(), "faux-2");
	});

	it("does not save settings defaults when the isolated engine proxy setModel omits persist", async () => {
		const { engine, host, runtime } = await isolatedPair();
		const next = engine.getModel("faux-2");
		if (!next) throw new Error("missing faux-2");

		await runtime.session.setModel(next);

		assert.equal(engine.session.model?.id, "faux-2");
		assert.equal(engine.settingsManager.getDefaultModel(), "faux-1");
		assert.equal(host.settingsManager.getDefaultModel(), "faux-1");
	});

	it("adds a persisted default to the remote scoped catalog after engine ACK", async () => {
		const { engine, host, runtime } = await isolatedPair();
		const current = engine.getModel("faux-1");
		const next = engine.getModel("faux-2");
		if (!current || !next) throw new Error("missing faux models");
		const currentRef = `${current.provider}/${current.id}`;
		engine.session.setScopedModels([{ model: current }]);
		engine.settingsManager.setEnabledModels([currentRef]);
		host.settingsManager.setEnabledModels([currentRef]);
		await runtime.initializeFromEngine();

		await runtime.session.setModel(next, { persist: true });

		assert.equal(host.settingsManager.getDefaultModel(), "faux-2");
		assert.deepEqual(host.settingsManager.getEnabledModels(), [currentRef, `${next.provider}/${next.id}`]);
		assert.deepEqual(
			runtime.session.scopedModels.map((scoped) => scoped.model.id),
			["faux-1", "faux-2"],
		);
	});

	it("does not rewrite wildcard or thinking-qualified enabledModels after persist", async () => {
		const { engine, host, runtime } = await isolatedPair();
		const current = engine.getModel("faux-1");
		const next = engine.getModel("faux-2");
		if (!current || !next) throw new Error("missing faux models");
		const patterns = [`${next.provider}/*`, `${next.provider}/${next.id}:high`];
		for (const pattern of patterns) {
			engine.session.setScopedModels([{ model: current }, { model: next }]);
			engine.settingsManager.setEnabledModels([pattern]);
			host.settingsManager.setEnabledModels([pattern]);
			await runtime.initializeFromEngine();
			await runtime.session.setModel(next, { persist: true });
			assert.deepEqual(engine.settingsManager.getEnabledModels(), [pattern]);
			assert.deepEqual(host.settingsManager.getEnabledModels(), [pattern]);
		}
	});

	it("saves a thinking default when the isolated engine proxy setThinkingLevel persist flag reaches the handler", async () => {
		const { engine, host, runtime } = await isolatedPair();
		const model = runtime.session.model;
		if (!model) throw new Error("missing runtime model");

		runtime.session.setThinkingLevel("high", { persist: true });

		await vi.waitFor(() => {
			assert.equal(engine.settingsManager.getModelThinkingLevel(model.provider, model.id), "high");
			assert.equal(host.settingsManager.getModelThinkingLevel(model.provider, model.id), "high");
		});
		assert.equal(engine.session.thinkingLevel, "high");
		assert.equal(runtime.session.thinkingLevel, "high");
	});

	it("persists the engine's clamped thinking level on the host after ACK", async () => {
		const { engine, host, runtime } = await isolatedPair({
			models: [{ id: "faux-1", name: "One", reasoning: false }],
		});
		const model = runtime.session.model;
		if (!model) throw new Error("missing runtime model");

		runtime.session.setThinkingLevel("high", { persist: true });

		await vi.waitFor(() => {
			assert.equal(engine.session.thinkingLevel, "off");
			assert.equal(runtime.session.thinkingLevel, "off");
			assert.equal(engine.settingsManager.getModelThinkingLevel(model.provider, model.id), "off");
			assert.equal(host.settingsManager.getModelThinkingLevel(model.provider, model.id), "off");
		});
	});

	it("keeps a persisted thinking default on the engine model when model_changed arrives before ACK", async () => {
		const host = await twoModelHarness();
		const current = host.getModel("faux-1");
		const next = host.getModel("faux-2");
		if (!current || !next) throw new Error("missing faux models");

		let emit: ((event: RpcEvent) => void) | undefined;
		let releaseAck!: (value: { level: "high"; provider: string; modelId: string }) => void;
		const ack = new Promise<{ level: "high"; provider: string; modelId: string }>((resolve) => {
			releaseAck = resolve;
		});
		const client = {
			onEvent(listener: (event: RpcEvent) => void) {
				emit = listener;
				return () => {};
			},
			onGenerationEnded: () => () => {},
			setThinkingLevel: () => ack,
		} as unknown as RpcClient;
		const localRuntime = new AgentSessionRuntime(host.session, servicesFor(host) as never, unusedCreateRuntime);
		const runtime = new IsolatedInteractiveRuntime(localRuntime, unusedCreateRuntime, client);

		runtime.session.setThinkingLevel("high", { persist: true });
		emit?.({
			type: "model_changed",
			model: next,
			previousModel: current,
			source: "set",
		} as RpcEvent);
		releaseAck({ level: "high", provider: current.provider, modelId: current.id });

		await vi.waitFor(() => {
			assert.equal(host.settingsManager.getModelThinkingLevel(current.provider, current.id), "high");
		});
		assert.equal(host.settingsManager.getModelThinkingLevel(next.provider, next.id), undefined);
		assert.equal(runtime.session.model?.id, "faux-2");
	});

	it("forwards cycleModel persist through the isolated engine proxy to settings defaults", async () => {
		const { engine, host, runtime } = await isolatedPair();

		const result = await runtime.session.cycleModel("forward", { persist: true });

		assert.equal(result?.model.id, "faux-2");
		assert.equal(engine.session.model?.id, "faux-2");
		assert.equal(engine.settingsManager.getDefaultModel(), "faux-2");
		assert.equal(host.settingsManager.getDefaultModel(), "faux-2");
	});
});
