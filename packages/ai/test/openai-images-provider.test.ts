import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { Credential } from "../src/auth/types.ts";
import { generateImages } from "../src/images.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { ImagesContext } from "../src/types.ts";

const OPENAI_IMAGE_MODEL_IDS = [
	"gpt-image-1",
	"gpt-image-1-mini",
	"gpt-image-1.5",
	"gpt-image-2",
	"gpt-image-2.5-flare",
	"gpt-image-2.5-sunburst",
];

const context: ImagesContext = { input: [{ type: "text", text: "A red fox in the snow" }] };

const noEnv = { env: async () => undefined, fileExists: async () => false };

const apiKey = (key: string): Credential => ({ type: "api_key", key });
const oauth: Credential = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000 };

async function imagesModels(options: { stored?: Record<string, Credential>; env?: string } = {}) {
	const credentials = new InMemoryCredentialStore();
	for (const [providerId, credential] of Object.entries(options.stored ?? {})) {
		await credentials.modify(providerId, async () => credential);
	}
	return builtinModels({
		credentials,
		authContext: options.env
			? { env: async (name) => (name === "OPENAI_API_KEY" ? options.env : undefined), fileExists: async () => false }
			: noEnv,
	});
}

async function availableIds(models: ReturnType<typeof builtinModels>): Promise<string[]> {
	return (await models.getAvailableOfType("image", "openai-images")).map((model) => model.id).sort();
}

function imageFetch(authorizations: Array<string | null>, urls: string[] = [], bodies: string[] = []) {
	return async (input: string | URL | Request, init?: RequestInit) => {
		urls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		bodies.push(String(init?.body));
		return Response.json({ created: 1, output_format: "png", data: [{ b64_json: "aW1n" }] });
	};
}

