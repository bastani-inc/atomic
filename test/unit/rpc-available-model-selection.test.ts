import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	attachProviderModelReference,
	getPersistedProviderSelection,
	getProviderTransportSelection,
} from "../../packages/coding-agent/src/core/provider-model-reference.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";
import { toRpcEvent } from "../../packages/coding-agent/src/modes/rpc/rpc-model.ts";

function model(name: string): Model<Api> {
	return {
		id: "same", name, provider: "ordinary", api: "openai-completions", baseUrl: "https://example.invalid",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1, maxTokens: 1,
	};
}
function exactSelection(occurrence: number): object {
	return { version: 1, provider: "cursor", routeId: "same", occurrence };
}

function exactModel(name: string, occurrence: number, persisted = true): Model<Api> {
	const transportSelection = exactSelection(occurrence);
	return attachProviderModelReference(
		{ ...model(name), provider: "cursor" },
		{
			provider: "cursor",
			schemaVersion: 1,
			data: {},
			transportSelection,
			...(persisted ? { selection: transportSelection } : {}),
		},
	);
}


function handler(
	available: Model<Api>[],
	requiresExactSelection = false,
): { handle: ReturnType<typeof createRpcCommandHandler>; selected: Model<Api>[] } {
	const selected: Model<Api>[] = [];
	const session = {
		modelRegistry: {
			getAvailable: async () => available,
			requiresExactSelectionPersistence: () => requiresExactSelection,
			requiresProviderPreparation: () => false,
			prepareRequiredProviders: async () => {},
			getCustomApiKeyAuthProviders: () => [],
			hasConfiguredAuth: () => true,
		},
		setModel: async (value: Model<Api>) => { selected.push(value); },
		scopedModels: [],
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

	test("does not expose an unowned providerSelection model property", async () => {
		const forged = { ...model("Forged"), providerSelection: { forged: true } } as Model<Api>;
		const { handle } = handler([forged]);
		const response = await handle({ id: "list", type: "get_available_models" });
		assert.equal(response?.success, true);
		const wire = JSON.parse(JSON.stringify(response)) as {
			data: { models: Array<{ providerSelection?: object }> };
		};
		assert.equal(wire.data.models[0]?.providerSelection, undefined);
	});

	test("round-trips an exact provider selection through the JSON catalog", async () => {
		const selection = exactSelection;
		const first = exactModel("First", 1);
		const second = exactModel("Second", 2);
		const { handle, selected } = handler([first, second], true);

		const listed = await handle({ id: "list", type: "get_available_models" });
		assert.equal(listed?.success, true);
		const wire = JSON.parse(JSON.stringify(listed)) as {
			data: { models: Array<{ providerSelection?: object }> };
		};
		assert.deepEqual(wire.data.models.map((item) => item.providerSelection), [selection(1), selection(2)]);

		const response = await handle({
			id: "exact",
			type: "set_model",
			provider: "cursor",
			modelId: "same",
			providerSelection: wire.data.models[1]?.providerSelection,
		} as never);
		assert.equal(response?.success, true);
		assert.deepEqual(selected, [second]);
		const selectedWire = JSON.parse(JSON.stringify(response)) as { data: { providerSelection?: object } };
		assert.deepEqual(selectedWire.data.providerSelection, selection(2));
	});

	test("round-trips runtime-only duplicate exact-provider models without making them persistable", async () => {
		const first = exactModel("First", 1, false);
		const second = exactModel("Second", 2, false);
		assert.equal(getPersistedProviderSelection(second), undefined);
		assert.deepEqual(getProviderTransportSelection(second), exactSelection(2));
		const { handle, selected } = handler([first, second], true);
		const listed = await handle({ id: "runtime-list", type: "get_available_models" });
		const wire = JSON.parse(JSON.stringify(listed)) as {
			data: { models: Array<{ providerSelection?: object }> };
		};

		const response = await handle({
			id: "runtime-exact",
			type: "set_model",
			provider: "cursor",
			modelId: "same",
			providerSelection: wire.data.models[1]?.providerSelection,
		});
		assert.equal(response?.success, true);
		assert.deepEqual(selected, [second]);
	});


	test("projects exact identity into model_changed events across JSON", () => {
		const first = exactModel("First", 1, false);
		const second = exactModel("Second", 2, false);
		const wire = JSON.parse(JSON.stringify(toRpcEvent({
			type: "model_changed",
			model: second,
			previousModel: first,
			source: "restore",
		}))) as {
			model: { providerSelection?: object };
			previousModel?: { providerSelection?: object };
		};
		assert.deepEqual(wire.model.providerSelection, exactSelection(2));
		assert.deepEqual(wire.previousModel?.providerSelection, exactSelection(1));
	});
	test("rejects omitted and stale selectors for duplicate exact-provider models", async () => {
		const { handle, selected } = handler([exactModel("First", 1), exactModel("Second", 2)], true);
		for (const [id, providerSelection, code] of [
			["missing", undefined, "AmbiguousSelection"],
			["stale", exactSelection(3), "MismatchedSelection"],
		] as const) {
			const response = await handle({
				id,
				type: "set_model",
				provider: "cursor",
				modelId: "same",
				providerSelection,
			});
			assert.equal(response?.success, false);
			assert.match(response && "error" in response ? response.error : "", new RegExp(`^${code}:`, "u"));
		}
		assert.deepEqual(selected, []);
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
