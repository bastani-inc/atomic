import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { RpcClientApi, type RpcCommandBody } from "../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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
			return { type: "response", command: "set_thinking_level", success: true };
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
		},
	} as unknown as RpcClient;
}

describe("RPC persist boundary", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function twoModelHarness() {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		harness.settingsManager.setDefaultModelAndProvider(harness.getModel().provider, "faux-1");
		return harness;
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

		expect(response).toMatchObject({ id: "persist", command: "set_model", success: true });
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultProvider()).toBe(next.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");
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

		expect(response).toMatchObject({ id: "session-only", command: "set_model", success: true });
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-1");
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

		expect(response).toMatchObject({ id: "persist-thinking", command: "set_thinking_level", success: true });
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getModelThinkingLevel(current.provider, current.id)).toBe("high");
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

		expect(response).toMatchObject({ id: "session-thinking", command: "set_thinking_level", success: true });
		expect(harness.session.thinkingLevel).toBe("low");
		expect(harness.settingsManager.getModelThinkingLevel(current.provider, current.id)).toBeUndefined();
	});

	it("persists defaultProvider/defaultModel when cycle_model includes persist", async () => {
		const harness = await twoModelHarness();
		const handle = persistHandler(harness);

		const response = await handle({ id: "cycle-persist", type: "cycle_model", persist: true });

		expect(response).toMatchObject({
			id: "cycle-persist",
			command: "cycle_model",
			success: true,
			data: { model: { id: "faux-2" } },
		});
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");
	});

	it("puts persist on the set_model / cycle_model / set_thinking_level wire when requested", async () => {
		const client = new RecordingRpcClient();

		await client.setModel("anthropic", "claude-sonnet-4-5", { persist: true });
		await client.setModel("anthropic", "claude-opus-4-8");
		await client.cycleModel("forward", { persist: true });
		await client.cycleModel("backward");
		await client.setThinkingLevel("high", { persist: true });
		await client.setThinkingLevel("low");

		expect(client.commands).toEqual([
			{ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5", persist: true },
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
			{ type: "cycle_model", direction: "forward", persist: true },
			{ type: "cycle_model", direction: "backward" },
			{ type: "set_thinking_level", level: "high", persist: true },
			{ type: "set_thinking_level", level: "low" },
		]);
	});

	async function isolatedPair() {
		const engine = await twoModelHarness();
		const host = await twoModelHarness();
		const handle = persistHandler(engine);
		const localRuntime = new AgentSessionRuntime(host.session, servicesFor(host) as never, unusedCreateRuntime);
		const runtime = new IsolatedInteractiveRuntime(localRuntime, unusedCreateRuntime, engineBridgeClient(handle));
		return { engine, host, runtime };
	}

	it("saves settings defaults when the isolated engine proxy setModel persist flag reaches the handler", async () => {
		const { engine, host, runtime } = await isolatedPair();
		const next = engine.getModel("faux-2");
		if (!next) throw new Error("missing faux-2");

		await runtime.session.setModel(next, { persist: true });

		expect(engine.session.model?.id).toBe("faux-2");
		expect(engine.settingsManager.getDefaultProvider()).toBe(next.provider);
		expect(engine.settingsManager.getDefaultModel()).toBe("faux-2");
		expect(host.settingsManager.getDefaultModel()).toBe("faux-1");
	});

	it("does not save settings defaults when the isolated engine proxy setModel omits persist", async () => {
		const { engine, runtime } = await isolatedPair();
		const next = engine.getModel("faux-2");
		if (!next) throw new Error("missing faux-2");

		await runtime.session.setModel(next);

		expect(engine.session.model?.id).toBe("faux-2");
		expect(engine.settingsManager.getDefaultModel()).toBe("faux-1");
	});

	it("saves a thinking default when the isolated engine proxy setThinkingLevel persist flag reaches the handler", async () => {
		const { engine, runtime } = await isolatedPair();
		const current = engine.getModel();

		runtime.session.setThinkingLevel("high", { persist: true });

		await vi.waitFor(() => {
			expect(engine.settingsManager.getModelThinkingLevel(current.provider, current.id)).toBe("high");
		});
		expect(engine.session.thinkingLevel).toBe("high");
	});

	it("forwards cycleModel persist through the isolated engine proxy to settings defaults", async () => {
		const { engine, runtime } = await isolatedPair();

		const result = await runtime.session.cycleModel("forward", { persist: true });

		expect(result?.model.id).toBe("faux-2");
		expect(engine.session.model?.id).toBe("faux-2");
		expect(engine.settingsManager.getDefaultModel()).toBe("faux-2");
	});
});
