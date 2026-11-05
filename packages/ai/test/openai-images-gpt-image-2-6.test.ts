import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "vitest";
import { generateImages } from "../src/api/openai-images.ts";
import { OPENAI_IMAGES_LIMITS } from "../src/api/openai-images-options.ts";
import {
	type ImageGenerationConfigReason,
	ImageGenerationServerError,
	ImageGenerationUserError,
	imageGenerationErrorFromData,
	isImageGenerationApiError,
	isImageGenerationConfigError,
	isImageGenerationQuotaError,
	isImageGenerationRateLimitError,
	isImageGenerationServerError,
	isImageGenerationTimeoutError,
	isImageGenerationUserError,
	isImageModerationBlockedError,
	isRetryableImageGenerationError,
} from "../src/image-generation-error.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesInputContent } from "../src/types.ts";

const catalog = builtinModels();
function catalogModel(id: string): ImageModel<ImageApi> {
	const found = catalog.getModelOfType("image", "openai-images", id);
	assert(found, `catalog has ${id}`);
	return found;
}
const sunburst = catalogModel("gpt-image-2.6-sunburst");
const flare = catalogModel("gpt-image-2.6-flare");
const flare25 = catalogModel("gpt-image-2.5-flare");
const gptImage2 = catalogModel("gpt-image-2");
const gptImage1 = catalogModel("gpt-image-1");
const gptImage15 = catalogModel("gpt-image-1.5");
const gptImage1Mini = catalogModel("gpt-image-1-mini");

const textContext: ImagesContext = { input: [{ type: "text", text: "A paper lantern swinging" }] };
const png = (text: string, role?: "markup" | "mask"): ImagesInputContent => ({
	type: "image",
	data: btoa(text),
	mimeType: "image/png",
	...(role ? { role } : {}),
});
const editContext = (...images: ImagesInputContent[]): ImagesContext => ({
	input: [{ type: "text", text: "Recolor the vase" }, ...images],
});

interface CapturedRequest {
	url: string;
	body: RequestInit["body"];
}

function mockFetch(respond: (call: number) => Response | Promise<Response> = () => okResponse()) {
	const requests: CapturedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		if (String(input).startsWith("data:")) return new Response("");
		requests.push({ url: String(input), body: init?.body });
		return respond(requests.length);
	};
	return { fetch, requests };
}

function okResponse(extra: Record<string, unknown> = {}): Response {
	return Response.json({ created: 1, data: [{ b64_json: "aW1n" }], ...extra });
}

function jsonBody(request: CapturedRequest | undefined): Record<string, unknown> {
	assert(request);
	assert.equal(typeof request.body, "string");
	return JSON.parse(request.body as string);
}

function formOf(request: CapturedRequest | undefined): FormData {
	assert(request);
	assert(request.body instanceof FormData);
	return request.body;
}

async function run(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options: Parameters<typeof generateImages>[2],
	fetch: typeof globalThis.fetch,
): Promise<AssistantImages> {
	return generateImages(model, context, { apiKey: "sk-test", fetch, ...options });
}

function errorOf(result: AssistantImages) {
	assert(result.error, "result carries a typed error");
	return imageGenerationErrorFromData(result.error);
}

