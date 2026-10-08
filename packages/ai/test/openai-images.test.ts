import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { generateImages } from "../src/api/openai-images.ts";
import type { ImageModel, ImagesContext } from "../src/types.ts";

const model: ImageModel<"openai-images"> = {
	type: "image",
	id: "gpt-image-2.5-flare",
	name: "GPT Image 2.5 Flare",
	api: "openai-images",
	provider: "openai-images",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0 },
};

const textContext: ImagesContext = { input: [{ type: "text", text: "A red fox in the snow" }] };

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: RequestInit["body"];
}

function mockFetch(response: () => Response = () => Response.json({ created: 1, data: [{ b64_json: "aW1n" }] })): {
	fetch: typeof globalThis.fetch;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	return {
		requests,
		fetch: async (input, init) => {
			// The OpenAI SDK probes FormData support with a `data:,` request before its first multipart upload.
			if (String(input).startsWith("data:")) return new Response("");
			requests.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body });
			return response();
		},
	};
}

function jsonBody(request: CapturedRequest | undefined): Record<string, unknown> {
	assert(request);
	assert.equal(typeof request.body, "string");
	return JSON.parse(request.body as string);
}

describe("openai-images transport", () => {
	it("posts a text prompt to /images/generations without unset options (#3527)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await generateImages(
			model,
			{
				input: [
					{ type: "text", text: "A red fox" },
					{ type: "text", text: "in the snow" },
				],
			},
			{ apiKey: "sk-test", fetch },
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.url, "https://api.openai.com/v1/images/generations");
		assert.equal(requests[0]?.headers.get("authorization"), "Bearer sk-test");
		assert.deepEqual(jsonBody(requests[0]), { model: "gpt-image-2.5-flare", prompt: "A red fox\n\nin the snow" });
	});

	it("passes size, quality, n, and background when given (#3527)", async () => {
		const { fetch, requests } = mockFetch();

		await generateImages(model, textContext, {
			apiKey: "sk-test",
			fetch,
			size: "1536x1024",
			quality: "low",
			n: 2,
			background: "transparent",
		});

		assert.deepEqual(jsonBody(requests[0]), {
			model: "gpt-image-2.5-flare",
			prompt: "A red fox in the snow",
			size: "1536x1024",
			quality: "low",
			n: 2,
			background: "transparent",
		});
	});

	it("posts image inputs as multipart files to /images/edits (#3527)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await generateImages(
			model,
			{
				input: [
					{ type: "text", text: "Add a scarf" },
					{ type: "image", data: btoa("first"), mimeType: "image/png" },
					{ type: "image", data: btoa("second"), mimeType: "image/jpeg" },
				],
			},
			{ apiKey: "sk-test", fetch, quality: "medium" },
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests[0]?.url, "https://api.openai.com/v1/images/edits");
		const form = requests[0]?.body;
		assert(form instanceof FormData);
		assert.equal(form.get("model"), "gpt-image-2.5-flare");
		assert.equal(form.get("prompt"), "Add a scarf");
		assert.equal(form.get("quality"), "medium");
		const files = form.getAll("image[]");
		assert.equal(files.length, 2);
		const [first, second] = files as File[];
		assert.equal(first?.type, "image/png");
		assert.equal(await first?.text(), "first");
		assert.equal(second?.type, "image/jpeg");
		assert.equal(await second?.text(), "second");
	});

	it("returns each b64_json result as an image block typed by output_format (#3527)", async () => {
		const { fetch } = mockFetch(() =>
			Response.json({ created: 1, output_format: "webp", data: [{ b64_json: "b25l" }, { b64_json: "dHdv" }] }),
		);

		const result = await generateImages(model, textContext, { apiKey: "sk-test", fetch, n: 2 });

		assert.deepEqual(result.output, [
			{ type: "image", mimeType: "image/webp", data: "b25l" },
			{ type: "image", mimeType: "image/webp", data: "dHdv" },
		]);
	});

	it("uses the requested output format, then PNG, when the response omits output_format (#3527)", async () => {
		const { fetch } = mockFetch();

		const requested = await generateImages(model, textContext, {
			apiKey: "sk-test",
			fetch,
			onPayload: (payload) => ({ ...(payload as object), output_format: "jpeg" }),
		});
		const unspecified = await generateImages(model, textContext, { apiKey: "sk-test", fetch });

		assert.deepEqual(requested.output, [{ type: "image", mimeType: "image/jpeg", data: "aW1n" }]);
		assert.deepEqual(unspecified.output, [{ type: "image", mimeType: "image/png", data: "aW1n" }]);
	});

	it("reports token usage priced from the model cost (#3527)", async () => {
		const { fetch } = mockFetch(() =>
			Response.json({
				created: 1,
				data: [{ b64_json: "aW1n" }],
				usage: {
					input_tokens: 1000,
					input_tokens_details: { text_tokens: 1000, image_tokens: 0 },
					output_tokens: 2000,
					total_tokens: 3000,
				},
			}),
		);

		const result = await generateImages(model, textContext, { apiKey: "sk-test", fetch });

		const usage = result.usage;
		assert(usage);
		assert.equal(usage.input, 1000);
		assert.equal(usage.output, 2000);
		assert.equal(usage.cacheRead, 0);
		assert.equal(usage.totalTokens, 3000);
		assert.ok(Math.abs(usage.cost.input - 0.005) < 1e-12);
		assert.ok(Math.abs(usage.cost.output - 0.06) < 1e-12);
		assert.ok(Math.abs(usage.cost.total - 0.065) < 1e-12);
	});

	it("returns an error result with the provider message on an HTTP error (#3527)", async () => {
		const { fetch } = mockFetch(() =>
			Response.json(
				{ error: { message: "Billing hard limit has been reached.", type: "billing_limit_user_error" } },
				{ status: 400 },
			),
		);

		const result = await generateImages(model, textContext, { apiKey: "sk-test", fetch });

		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.output, []);
		assert.match(result.errorMessage ?? "", /400/);
		assert.match(result.errorMessage ?? "", /Billing hard limit has been reached/);
	});

	it("returns an error result without a request when no API key is given (#3527)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await generateImages(model, textContext, { fetch });

		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "No API key for provider: openai-images");
		assert.equal(requests.length, 0);
	});

	it("returns an aborted result when the signal is aborted (#3527)", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetch } = mockFetch();

		const result = await generateImages(model, textContext, { apiKey: "sk-test", fetch, signal: controller.signal });

		assert.equal(result.stopReason, "aborted");
		assert.deepEqual(result.output, []);
		assert.ok(result.errorMessage);
	});
});
