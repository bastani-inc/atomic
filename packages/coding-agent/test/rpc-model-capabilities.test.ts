import type { Api, Model } from "@bastani/atomic-ai/compat";
import { describe, expect, test } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import type { AtomicProviderCompat } from "../src/core/model-capabilities.ts";
import { RpcClientApi, type RpcCommandBody } from "../src/modes/rpc/rpc-client-api.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";

class CatalogClient extends RpcClientApi {
	constructor(
		private readonly models: Model<Api>[],
		private readonly serialize = false,
	) {
		super();
	}

	protected request(command: RpcCommandBody): Promise<RpcResponse> {
		expect(command).toEqual({ type: "get_available_models" });
		const response: RpcResponse = {
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: this.models, scopedModels: [], customAuthProviders: [] },
		};
		return Promise.resolve(this.serialize ? (JSON.parse(JSON.stringify(response)) as RpcResponse) : response);
	}

	protected data<T>(response: RpcResponse): T {
		if (!("data" in response)) throw new Error("Expected RPC response data");
		return response.data as T;
	}
}

describe("RPC model capability metadata", () => {
	test("returns constrained-sampling compatibility without narrowing or cloning it", async () => {
		const base = getFixtureModel("anthropic", "claude-opus-5");
		expect(base).toBeDefined();
		const compat: AtomicProviderCompat = {
			...base!.compat,
			supportsStrictTools: true,
			supportsStrictMode: false,
			supportsOpenAIGrammarTools: true,
			supportsGrammarTools: true,
		};
		const model = { ...base!, compat } as Model<Api>;

		const [returned] = await new CatalogClient([model]).getAvailableModels();
		expect(returned?.compat).toBe(compat);
		const [serialized] = await new CatalogClient([model], true).getAvailableModels();
		expect(serialized?.compat).not.toBe(compat);
		expect(serialized?.compat).toMatchObject({
			supportsStrictTools: true,
			supportsStrictMode: false,
			supportsOpenAIGrammarTools: true,
			supportsGrammarTools: true,
		});
	});
});