describe("GPT Image 2.6 request options (#4332)", () => {
	it("sends only the fields that are set (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await run(flare, textContext, { size: "1024x1024" }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(jsonBody(requests[0]), {
			model: "gpt-image-2.6-flare",
			prompt: "A paper lantern swinging",
			size: "1024x1024",
		});
	});

	it.each([
		["complexity", { complexity: "low" as const }, { complexity: "low" }],
		["moderation", { moderation: "low" as const }, { moderation: "low" }],
		["safetyIdentifier", { safetyIdentifier: "a".repeat(128) }, { safety_identifier: "a".repeat(128) }],
		["outputFormat", { outputFormat: "webp" as const }, { output_format: "webp" }],
		[
			"outputCompression",
			{ outputFormat: "jpeg" as const, outputCompression: 0 },
			{ output_format: "jpeg", output_compression: 0 },
		],
	])("maps %s to its API field on generations (#4332)", async (_name, options, wire) => {
		const { fetch, requests } = mockFetch();

		const result = await run(flare, textContext, options, fetch);

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(jsonBody(requests[0]), {
			model: "gpt-image-2.6-flare",
			prompt: "A paper lantern swinging",
			...wire,
		});
	});

	it.each([sunburst, flare])(
		"requests an animated GIF from %s and types the output image/gif (#4332)",
		async (model) => {
			const { fetch, requests } = mockFetch(() => okResponse({ output_format: "gif" }));

			const result = await run(
				model,
				textContext,
				{
					size: "256x256",
					quality: "low",
					complexity: "low",
					outputFormat: "gif",
					frameCount: 3,
					frameDurationMs: 200,
				},
				fetch,
			);

			assert.equal(result.stopReason, "stop");
			assert.equal(requests[0]?.url, "https://api.openai.com/v1/images/generations");
			assert.deepEqual(jsonBody(requests[0]), {
				model: model.id,
				prompt: "A paper lantern swinging",
				size: "256x256",
				quality: "low",
				complexity: "low",
				output_format: "gif",
				frame_count: 3,
				frame_duration_ms: 200,
			});
			assert.deepEqual(result.output, [{ type: "image", mimeType: "image/gif", data: "aW1n" }]);
		},
	);

	it("accepts the documented bounds of the GIF fields and several animations (#4332)", async () => {
		const { fetch, requests } = mockFetch();
		const { gifFrameCount, gifFrameDurationMs } = OPENAI_IMAGES_LIMITS;

		for (const [frameCount, frameDurationMs] of [
			[gifFrameCount.min, gifFrameDurationMs.min],
			[gifFrameCount.max, gifFrameDurationMs.max],
		]) {
			const result = await run(
				flare,
				textContext,
				{ outputFormat: "gif", frameCount, frameDurationMs, n: 2 },
				fetch,
			);
			assert.equal(result.stopReason, "stop");
		}

		assert.equal(requests.length, 2);
		assert.equal(jsonBody(requests[1]).n, 2);
	});

	it("requests SVG output and types it image/svg+xml with the XML bytes intact (#4332)", async () => {
		const xml = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
		const { fetch, requests } = mockFetch(() =>
			Response.json({ created: 1, output_format: "svg", data: [{ b64_json: btoa(xml) }] }),
		);

		const result = await run(sunburst, textContext, { outputFormat: "svg", n: 1 }, fetch);

		assert.deepEqual(jsonBody(requests[0]), {
			model: "gpt-image-2.6-sunburst",
			prompt: "A paper lantern swinging",
			n: 1,
			output_format: "svg",
		});
		assert.equal(result.output[0]?.type === "image" ? result.output[0].mimeType : undefined, "image/svg+xml");
		assert.equal(result.output[0]?.type === "image" ? atob(result.output[0].data) : undefined, xml);
	});

	it("sends the SVG authoring model and effort as the svg field (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await run(
			flare,
			textContext,
			{ outputFormat: "svg", svg: { model: "gpt-6-luna", reasoning: { effort: "low" } } },
			fetch,
		);

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(jsonBody(requests[0]).svg, { model: "gpt-6-luna", reasoning: { effort: "low" } });
		assert.equal(jsonBody(requests[0]).output_format, "svg");
	});

	it("types the output from the requested format when the response omits output_format (#4332)", async () => {
		const { fetch } = mockFetch();

		const gif = await run(flare, textContext, { outputFormat: "gif" }, fetch);
		const svg = await run(flare, textContext, { outputFormat: "svg" }, fetch);

		assert.equal(gif.output[0]?.type === "image" ? gif.output[0].mimeType : undefined, "image/gif");
		assert.equal(svg.output[0]?.type === "image" ? svg.output[0].mimeType : undefined, "image/svg+xml");
	});
});

describe("reference images, markup and mask (#4332)", () => {
	it("sends the first image as the base and the rest as references in order (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		await run(flare, editContext(png("base"), png("reference-a"), png("reference-b")), { complexity: "low" }, fetch);

		const form = formOf(requests[0]);
		assert.equal(requests[0]?.url, "https://api.openai.com/v1/images/edits");
		const files = form.getAll("image[]") as File[];
		assert.deepEqual(await Promise.all(files.map((file) => file.text())), ["base", "reference-a", "reference-b"]);
		assert.equal(form.get("complexity"), "low");
		assert.equal(form.get("markup"), null);
		assert.equal(form.get("mask"), null);
		assert.deepEqual([...new Set(form.keys())].sort(), ["complexity", "image[]", "model", "prompt"]);
	});

	it("sends a markup image as the markup field, not as an image (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await run(
			flare,
			editContext(png("base"), png("overlay", "markup"), png("extra reference")),
			{ quality: "low", safetyIdentifier: "hashed-user" },
			fetch,
		);

		assert.equal(result.stopReason, "stop");
		const form = formOf(requests[0]);
		const files = form.getAll("image[]") as File[];
		assert.deepEqual(await Promise.all(files.map((file) => file.text())), ["base", "extra reference"]);
		const markup = form.get("markup") as File;
		assert.equal(await markup.text(), "overlay");
		assert.equal(markup.type, "image/png");
		assert.equal(form.get("mask"), null);
		assert.equal(form.get("safety_identifier"), "hashed-user");
	});

	it("takes the base image from the first image without a role even after a role image (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		await run(flare, editContext(png("overlay", "markup"), png("base")), {}, fetch);

		const form = formOf(requests[0]);
		assert.deepEqual(await Promise.all((form.getAll("image[]") as File[]).map((file) => file.text())), ["base"]);
		assert.equal(await (form.get("markup") as File).text(), "overlay");
	});

	it("sends a mask image as the mask field on any model (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await run(gptImage1, editContext(png("base"), png("alpha", "mask")), {}, fetch);

		assert.equal(result.stopReason, "stop");
		const form = formOf(requests[0]);
		assert.deepEqual(await Promise.all((form.getAll("image[]") as File[]).map((file) => file.text())), ["base"]);
		assert.equal(await (form.get("mask") as File).text(), "alpha");
		assert.equal(form.get("markup"), null);
	});

	it("names the uploads after their role and MIME subtype (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		await run(
			flare,
			editContext(
				png("base"),
				{ type: "image", data: btoa("ref"), mimeType: "image/jpeg" },
				{ type: "image", data: btoa("odd"), mimeType: "image" },
				png("overlay", "markup"),
			),
			{},
			fetch,
		);
		await run(
			gptImage1,
			editContext(png("base"), { type: "image", data: btoa("m"), mimeType: "image/webp", role: "mask" }),
			{},
			fetch,
		);

		const first = formOf(requests[0]);
		assert.deepEqual(
			(first.getAll("image[]") as File[]).map((file) => file.name),
			["image-1.png", "image-2.jpeg", "image-3.png"],
		);
		assert.equal((first.get("markup") as File).name, "markup.png");
		assert.equal((formOf(requests[1]).get("mask") as File).name, "mask.webp");
	});

	it("allows markup-guided edits on GPT Image 2.5 (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await run(flare25, editContext(png("base"), png("overlay", "markup")), {}, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 1);
	});
});