describe("openai-images provider", () => {
	it("lists OpenAI image models on the Images API under openai-images only (#3527)", () => {
		const models = builtinModels();

		assert.deepEqual(
			models
				.getModelsOfType("image", "openai-images")
				.map((model) => model.id)
				.sort(),
			OPENAI_IMAGE_MODEL_IDS,
		);
		const flare = models.getModelOfType("image", "openai-images", "gpt-image-2.5-flare");
		assert(flare);
		assert.equal(flare.api, "openai-images");
		assert.equal(flare.name, "GPT Image 2.5 Flare");
		assert.equal(flare.baseUrl, "https://api.openai.com/v1");
		assert.deepEqual(flare.input, ["text", "image"]);
		assert.deepEqual(flare.output, ["image"]);
		assert.deepEqual(
			{ input: flare.cost.input, output: flare.cost.output, cacheRead: flare.cost.cacheRead },
			{ input: 5, output: 30, cacheRead: 1.25 },
		);
		assert.deepEqual(models.getModelsOfType("image", "openai"), []);
		assert.deepEqual(models.getModelsOfType("image", "openai-api"), []);
		assert.equal(models.getModelOfType("image", "openai-api", "gpt-image-2.5-flare"), undefined);
		assert.equal(models.getModelOfType("image", "openai", "gpt-image-2.5-flare"), undefined);
	});

	it("has no login of its own and rejects login attempts (#3527)", async () => {
		const models = builtinModels();
		const auth = models.getProvider("openai-images")?.auth;
		assert(auth?.apiKey);
		assert.equal(auth.apiKey.login, undefined);
		assert.equal(auth.oauth, undefined);
		await assert.rejects(
			models.login("openai-images", "api_key", { prompt: async () => "sk-typed", notify: () => {} }),
			/does not support api_key login/,
		);
	});

	it("resolves from an API key stored for openai-api (#3527)", async () => {
		const models = await imagesModels({ stored: { "openai-api": apiKey("sk-openai-api") } });

		assert.deepEqual(await availableIds(models), OPENAI_IMAGE_MODEL_IDS);
		assert.equal((await models.getAuth("openai-images"))?.auth.apiKey, "sk-openai-api");
		assert.equal((await models.checkAuth("openai-images"))?.type, "api_key");
	});

	it("resolves from an API key stored for openai (#3527)", async () => {
		const models = await imagesModels({ stored: { openai: apiKey("sk-openai") } });

		assert.deepEqual(await availableIds(models), OPENAI_IMAGE_MODEL_IDS);
		assert.equal((await models.getAuth("openai-images"))?.auth.apiKey, "sk-openai");
	});

	it("falls back to OPENAI_API_KEY (#3527)", async () => {
		const models = await imagesModels({ env: "sk-env" });

		assert.deepEqual(await availableIds(models), OPENAI_IMAGE_MODEL_IDS);
		const resolution = await models.getAuth("openai-images");
		assert.equal(resolution?.auth.apiKey, "sk-env");
		assert.equal(resolution?.source, "OPENAI_API_KEY");
	});

	it("prefers openai-api over openai over OPENAI_API_KEY (#3527)", async () => {
		const both = await imagesModels({
			stored: { "openai-api": apiKey("sk-openai-api"), openai: apiKey("sk-openai") },
			env: "sk-env",
		});
		const openaiOnly = await imagesModels({ stored: { openai: apiKey("sk-openai") }, env: "sk-env" });

		assert.equal((await both.getAuth("openai-images"))?.auth.apiKey, "sk-openai-api");
		assert.equal((await openaiOnly.getAuth("openai-images"))?.auth.apiKey, "sk-openai");
	});

	it("is unavailable with only a ChatGPT OAuth login on openai (#3527)", async () => {
		const models = await imagesModels({ stored: { openai: oauth } });
		const flare = models.getModelOfType("image", "openai-images", "gpt-image-2.5-flare");
		assert(flare);
		const authorizations: Array<string | null> = [];

		const result = await models.generateImages(flare, context, { fetch: imageFetch(authorizations) });

		assert.deepEqual(await availableIds(models), []);
		assert.equal(await models.getAuth("openai-images"), undefined);
		assert.equal(await models.checkAuth("openai-images"), undefined);
		assert.equal((await models.checkAuth("openai"))?.type, "oauth");
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "Provider is not configured: openai-images");
		assert.deepEqual(authorizations, []);
	});

	it("is unavailable without any OpenAI API credential (#3527)", async () => {
		const models = await imagesModels();

		assert.deepEqual(await availableIds(models), []);
		assert.equal(await models.getAuth("openai-images"), undefined);
		assert.equal(await models.checkAuth("openai-images"), undefined);
	});

	it("sends the borrowed key and image options when generating images (#3527)", async () => {
		const models = await imagesModels({ stored: { "openai-api": apiKey("sk-openai-api") } });
		const flare = models.getModelOfType("image", "openai-images", "gpt-image-2.5-flare");
		assert(flare);
		const authorizations: Array<string | null> = [];
		const urls: string[] = [];
		const bodies: string[] = [];

		const result = await models.generateImages(flare, context, {
			fetch: imageFetch(authorizations, urls, bodies),
			size: "1024x1024",
			quality: "low",
		});

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: "aW1n" }]);
		assert.deepEqual(urls, ["https://api.openai.com/v1/images/generations"]);
		assert.deepEqual(authorizations, ["Bearer sk-openai-api"]);
		assert.deepEqual(JSON.parse(bodies[0] ?? ""), {
			model: "gpt-image-2.5-flare",
			prompt: "A red fox in the snow",
			size: "1024x1024",
			quality: "low",
		});
	});

	it("is registered for the global generateImages() dispatch (#3527)", async () => {
		const flare = builtinModels().getModelOfType("image", "openai-images", "gpt-image-2.5-flare");
		assert(flare);
		const authorizations: Array<string | null> = [];
		const urls: string[] = [];

		const result = await generateImages(flare, context, {
			apiKey: "sk-direct",
			fetch: imageFetch(authorizations, urls),
		});

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(urls, ["https://api.openai.com/v1/images/generations"]);
		assert.deepEqual(authorizations, ["Bearer sk-direct"]);
	});
});
