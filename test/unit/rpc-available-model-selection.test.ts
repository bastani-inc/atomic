import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

function model(name: string): Model<Api> {
	return {
		id: "same", name, provider: "ordinary", api: "openai-completions", baseUrl: "https://example.invalid",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1, maxTokens: 1,
	};
}

function handler(available: Model<Api>[]): { handle: ReturnType<typeof createRpcCommandHandler>; selected: Model<Api>[] } {
	const selected: Model<Api>[] = [];
	const session = {
		modelRegistry: {
			getAvailable: async () => available,
			requiresExactSelectionPersistence: () => false,
			requiresProviderPreparation: () => false,
			prepareRequiredProviders: async () => {},
			hasConfiguredAuth: () => true,
		},
		setModel: async (value: Model<Api>) => { selected.push(value); },
		get model() { return selected.at(-1); },
	} as unknown as AgentSession;
	return {
		handle: createRpcCommandHandler({
			runtimeHost: {} as never,
			getSession: () => session,
			rebindSession: async () => {},
			output: () => {},
		}),
		selected,
	};
}

describe("RPC available model selection", () => {
	test("rejects a model excluded from the available catalog", async () => {
		const { handle, selected } = handler([]);
		const response = await handle({ id: "filtered", type: "set_model", provider: "ordinary", modelId: "same" });
		assert.equal(response?.success, false);
		assert.match(response && "error" in response ? response.error : "", /available catalog/u);
		assert.deepEqual(selected, []);
	});

	test("retains ordinary first-match behavior within the available catalog", async () => {
		const first = model("First");
		const { handle, selected } = handler([first, model("Second")]);
		const response = await handle({ id: "ordinary", type: "set_model", provider: "ordinary", modelId: "same" });
		assert.equal(response?.success, true);
		assert.deepEqual(selected, [first]);
	});

	test("explicit exact-provider RPC commands prepare and surface structured missing auth", async () => {
		let preparations = 0;
		const authenticationError = Object.assign(new Error("Host OAuth is required."), { code: "AuthenticationMissing" });
		const session = {
			modelRegistry: {
				getAvailable: async () => [],
				requiresExactSelectionPersistence: (provider: string) => provider === "cursor",
				requiresProviderPreparation: (provider: string) => provider === "cursor",
				prepareRequiredProviders: async () => { preparations += 1; throw authenticationError; },
			},
			scopedModels: [],
		} as unknown as AgentSession;
		const handle = createRpcCommandHandler({
			runtimeHost: {} as never, getSession: () => session, rebindSession: async () => {}, output: () => {},
		});
		for (const command of [
			{ id: "set", type: "set_model" as const, provider: "cursor", modelId: "live" },
			{ id: "list", type: "get_available_models" as const },
		]) {
			const response = await handle(command);
			assert.equal(response?.success, false);
			assert.match(response && "error" in response ? response.error : "", /^AuthenticationMissing:/u);
		}
		assert.equal(preparations, 2);
	});
});