interface InvalidCase {
	name: string;
	model: ImageModel<ImageApi>;
	context?: ImagesContext;
	options: Parameters<typeof generateImages>[2];
	field: string;
	reason: ImageGenerationConfigReason;
	related?: string;
}

const INVALID_CASES: InvalidCase[] = [
	{
		name: "frameCount of 1",
		model: flare,
		options: { outputFormat: "gif", frameCount: 1 },
		field: "frameCount",
		reason: "out-of-range",
	},
	{
		name: "frameCount above the limit",
		model: flare,
		options: { outputFormat: "gif", frameCount: OPENAI_IMAGES_LIMITS.gifFrameCount.max + 1 },
		field: "frameCount",
		reason: "out-of-range",
	},
	{
		name: "fractional frameCount",
		model: flare,
		options: { outputFormat: "gif", frameCount: 2.5 },
		field: "frameCount",
		reason: "out-of-range",
	},
	{
		name: "frameDurationMs of 19",
		model: flare,
		options: { outputFormat: "gif", frameDurationMs: 19 },
		field: "frameDurationMs",
		reason: "out-of-range",
	},
	{
		name: "frameDurationMs of 2001",
		model: flare,
		options: { outputFormat: "gif", frameDurationMs: 2001 },
		field: "frameDurationMs",
		reason: "out-of-range",
	},
	{
		name: "outputCompression of -1",
		model: flare,
		options: { outputFormat: "jpeg", outputCompression: -1 },
		field: "outputCompression",
		reason: "out-of-range",
	},
	{
		name: "outputCompression of 101",
		model: flare,
		options: { outputFormat: "webp", outputCompression: 101 },
		field: "outputCompression",
		reason: "out-of-range",
	},
	{
		name: "safetyIdentifier of 129 characters",
		model: flare,
		options: { safetyIdentifier: "a".repeat(129) },
		field: "safetyIdentifier",
		reason: "out-of-range",
	},
	{
		name: "frameCount without GIF output",
		model: flare,
		options: { frameCount: 3 },
		field: "frameCount",
		reason: "requires-option",
		related: "outputFormat",
	},
	{
		name: "frameDurationMs with png output",
		model: flare,
		options: { outputFormat: "png", frameDurationMs: 200 },
		field: "frameDurationMs",
		reason: "requires-option",
		related: "outputFormat",
	},
	{
		name: "GIF output on an edit",
		model: flare,
		context: editContext(png("base")),
		options: { outputFormat: "gif" },
		field: "outputFormat",
		reason: "generation-only",
		related: "image",
	},
	{
		name: "SVG output on an edit",
		model: flare,
		context: editContext(png("base")),
		options: { outputFormat: "svg" },
		field: "outputFormat",
		reason: "generation-only",
		related: "image",
	},
	{
		name: "SVG output with n of 2",
		model: flare,
		options: { outputFormat: "svg", n: 2 },
		field: "n",
		reason: "conflicts-with-option",
		related: "outputFormat",
	},
	{
		name: "svg authoring options without SVG output",
		model: flare,
		options: { svg: { model: "gpt-6-luna" } },
		field: "svg",
		reason: "requires-option",
		related: "outputFormat",
	},
	{
		name: "svg authoring options with GIF output",
		model: flare,
		options: { outputFormat: "gif", svg: { model: "gpt-6-luna" } },
		field: "svg",
		reason: "requires-option",
		related: "outputFormat",
	},
	{
		name: "compression with png output",
		model: flare,
		options: { outputFormat: "png", outputCompression: 50 },
		field: "outputCompression",
		reason: "conflicts-with-option",
		related: "outputFormat",
	},
	{
		name: "compression without an output format",
		model: flare,
		options: { outputCompression: 50 },
		field: "outputCompression",
		reason: "conflicts-with-option",
		related: "outputFormat",
	},
	{
		name: "compression with gif output",
		model: flare,
		options: { outputFormat: "gif", outputCompression: 50 },
		field: "outputCompression",
		reason: "conflicts-with-option",
		related: "outputFormat",
	},
	{
		name: "compression with svg output",
		model: flare,
		options: { outputFormat: "svg", outputCompression: 50 },
		field: "outputCompression",
		reason: "conflicts-with-option",
		related: "outputFormat",
	},
	{
		name: "markup together with a mask",
		model: flare,
		context: editContext(png("base"), png("overlay", "markup"), png("alpha", "mask")),
		options: {},
		field: "markup",
		reason: "conflicts-with-option",
		related: "mask",
	},
	{
		name: "markup without a base image",
		model: flare,
		context: editContext(png("overlay", "markup")),
		options: {},
		field: "input",
		reason: "requires-base-image",
		related: "markup",
	},
	{
		name: "a mask without a base image",
		model: flare,
		context: editContext(png("alpha", "mask")),
		options: {},
		field: "input",
		reason: "requires-base-image",
		related: "mask",
	},
	{
		name: "two markup images",
		model: flare,
		context: editContext(png("base"), png("one", "markup"), png("two", "markup")),
		options: {},
		field: "input",
		reason: "duplicate-role",
		related: "markup",
	},
	{
		name: "two mask images",
		model: flare,
		context: editContext(png("base"), png("one", "mask"), png("two", "mask")),
		options: {},
		field: "input",
		reason: "duplicate-role",
		related: "mask",
	},
	{
		name: "complexity on GPT Image 2.5",
		model: flare25,
		options: { complexity: "low" },
		field: "complexity",
		reason: "unsupported-by-model",
	},
	{
		name: "complexity on GPT Image 2",
		model: gptImage2,
		options: { complexity: "high" },
		field: "complexity",
		reason: "unsupported-by-model",
	},
	{
		name: "GIF output on GPT Image 2.5",
		model: flare25,
		options: { outputFormat: "gif" },
		field: "outputFormat",
		reason: "unsupported-by-model",
	},
	{
		name: "SVG output on GPT Image 1",
		model: gptImage1,
		options: { outputFormat: "svg" },
		field: "outputFormat",
		reason: "unsupported-by-model",
	},
	{
		name: "markup on GPT Image 2",
		model: gptImage2,
		context: editContext(png("base"), png("overlay", "markup")),
		options: {},
		field: "markup",
		reason: "unsupported-by-model",
	},
	...[gptImage15, gptImage1, gptImage1Mini].map(
		(model): InvalidCase => ({
			name: `markup on ${model.name}`,
			model,
			context: editContext(png("base"), png("overlay", "markup")),
			options: {},
			field: "markup",
			reason: "unsupported-by-model",
		}),
	),
];

