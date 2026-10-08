import assert from "node:assert/strict";
import type { Credential, ImagesContext } from "@bastani/pi-ai";
import { afterEach, describe, it, vi } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const IMAGES = "openai-images";

const imagesContext: ImagesContext = { input: [{ type: "text", text: "A red fox in the snow" }] };

const oauthCredential: Credential = {
	type: "oauth",
	access: "chatgpt-access",
	refresh: "chatgpt-refresh",
	expires: Date.now() + 3_600_000,
};

type LoginOptionsHost = {
	prototype: {
		getLoginProviderOptions(this: object, authType?: "oauth" | "api_key"): Array<{ id: string; authType: string }>;
	};
};

const getLoginProviderOptions = (InteractiveMode as unknown as LoginOptionsHost).prototype.getLoginProviderOptions;

async function createRuntime(stored: Record<string, Credential>) {
	const backend = new InMemoryAuthStorageBackend();
	backend.withLock(() => ({ result: undefined, next: JSON.stringify(stored) }));
	return ModelRuntime.create({
		credentials: AuthStorage.fromStorage(backend),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

async function availableImageIds(runtime: ModelRuntime): Promise<string[]> {
	return (await runtime.getAvailableOfType("image", IMAGES)).map((model) => model.id);
}

afterEach(() => vi.unstubAllEnvs());

describe("openai-images shares OpenAI API credentials", () => {
	it("is not a login choice (#3527)", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const runtime = await createRuntime({});

		const choices = getLoginProviderOptions
			.call({ session: { modelRuntime: runtime } })
			.map((option) => `${option.id}:${option.authType}`);
		assert.ok(choices.includes("openai-api:api_key"));
		assert.deepEqual(
			choices.filter((choice) => choice.startsWith(`${IMAGES}:`)),
			[],
		);
		assert.equal(runtime.getProvider(IMAGES)?.auth.apiKey?.login, undefined);
	});

	it("generates images with the key saved for openai-api (#3527)", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const runtime = await createRuntime({ "openai-api": { type: "api_key", key: "sk-openai-api" } });
		const flare = runtime.getModelOfType("image", IMAGES, "gpt-image-2.5-flare");
		assert(flare);
		const authorizations: Array<string | null> = [];

		const result = await runtime.generateImages(flare, imagesContext, {
			fetch: async (_input, init) => {
				authorizations.push(new Headers(init?.headers).get("authorization"));
				return Response.json({ created: 1, data: [{ b64_json: "aW1n" }] });
			},
		});

		assert.ok((await availableImageIds(runtime)).includes("gpt-image-2.5-flare"));
		assert.deepEqual(authorizations, ["Bearer sk-openai-api"]);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: "aW1n" }]);
	});

	it("is unavailable with only a ChatGPT sign-in on openai (#3527)", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const runtime = await createRuntime({ openai: oauthCredential });
		const flare = runtime.getModelOfType("image", IMAGES, "gpt-image-2.5-flare");
		assert(flare);

		const result = await runtime.generateImages(flare, imagesContext);

		assert.deepEqual(await availableImageIds(runtime), []);
		assert.equal(await runtime.getAuth(IMAGES), undefined);
		assert.equal((await runtime.checkAuth("openai"))?.type, "oauth");
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "Provider is not configured: openai-images");
	});
});
