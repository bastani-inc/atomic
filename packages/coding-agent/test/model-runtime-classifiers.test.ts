import assert from "node:assert/strict";
import { InMemoryModelsStore } from "@bastani/pi-ai";
import { describe, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const context = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

describe("ModelRuntime classifiers", () => {
	it("lists Jev separately and classifies with runtime-resolved auth", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const jev = runtime.getModelOfType("classifier", "typesafe", "jev-latest")!;
		assert.equal(jev.type, "classifier");
		assert.equal(runtime.getModel("typesafe", "jev-latest"), undefined);

		const unconfigured = await runtime.classify(jev, context);
		assert.equal(unconfigured.stopReason, "error");
		assert.match(unconfigured.errorMessage ?? "", /not configured/);

		await runtime.setRuntimeApiKey("typesafe", "sk-typesafe", {});
		const jev14 = runtime.getModelOfType("classifier", "typesafe", "jev-1.14.0")!;
		assert.deepEqual(await runtime.getAvailableOfType("classifier", "typesafe"), [jev14, jev]);
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer sk-typesafe");
			assert.equal(headers.get("TypeSafe-Danger-Zone-Long-Context"), "true");
			assert.equal(headers.get("TypeSafe-Danger-Zone-Images"), "true");
			return Response.json({ answers: { approved: { type: "noul", noul: 0.8 } } });
		});
		const result = await runtime.classify(jev, context, { fetch });
		assert.deepEqual(result.answers.approved, { type: "bool", probability: 0.8 });
		assert.equal(fetch.mock.calls.length, 1);
	});
});