describe("GPT Image 2.6 request validation (#4332)", () => {
	it.each(INVALID_CASES)("rejects $name before sending a request (#4332)", async (invalid) => {
		const { fetch, requests } = mockFetch();

		const result = await run(invalid.model, invalid.context ?? textContext, invalid.options, fetch);

		assert.equal(requests.length, 0);
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.output, []);
		const error = errorOf(result);
		assert(isImageGenerationConfigError(error));
		assert.equal(error.code, "invalid-option");
		assert.equal(error.name, "ImageGenerationConfigError");
		assert.equal(error.source, "sdk");
		assert.equal(error.field, invalid.field);
		assert.equal(error.reason, invalid.reason);
		assert.equal(error.related, invalid.related);
		assert.equal(error.model, invalid.model.id);
		assert.equal(error.retryable, false);
		assert.ok(error.hint && error.hint.length > 10);
		assert.ok(error.detail.length > 10);
		assert.equal(result.errorMessage, error.message);
	});

	it.each(["jpeg", "gif", "svg"] as const)(
		"rejects transparent %s output before hooks or requests (#4332)",
		async (outputFormat) => {
			const { fetch, requests } = mockFetch();
			let hookCalls = 0;
			const result = await run(
				flare,
				textContext,
				{ background: "transparent", outputFormat, onPayload: () => void hookCalls++ },
				fetch,
			);

			const error = errorOf(result);
			assert(isImageGenerationConfigError(error));
			assert.equal(error.field, "background");
			assert.equal(error.reason, "conflicts-with-option");
			assert.equal(error.related, "outputFormat");
			assert.equal(hookCalls, 0);
			assert.equal(requests.length, 0);
		},
	);

	it("names the offending model and option in the message of a rejected request (#4332)", async () => {
		const { fetch } = mockFetch();

		const result = await run(gptImage2, textContext, { complexity: "low" }, fetch);

		assert.equal(
			result.errorMessage,
			"Invalid image generation option: complexity for gpt-image-2 (invalid-option). gpt-image-2 does not support complexity. Use a GPT Image 2.6 model (gpt-image-2.6-sunburst or gpt-image-2.6-flare).",
		);
	});

	it("accepts the boundary values and combinations the API allows (#4332)", async () => {
		const { fetch, requests } = mockFetch();
		const accepted: Parameters<typeof generateImages>[2][] = [
			{ outputFormat: "jpeg", outputCompression: 100 },
			{ outputFormat: "webp", outputCompression: 0 },
			{ outputFormat: "svg", n: 1 },
			{ outputFormat: "gif", n: 3 },
			{ safetyIdentifier: "a".repeat(OPENAI_IMAGES_LIMITS.safetyIdentifierMaxLength) },
			{ n: 4, outputFormat: "png" },
			{ background: "transparent" },
			{ background: "transparent", outputFormat: "png" },
			{ background: "transparent", outputFormat: "webp" },
		];

		for (const options of accepted) {
			const result = await run(flare, textContext, options, fetch);
			assert.equal(result.stopReason, "stop", JSON.stringify(options));
		}

		assert.equal(requests.length, accepted.length);
	});

	it("validates the request an onPayload hook returns before sending it (#4332)", async () => {
		const { fetch, requests } = mockFetch();
		const replace = (extra: Record<string, unknown>) => (payload: unknown) => ({ ...(payload as object), ...extra });

		for (const [extra, field, reason, related] of [
			[{ output_format: "gif", stream: true }, "stream", "conflicts-with-option", "outputFormat"],
			[{ output_format: "svg", partial_images: 0 }, "partialImages", "conflicts-with-option", "outputFormat"],
			[{ frame_count: 4 }, "frameCount", "requires-option", "outputFormat"],
			[{ background: "transparent", output_format: "jpeg" }, "background", "conflicts-with-option", "outputFormat"],
		] as const) {
			const result = await run(flare, textContext, { onPayload: replace(extra) }, fetch);
			const error = errorOf(result);
			assert(isImageGenerationConfigError(error));
			assert.equal(error.field, field);
			assert.equal(error.reason, reason);
			assert.equal(error.related, related);
			assert.ok(error.detail.length > 10);
			assert.ok(error.hint && error.hint.length > 10);
		}

		assert.equal(requests.length, 0);
	});

	it("rejects an invalid request before an onPayload hook sees it (#4332)", async () => {
		const { fetch, requests } = mockFetch();
		const seen: unknown[] = [];

		const result = await run(
			flare,
			textContext,
			{ frameCount: 3, onPayload: (payload) => void seen.push(payload) },
			fetch,
		);

		const error = errorOf(result);
		assert(isImageGenerationConfigError(error));
		assert.equal(error.field, "frameCount");
		assert.equal(error.reason, "requires-option");
		assert.deepEqual(seen, []);
		assert.equal(requests.length, 0);
	});

	it("validates a payload an onPayload hook changes in place before sending it (#4332)", async () => {
		const { fetch, requests } = mockFetch();
		const mutate = (extra: Record<string, unknown>) => (payload: unknown) => {
			Object.assign(payload as object, extra);
			return undefined;
		};

		const invalid = await run(
			flare,
			textContext,
			{ onPayload: mutate({ output_format: "gif", frame_count: 1 }) },
			fetch,
		);

		const error = errorOf(invalid);
		assert(isImageGenerationConfigError(error));
		assert.equal(error.field, "frameCount");
		assert.equal(error.reason, "out-of-range");
		assert.equal(requests.length, 0);

		const valid = await run(flare, textContext, { onPayload: mutate({ moderation: "low" }) }, fetch);

		assert.equal(valid.stopReason, "stop");
		assert.equal(requests.length, 1);
		assert.equal(jsonBody(requests[0]).moderation, "low");
	});

	it.each(["markup", "mask"] as const)(
		"rejects hooks that remove or empty the base image for %s (#4332)",
		async (role) => {
			for (const emptyArray of [false, true]) {
				for (const replace of [false, true]) {
					const { fetch, requests } = mockFetch();
					const result = await run(
						flare,
						editContext(png("base"), png("overlay", role)),
						{
							onPayload: (payload) => {
								const changed = replace ? { ...(payload as object) } : (payload as Record<string, object>);
								if (emptyArray) Object.assign(changed, { image: [] });
								else delete (changed as Record<string, object>).image;
								return replace ? changed : undefined;
							},
						},
						fetch,
					);

					const error = errorOf(result);
					assert(isImageGenerationConfigError(error));
					assert.equal(error.field, "input");
					assert.equal(error.reason, "requires-base-image");
					assert.equal(error.related, role);
					assert.equal(requests.length, 0);
				}
			}
		},
	);

	it("allows streaming fields on formats that support them (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		for (const extra of [{ stream: true }, { partial_images: 2 }, { output_format: "webp", partial_images: 1 }]) {
			const result = await run(flare, textContext, { onPayload: (p) => ({ ...(p as object), ...extra }) }, fetch);
			assert.equal(result.stopReason, "stop", JSON.stringify(extra));
		}

		assert.equal(requests.length, 3);
	});

	it("rejects an invalid request without options and with an aborted signal as aborted, untyped (#4332)", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetch, requests } = mockFetch();

		const aborted = await run(flare, textContext, { frameCount: 3, signal: controller.signal }, fetch);
		const noOptions = await generateImages(flare, textContext);

		assert.equal(aborted.stopReason, "aborted");
		assert.equal(aborted.error, undefined);
		assert.equal(noOptions.stopReason, "error");
		assert.equal(noOptions.errorMessage, "No API key for provider: openai-images");
		assert.equal(requests.length, 0);
	});

	it("lets an onPayload hook add a valid field (#4332)", async () => {
		const { fetch, requests } = mockFetch();

		const result = await run(
			flare,
			textContext,
			{ onPayload: (p) => ({ ...(p as object), moderation: "low" }) },
			fetch,
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(jsonBody(requests[0]).moderation, "low");
	});
});

