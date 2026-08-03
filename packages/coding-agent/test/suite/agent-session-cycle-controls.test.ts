import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import { createRpcCommandHandler } from "../../src/modes/rpc/rpc-command-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

const warning =
	"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";
const createRuntime = (async () => {
	throw new Error("not used");
}) as CreateAgentSessionRuntimeFactory;

function lockedRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		createRuntime,
		[],
		warning,
		"configured-provider-unsupported",
	);
}

function cycleHandler(harness: Harness, runtime: AgentSessionRuntime) {
	return createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: () => {},
	});
}

function modelChanges(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "model_change")
		.map((entry) => `${entry.provider}/${entry.modelId}`);
}

describe("AgentSession cycle fallback controls", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("returns undefined without changing identity when zero authenticated models are available", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const previous = harness.session.model;

		const result = await harness.session.cycleModel();

		expect(result).toBeUndefined();
		expect(harness.session.model).toBe(previous);
		expect(modelChanges(harness)).toEqual([]);
	});

	it("returns undefined with one authenticated model even when the current model differs", async () => {
		const harness = await createHarness({ models: [{ id: "only-model", name: "Only" }] });
		harnesses.push(harness);
		const onlyModel = harness.getModel();
		const unknownCurrent = { ...onlyModel, id: "unknown-current", name: "Unknown Current" };
		harness.session.agent.state.model = unknownCurrent;

		const result = await harness.session.cycleModel();

		expect(result).toBeUndefined();
		expect(harness.session.model).toBe(unknownCurrent);
		expect(modelChanges(harness)).toEqual([]);
	});

	it("preserves the lock when duplicate scoped entries keep the same provider and id", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const current = harness.getModel();
		harness.session.setScopedModels([{ model: current }, { model: { ...current }, thinkingLevel: "high" }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		const runtime = lockedRuntime(harness);

		const response = await cycleHandler(harness, runtime)({ id: "same", type: "cycle_model" });

		expect(response).toMatchObject({ id: "same", command: "cycle_model", success: true });
		expect(harness.session.model?.provider).toBe(current.provider);
		expect(harness.session.model?.id).toBe(current.id);
		expect(runtime.modelFallbackMessage).toBe(warning);
		expect(runtime.modelFallbackReason).toBe("configured-provider-unsupported");
		expect(modelChanges(harness)).toEqual([`${current.provider}/${current.id}`]);
	});

	it("clears the lock after a real backward cycle changes and persists the model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const runtime = lockedRuntime(harness);

		const response = await cycleHandler(
			harness,
			runtime,
		)({
			id: "backward",
			type: "cycle_model",
			direction: "backward",
		});

		expect(response).toMatchObject({
			id: "backward",
			command: "cycle_model",
			success: true,
			data: { model: { provider: harness.getModel("faux-2")?.provider, id: "faux-2" } },
		});
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");
		expect(modelChanges(harness)).toEqual([`${harness.getModel().provider}/faux-2`]);
		expect(runtime.modelFallbackMessage).toBeUndefined();
		expect(runtime.modelFallbackReason).toBeUndefined();
	});

	it("reports a model_select hook error but completes the changed cycle and clears the lock", async () => {
		let hookCalls = 0;
		const extensionErrors: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						if (event.source !== "cycle") return;
						hookCalls += 1;
						throw new Error("cycle selection rejected");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			shutdownHandler: () => {},
			onError: (error) => extensionErrors.push(`${error.event}:${error.error}`),
		});
		const runtime = lockedRuntime(harness);

		// Generic extension hook errors are reported, not propagated as failed model operations.
		const response = await cycleHandler(harness, runtime)({ id: "hook-error", type: "cycle_model" });

		expect(response).toMatchObject({ id: "hook-error", command: "cycle_model", success: true });
		expect(hookCalls).toBe(1);
		expect(extensionErrors).toEqual(["model_select:cycle selection rejected"]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");
		expect(modelChanges(harness)).toEqual([`${harness.getModel().provider}/faux-2`]);
		expect(runtime.modelFallbackMessage).toBeUndefined();
		expect(runtime.modelFallbackReason).toBeUndefined();
	});
});
