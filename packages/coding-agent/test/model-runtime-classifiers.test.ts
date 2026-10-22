import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@bastani/pi-ai";
import { afterEach, describe, it, vi } from "vitest";
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

const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" };

describe("ModelRuntime classifiers", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createRuntime(modelsJson: object): Promise<ModelRuntime> {
		const dir = mkdtempSync(join(tmpdir(), "atomic-classifiers-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(modelsJson));
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
	}

	async function captureImageRequest(runtime: ModelRuntime, provider: string, id: string) {
		await runtime.setRuntimeApiKey(provider, "secret", {});
		const model = runtime.getModelOfType("classifier", provider, id);
		assert(model, `missing ${provider}/${id}`);
		const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		const result = await runtime.classify(
			model,
			{ ...context, images: [image] },
			{
				fetch: async (input, init) => {
					requests.push({
						url: String(input),
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
					});
					return Response.json({ answers: { approved: { type: "noul", noul: 0.8 } } });
				},
			},
		);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(requests.length, 1);
		return requests[0]!;
	}

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

	it("keeps OpenRouter's image form when models.json routes OpenRouter through a proxy", async () => {
		const runtime = await createRuntime({ providers: { openrouter: { baseUrl: "https://proxy.example.com/v1" } } });

		const request = await captureImageRequest(runtime, "openrouter", "typesafe/jev-1.14");

		assert.equal(request.url, "https://proxy.example.com/v1/systemone");
		assert.deepEqual(request.body.state, [
			{ type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
			context.state,
		]);
		assert.equal(Object.hasOwn(request.body, "assets"), false);
		assert.equal(request.headers.has("typesafe-danger-zone-images"), false);
	});

	it("applies provider compat from models.json to classifier models", async () => {
		const runtime = await createRuntime({
			providers: {
				typesafe: {
					baseUrl: "https://proxy.example.com/v1",
					compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
				},
			},
		});

		const request = await captureImageRequest(runtime, "typesafe", "jev-latest");

		assert.equal(request.url, "https://proxy.example.com/v1/systemone");
		assert.deepEqual(request.body.state, [
			{ type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
			context.state,
		]);
		assert.equal(Object.hasOwn(request.body, "assets"), false);
	});
});