function apiError(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): Response {
	return Response.json({ error: { message: "provider said no", ...error } }, { status, headers });
}

describe("GPT Image 2.6 error mapping (#4332)", () => {
	it("maps moderation_blocked to ImageModerationBlockedError with its details and does not retry (#4332)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(
				400,
				{
					type: "image_generation_user_error",
					code: "moderation_blocked",
					moderation_details: { moderation_stage: "input", categories: ["harassment", "violence"] },
				},
				{ "x-request-id": "req_123", "x-should-retry": "true" },
			),
		);

		const result = await run(flare, textContext, { maxRetries: 3, maxRetryDelayMs: 1 }, fetch);

		assert.equal(requests.length, 1);
		assert.equal(result.stopReason, "error");
		const error = errorOf(result);
		assert(isImageModerationBlockedError(error));
		assert(isImageGenerationUserError(error));
		assert(isImageGenerationApiError(error));
		assert.equal(error.code, "moderation-blocked");
		assert.equal(error.name, "ImageModerationBlockedError");
		assert.equal(error.moderationStage, "input");
		assert.deepEqual(error.categories, ["harassment", "violence"]);
		assert.equal(error.apiCode, "moderation_blocked");
		assert.equal(error.apiType, "image_generation_user_error");
		assert.equal(error.status, 400);
		assert.equal(error.requestId, "req_123");
		assert.equal(error.retryable, false);
		assert.equal(isRetryableImageGenerationError(error), false);
		assert.equal(
			error.message,
			"Image generation request failed (moderation-blocked): HTTP 400, type image_generation_user_error, code moderation_blocked, request req_123",
		);
		assert.equal(
			error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : undefined,
			"APIError: [foreign error message omitted]",
		);
		assert.match(result.errorMessage ?? "", /provider said no/);
	});

	it("keeps provider text that quotes the prompt out of the typed error (#4332)", async () => {
		const prompt = "SECRET-PROMPT-7f3a a portrait of my neighbour";
		const echo = (error: Record<string, unknown>) =>
			mockFetch(() =>
				apiError(
					400,
					{ message: `Your request was rejected: "${prompt}"`, ...error },
					{ "x-request-id": "req_123" },
				),
			);
		const promptContext: ImagesContext = { input: [{ type: "text", text: prompt }] };
		const blocked = echo({
			type: "image_generation_user_error",
			code: "moderation_blocked",
			moderation_details: { moderation_stage: "input", categories: ["harassment", `about ${prompt}`] },
		});
		const unsafeCode = echo({ type: "image_generation_user_error", code: `rejected: ${prompt}` });
		const unsafeType = echo({ type: `the prompt ${prompt}`, code: "content_policy_violation" });

		const results = [
			await run(flare, promptContext, {}, blocked.fetch),
			await run(flare, promptContext, {}, unsafeCode.fetch),
			await run(flare, promptContext, {}, unsafeType.fetch),
		];

		for (const result of results) {
			assert.ok(result.error);
			assert.equal(JSON.stringify(result.error).includes("SECRET-PROMPT"), false, JSON.stringify(result.error));
			const error = errorOf(result);
			for (const text of [error.message, error.hint, error.cause instanceof Error ? error.cause.message : ""]) {
				assert.equal(text?.includes("SECRET-PROMPT"), false);
			}
		}
		const [moderation, user, other] = results.map(errorOf);
		assert(isImageModerationBlockedError(moderation));
		assert.equal(
			moderation.detail,
			"HTTP 400, type image_generation_user_error, code moderation_blocked, request req_123",
		);
		assert.deepEqual(moderation.categories, ["harassment"]);
		assert(isImageGenerationUserError(user));
		assert.equal(user.apiCode, undefined);
		assert.equal(user.detail, "HTTP 400, type image_generation_user_error, request req_123");
		assert(isImageGenerationApiError(other));
		assert.equal(other.apiType, undefined);
		assert.equal(other.apiCode, "content_policy_violation");
		assert.equal(other.detail, "HTTP 400, code content_policy_violation, request req_123");
	});

	it("reads moderation details defensively (#4332)", async () => {
		const { fetch } = mockFetch(() =>
			apiError(400, {
				type: "image_generation_user_error",
				code: "moderation_blocked",
				moderation_details: { moderation_stage: "sideways", categories: ["sexual", 7] },
			}),
		);

		const result = await run(flare, textContext, {}, fetch);

		const error = errorOf(result);
		assert(isImageModerationBlockedError(error));
		assert.equal(error.moderationStage, undefined);
		assert.deepEqual(error.categories, ["sexual"]);
		assert.equal(result.error?.fields.moderationStage, undefined);
		assert.deepEqual(result.error?.fields.categories, ["sexual"]);
	});

	it("maps a moderation_blocked error without details to an empty category list (#4332)", async () => {
		const { fetch } = mockFetch(() =>
			apiError(400, { type: "image_generation_user_error", code: "moderation_blocked" }),
		);

		const result = await run(flare, textContext, {}, fetch);

		const error = errorOf(result);
		assert(isImageModerationBlockedError(error));
		assert.deepEqual(error.categories, []);
		assert.equal(error.moderationStage, undefined);
		assert.deepEqual(result.error?.fields.categories, []);
		assert.equal(result.error?.fields.moderationStage, undefined);
	});

	it.each(["output", "unknown"] as const)("carries the %s moderation stage (#4332)", async (stage) => {
		const { fetch } = mockFetch(() =>
			apiError(400, {
				type: "image_generation_user_error",
				code: "moderation_blocked",
				moderation_details: { moderation_stage: stage, categories: [] },
			}),
		);

		const result = await run(flare, textContext, {}, fetch);

		const error = errorOf(result);
		assert(isImageModerationBlockedError(error));
		assert.equal(error.moderationStage, stage);
		assert.equal(result.error?.fields.moderationStage, stage);
	});

	it("maps other image_generation_user_error codes to ImageGenerationUserError (#4332)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(400, { type: "image_generation_user_error", code: "invalid_markup_dimensions" }),
		);

		const result = await run(flare, textContext, { maxRetries: 2, maxRetryDelayMs: 1 }, fetch);

		const error = errorOf(result);
		assert(isImageGenerationUserError(error));
		assert(!isImageModerationBlockedError(error));
		assert(error instanceof ImageGenerationUserError);
		assert.equal(error.code, "user-error");
		assert.equal(error.apiCode, "invalid_markup_dimensions");
		assert.equal(error.retryable, false);
		assert.equal(requests.length, 1);
	});

	it("keeps quota errors non-retryable even as HTTP 429 (#4332)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(429, { type: "insufficient_quota", code: "insufficient_quota" }, { "retry-after-ms": "1" }),
		);

		const result = await run(flare, textContext, { maxRetries: 3, maxRetryDelayMs: 1 }, fetch);

		assert.equal(requests.length, 1);
		const error = errorOf(result);
		assert(isImageGenerationQuotaError(error));
		assert(!isImageGenerationRateLimitError(error));
		assert.equal(error.code, "quota-exceeded");
		assert.equal(error.status, 429);
		assert.equal(error.retryable, false);
	});

	it.each([
		["error.code", { type: "requests", code: "insufficient_quota" }],
		["error.type", { type: "insufficient_quota", code: "billing" }],
	])("recognizes a quota error from %s alone and does not retry it (#4332)", async (_source, error) => {
		const { fetch, requests } = mockFetch(() => apiError(429, error, { "retry-after-ms": "1" }));

		const result = await run(flare, textContext, { maxRetries: 2, maxRetryDelayMs: 50 }, fetch);

		assert(isImageGenerationQuotaError(errorOf(result)));
		assert.equal(requests.length, 1);
	});

	it("keeps the typed error when the provider asks for a longer wait than allowed (#4332)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(429, { type: "requests", code: "rate_limit_exceeded" }, { "retry-after-ms": "60000" }),
		);

		const result = await run(flare, textContext, { maxRetries: 2, maxRetryDelayMs: 10 }, fetch);

		assert.equal(requests.length, 1);
		const error = errorOf(result);
		assert(isImageGenerationRateLimitError(error));
		assert.equal(error.status, 429);
		assert.equal(error.retryable, true);
	});

	it("does not call HTTP 499 a server error (#4332)", async () => {
		const { fetch } = mockFetch(() => apiError(499, { type: "client_closed" }));

		const error = errorOf(await run(flare, textContext, {}, fetch));

		assert(isImageGenerationApiError(error));
		assert(!isImageGenerationServerError(error));
		assert.equal(error.retryable, false);
	});

	it("keeps rate-limit errors retryable and retries them when asked (#4332)", async () => {
		const { fetch, requests } = mockFetch((call) =>
			call < 3
				? apiError(429, { type: "requests", code: "rate_limit_exceeded" }, { "retry-after-ms": "1" })
				: okResponse(),
		);

		const recovered = await run(flare, textContext, { maxRetries: 2, maxRetryDelayMs: 50 }, fetch);
		const failing = mockFetch(() =>
			apiError(429, { type: "requests", code: "rate_limit_exceeded" }, { "retry-after-ms": "1" }),
		);
		const exhausted = await run(flare, textContext, { maxRetries: 1, maxRetryDelayMs: 50 }, failing.fetch);

		assert.equal(recovered.stopReason, "stop");
		assert.equal(requests.length, 3);
		assert.equal(failing.requests.length, 2);
		const error = errorOf(exhausted);
		assert(isImageGenerationRateLimitError(error));
		assert.equal(error.code, "rate-limited");
		assert.equal(error.retryable, true);
		assert.equal(isRetryableImageGenerationError(error), true);
	});

	it("keeps server errors retryable and retries them when asked (#4332)", async () => {
		const { fetch, requests } = mockFetch((call) =>
			call === 1 ? apiError(503, { type: "server_error" }, { "retry-after-ms": "1" }) : okResponse(),
		);
		const failing = mockFetch(() => apiError(500, { type: "server_error" }, { "retry-after-ms": "1" }));

		const recovered = await run(flare, textContext, { maxRetries: 1, maxRetryDelayMs: 50 }, fetch);
		const exhausted = await run(flare, textContext, {}, failing.fetch);

		assert.equal(recovered.stopReason, "stop");
		assert.equal(requests.length, 2);
		assert.equal(failing.requests.length, 1);
		const error = errorOf(exhausted);
		assert(isImageGenerationServerError(error));
		assert.equal(error.code, "server-error");
		assert.equal(error.status, 500);
		assert.equal(error.retryable, true);
	});

	it("maps other HTTP failures to ImageGenerationApiError without retry (#4332)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(401, { type: "invalid_request_error", code: "invalid_api_key" }),
		);

		const result = await run(flare, textContext, { maxRetries: 2, maxRetryDelayMs: 1 }, fetch);

		const error = errorOf(result);
		assert(isImageGenerationApiError(error));
		assert(!isImageGenerationUserError(error));
		assert(!isImageGenerationQuotaError(error));
		assert(!isImageGenerationServerError(error));
		assert.equal(error.code, "api-error");
		assert.equal(error.status, 401);
		assert.equal(error.detail, "HTTP 401, type invalid_request_error, code invalid_api_key");
		assert.equal(error.apiCode, "invalid_api_key");
		assert.equal(error.retryable, false);
		assert.equal(requests.length, 1);
	});

	it.each([408, 409])("treats HTTP %i as retryable (#4332)", async (status) => {
		const { fetch } = mockFetch(() => apiError(status, { type: "invalid_request_error" }));

		const error = errorOf(await run(flare, textContext, {}, fetch));

		assert(isImageGenerationApiError(error));
		assert.equal(error.retryable, true);
	});

	it("maps a connection failure to a retryable ImageGenerationApiError without a status (#4332)", async () => {
		const { fetch } = mockFetch(() => {
			throw new TypeError("fetch failed");
		});

		const result = await run(flare, textContext, {}, fetch);

		const error = errorOf(result);
		assert(isImageGenerationApiError(error));
		assert.equal(error.status, undefined);
		assert.equal(error.retryable, true);
		assert.equal(error.detail, "no HTTP response");
		assert.deepEqual(result.error?.cause, { name: "APIConnectionError", message: "[foreign error message omitted]" });
	});

	it("maps a client timeout to ImageGenerationTimeoutError (#4332)", async () => {
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});

		const result = await run(flare, textContext, { timeoutMs: 20 }, fetch);

		const error = errorOf(result);
		assert(isImageGenerationTimeoutError(error));
		assert.equal(error.code, "timeout");
		assert.equal(error.timeoutMs, 20);
		assert.equal(error.phase, "request");
		assert.ok(error.elapsedMs >= 0 && error.elapsedMs < 10_000);
		assert.equal(error.retryable, true);
		assert.deepEqual(result.error?.cause, {
			name: "APIConnectionTimeoutError",
			message: "[foreign error message omitted]",
		});
	});

	it("retries a client timeout when asked and types a connection failure as an api error (#4332)", async () => {
		const attempts: number[] = [];
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				attempts.push(attempts.length);
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});

		const retried = await run(flare, textContext, { timeoutMs: 20, maxRetries: 1, maxRetryDelayMs: 10 }, fetch);
		const failed = await generateImages(flare, textContext, {
			apiKey: "sk-test",
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});

		assert.equal(attempts.length, 2);
		assert(isImageGenerationTimeoutError(errorOf(retried)));
		assert(isImageGenerationApiError(errorOf(failed)));
	});

	it("reports cancellation as aborted without a typed error (#4332)", async () => {
		const controller = new AbortController();
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				controller.abort();
			});

		const result = await run(flare, textContext, { signal: controller.signal }, fetch);

		assert.equal(result.stopReason, "aborted");
		assert.equal(result.error, undefined);
	});

	it("leaves failures it cannot classify untyped (#4332)", async () => {
		const result = await generateImages(flare, textContext, { fetch: mockFetch().fetch });

		assert.equal(result.stopReason, "error");
		assert.equal(result.error, undefined);
	});

	it("does not expose foreign cause messages from a typed hook failure (#4332)", async () => {
		const sentinel = "PRIVATE_HOOK_PROMPT_SENTINEL";
		const typed = new ImageGenerationServerError({ detail: "HTTP 503", cause: new Error(sentinel) });
		const result = await run(
			flare,
			textContext,
			{
				onPayload: () => {
					throw typed;
				},
			},
			mockFetch().fetch,
		);

		assert.equal(result.stopReason, "error");
		assert(result.error);
		assert(isImageGenerationServerError(errorOf(result)));
		assert.equal(JSON.stringify(result).includes(sentinel), false);
		assert.equal(inspect(typed, { depth: null }).includes(sentinel), false);
		assert.equal(JSON.stringify(typed.toData()).includes(sentinel), false);
		assert.equal(String(typed.cause).includes(sentinel), false);
	});

	it("carries the typed error across a JSON round trip (#4332)", async () => {
		const { fetch } = mockFetch(() =>
			apiError(400, {
				type: "image_generation_user_error",
				code: "moderation_blocked",
				moderation_details: { moderation_stage: "output", categories: ["violence"] },
			}),
		);

		const result = await run(flare, textContext, {}, fetch);
		const revived = imageGenerationErrorFromData(JSON.parse(JSON.stringify(result)).error);

		assert(isImageModerationBlockedError(revived));
		assert.equal(revived.moderationStage, "output");
		assert.deepEqual(revived.categories, ["violence"]);
		assert.equal(revived.message, result.error?.message);
	});
});
