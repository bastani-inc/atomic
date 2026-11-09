import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { generateImages } from "../src/api/openai-images.ts";
import { DEFAULT_SVG_AUTHOR_MODEL, OPENAI_IMAGES_LIMITS } from "../src/api/openai-images-options.ts";
import {
	type ImageGenerationConfigError,
	type ImageGenerationConfigReason,
	type ImageGenerationError,
	imageGenerationErrorFromData,
	isImageGenerationApiError,
	isImageGenerationConfigError,
	isImageGenerationTimeoutError,
	isImageModerationBlockedError,
} from "../src/image-generation-error.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext } from "../src/types.ts";

const flare = builtinModels().getModelOfType("image", "openai-images", "gpt-image-2.6-flare") as ImageModel<ImageApi>;
assert(flare, "catalog has gpt-image-2.6-flare");

const textContext: ImagesContext = { input: [{ type: "text", text: "A paper lantern swinging" }] };
const svgDocument = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';

interface CapturedRequest {
	url: string;
	body: RequestInit["body"];
}

type Responder = (call: number) => Response | Promise<Response>;

function mockFetch(respond: Responder) {
	const requests: CapturedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), body: init?.body });
		return respond(requests.length);
	};
	return { fetch, requests };
}

function inSequence(...responses: Array<() => Response>): Responder {
	return (call) => {
		const respond = responses[Math.min(call, responses.length) - 1];
		assert(respond, `no response scripted for call ${call}`);
		return respond();
	};
}

function apiError(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): Response {
	return Response.json({ error: { message: "provider said no", ...error } }, { status, headers });
}

const svgModelRequired = () =>
	apiError(400, {
		message: "SVG generation requires 'svg.model'.",
		type: "invalid_request_error",
		param: "svg.model",
		code: "missing_required_parameter",
	});

const svgUnsupported = (code = "unsupported_parameter") =>
	apiError(400, { type: "invalid_request_error", param: "svg", code });

const svgOk = (extra: Record<string, unknown> = {}) =>
	Response.json({ created: 1, output_format: "svg", data: [{ b64_json: btoa(svgDocument) }], ...extra });

function jsonBody(request: CapturedRequest | undefined): Record<string, unknown> {
	assert(request);
	assert.equal(typeof request.body, "string");
	return JSON.parse(request.body as string);
}

function run(
	options: Parameters<typeof generateImages>[2],
	fetch: typeof globalThis.fetch,
	context: ImagesContext = textContext,
): Promise<AssistantImages> {
	return generateImages(flare, context, { apiKey: "sk-test", fetch, ...options });
}

function errorOf(result: AssistantImages): ImageGenerationError {
	assert(result.error, "result carries a typed error");
	return imageGenerationErrorFromData(result.error);
}

function configErrorOf(result: AssistantImages): ImageGenerationConfigError {
	const error = errorOf(result);
	assert(isImageGenerationConfigError(error), `expected a config error, got ${error.name}`);
	return error;
}

describe("SVG output without svg.model (#4615)", () => {
	it("pins the default SVG authoring model to the value observed working (#4615)", () => {
		assert.equal(DEFAULT_SVG_AUTHOR_MODEL, "gpt-6.1-sol");
	});

	it("retries once with the default SVG authoring model when the API requires svg.model (#4615)", async () => {
		const { fetch, requests } = mockFetch(inSequence(svgModelRequired, () => svgOk()));

		const result = await run({ outputFormat: "svg", quality: "low" }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(result.error, undefined);
		assert.equal(requests.length, 2);
		const base = {
			model: "gpt-image-2.6-flare",
			prompt: "A paper lantern swinging",
			quality: "low",
			output_format: "svg",
		};
		assert.deepEqual(jsonBody(requests[0]), base);
		assert.deepEqual(jsonBody(requests[1]), { ...base, svg: { model: DEFAULT_SVG_AUTHOR_MODEL } });
		assert.equal(requests[1]?.url, "https://api.openai.com/v1/images/generations");
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/svg+xml", data: btoa(svgDocument) }]);
	});

	it("reports the default model that authored the SVG (#4615)", async () => {
		const { fetch } = mockFetch(inSequence(svgModelRequired, () => svgOk()));

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.svgModel, DEFAULT_SVG_AUTHOR_MODEL);
	});

	it("reports the authoring model the API names in svg_usage over the one it sent (#4615)", async () => {
		const svgUsage = { model: "gpt-6.1-sol-2026-11-01", input_tokens: 1, output_tokens: 2, total_tokens: 3 };
		const { fetch } = mockFetch(inSequence(svgModelRequired, () => svgOk({ svg_usage: svgUsage })));

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.svgModel, "gpt-6.1-sol-2026-11-01");
	});

	it("ignores an svg_usage without a model name (#4615)", async () => {
		const { fetch } = mockFetch(inSequence(svgModelRequired, () => svgOk({ svg_usage: { model: 7 } })));

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.svgModel, DEFAULT_SVG_AUTHOR_MODEL);
	});

	it("falls back to the model it sent when svg_usage names an empty model (#4615)", async () => {
		const { fetch } = mockFetch(inSequence(svgModelRequired, () => svgOk({ svg_usage: { model: "" } })));

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.svgModel, DEFAULT_SVG_AUTHOR_MODEL);
	});

	it("types an output format it does not know as image/png (#4615)", async () => {
		const { fetch } = mockFetch(() => svgOk({ output_format: "tiff" }));

		const result = await run({ outputFormat: "svg", svg: { model: "gpt-6-luna" } }, fetch);

		assert.equal(result.output[0]?.type === "image" ? result.output[0].mimeType : undefined, "image/png");
	});

	it("reports an unparseable success response the same for SVG and PNG requests (#4615)", async () => {
		const unparseable = () =>
			new Response("<html>not json</html>", { headers: { "content-type": "application/json" } });
		const svg = await run({ outputFormat: "svg" }, mockFetch(unparseable).fetch);
		const png = await run({ outputFormat: "png" }, mockFetch(unparseable).fetch);

		assert.equal(svg.stopReason, "error");
		assert.equal(svg.error, undefined);
		assert.equal(svg.errorMessage, png.errorMessage);
	});

	it("sends one request and reports no model on accounts that accept SVG without svg.model (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgOk());

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 1);
		assert.equal("svg" in jsonBody(requests[0]), false);
		assert.equal("svgModel" in result, false);
	});

	it("does not retry an svg request that fails for another reason (#4615)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(400, { type: "invalid_request_error", code: "bad_request" }),
		);

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(requests.length, 1);
		assert.equal(result.stopReason, "error");
		assert(isImageGenerationApiError(errorOf(result)));
	});

	it.each([
		["png", { outputFormat: "png" as const }],
		["gif", { outputFormat: "gif" as const }],
		["no format", {}],
	])("does not retry a %s request that fails for svg.model (#4615)", async (_name, options) => {
		const { fetch, requests } = mockFetch(() => svgModelRequired());

		const result = await run(options, fetch);

		assert.equal(requests.length, 1);
		assert.equal(result.stopReason, "error");
		assert.equal("svg" in jsonBody(requests[0]), false);
	});

	it("never sends more than three requests when the API keeps answering with svg errors (#4615)", async () => {
		const { fetch, requests } = mockFetch(inSequence(svgModelRequired, () => svgUnsupported(), svgModelRequired));

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(requests.length, 3);
		const error = configErrorOf(result);
		assert.equal(error.field, "svg.model");
		assert.equal(error.reason, "required-by-api");
	});

	it("stops after the default-model retry when the API requires svg.model again (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgModelRequired());

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(requests.length, 2);
		const error = configErrorOf(result);
		assert.equal(error.field, "svg.model");
		assert.equal(error.reason, "required-by-api");
	});

	it("does not retry when the retry with the default model is rejected for another reason (#4615)", async () => {
		const { fetch, requests } = mockFetch(
			inSequence(svgModelRequired, () =>
				apiError(404, { type: "invalid_request_error", param: "svg.model", code: "model_not_found" }),
			),
		);

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(requests.length, 2);
		const error = configErrorOf(result);
		assert.equal(error.field, "svg.model");
		assert.equal(error.reason, "rejected-by-api");
		assert.equal(error.retryable, false);
		assert.ok(error.detail.includes(DEFAULT_SVG_AUTHOR_MODEL), error.detail);
	});

	it("keeps the aborted stop reason when the signal aborts before the default-model retry (#4615)", async () => {
		const controller = new AbortController();
		const { fetch, requests } = mockFetch(() => {
			controller.abort();
			return svgModelRequired();
		});

		const result = await run({ outputFormat: "svg", signal: controller.signal }, fetch);

		assert.equal(result.stopReason, "aborted");
		assert.equal(result.error, undefined);
		assert.equal(requests.length, 1);
	});
});

describe("retry without svg (#4615)", () => {
	it("retries once without svg when the API rejects the default svg field as unsupported (#4615)", async () => {
		const { fetch, requests } = mockFetch(
			inSequence(
				svgModelRequired,
				() => svgUnsupported(),
				() => svgOk(),
			),
		);

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 3);
		assert.deepEqual(jsonBody(requests[1]).svg, { model: DEFAULT_SVG_AUTHOR_MODEL });
		assert.equal("svg" in jsonBody(requests[2]), false);
		assert.deepEqual(jsonBody(requests[2]), jsonBody(requests[0]));
		assert.equal(result.svgModel, undefined);
		assert.equal(result.output.length, 1);
	});

	it("does not blame the default model for a rejection of the request that dropped svg (#4615)", async () => {
		const { fetch, requests } = mockFetch(
			inSequence(
				svgModelRequired,
				() => svgUnsupported(),
				() => apiError(400, { type: "invalid_request_error", param: "svg.model", code: "empty_string" }),
			),
		);

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(requests.length, 3);
		const error = configErrorOf(result);
		assert.equal(error.reason, "rejected-by-api");
		assert.equal(error.detail.includes(DEFAULT_SVG_AUTHOR_MODEL), false);
	});

	it.each([
		["unsupported_parameter", "svg"],
		["unknown_parameter", "svg"],
		["unsupported_parameter", "svg.model"],
		["unknown_parameter", "svg.model"],
	])("treats %s on %s as an unsupported svg field (#4615)", async (code, param) => {
		const { fetch, requests } = mockFetch(
			inSequence(
				svgModelRequired,
				() => apiError(400, { type: "invalid_request_error", param, code }),
				() => svgOk(),
			),
		);

		const result = await run({ outputFormat: "svg" }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 3);
		assert.equal("svg" in jsonBody(requests[2]), false);
	});
});

describe("caller-supplied svg is respected (#4615)", () => {
	it("sends a caller svg as given in one request and reports its model (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgOk());
		const svg = { model: "gpt-6-luna", reasoning: { effort: "low" as const } };

		const result = await run({ outputFormat: "svg", svg }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 1);
		assert.deepEqual(jsonBody(requests[0]).svg, svg);
		assert.equal(result.svgModel, "gpt-6-luna");
	});

	it("never replaces a rejected caller svg.model with the default (#4615)", async () => {
		const { fetch, requests } = mockFetch(() =>
			apiError(404, { type: "invalid_request_error", param: "svg.model", code: "model_not_found" }),
		);

		const result = await run({ outputFormat: "svg", svg: { model: "no-such-model" } }, fetch);

		assert.equal(requests.length, 1);
		assert.deepEqual(jsonBody(requests[0]).svg, { model: "no-such-model" });
		const error = configErrorOf(result);
		assert.equal(error.field, "svg.model");
		assert.equal(error.reason, "rejected-by-api");
		assert.equal(error.detail.includes(DEFAULT_SVG_AUTHOR_MODEL), false);
	});

	it("never drops a caller svg the API rejects as unsupported (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgUnsupported());

		const result = await run({ outputFormat: "svg", svg: { model: "gpt-6-luna" } }, fetch);

		assert.equal(requests.length, 1);
		assert.deepEqual(jsonBody(requests[0]).svg, { model: "gpt-6-luna" });
		const error = configErrorOf(result);
		assert.equal(error.field, "svg");
		assert.equal(error.reason, "unsupported-by-api");
	});

	it("does not fill in the model of a caller svg that has only reasoning (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgModelRequired());
		const svg = { reasoning: { effort: "low" } } as unknown as { model: string };

		const result = await run({ outputFormat: "svg", svg }, fetch);

		assert.equal(requests.length, 1);
		assert.deepEqual(jsonBody(requests[0]).svg, { reasoning: { effort: "low" } });
		const error = configErrorOf(result);
		assert.equal(error.field, "svg.model");
		assert.equal(error.reason, "required-by-api");
	});

	it("treats an svg an onPayload hook adds as the caller's and does not replace it (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgModelRequired());

		const result = await run(
			{
				outputFormat: "svg",
				onPayload: (payload) => ({ ...(payload as object), svg: { reasoning: { effort: "low" } } }),
			},
			fetch,
		);

		assert.equal(requests.length, 1);
		assert.equal(configErrorOf(result).reason, "required-by-api");
	});

	it("sends the first request through the onPayload hook once, before the recovery edits svg (#4615)", async () => {
		const { fetch, requests } = mockFetch(inSequence(svgModelRequired, () => svgOk()));
		const seen: unknown[] = [];

		await run({ outputFormat: "svg", onPayload: (payload) => void seen.push(structuredClone(payload)) }, fetch);

		assert.equal(requests.length, 2);
		assert.equal(seen.length, 1);
		assert.equal("svg" in (seen[0] as object), false);
	});
});

interface MappingCase {
	status: number;
	code: string | null;
	param: string;
	field: string;
	reason: ImageGenerationConfigReason;
}

const MAPPING_CASES: MappingCase[] = [
	{
		status: 400,
		code: "missing_required_parameter",
		param: "svg.model",
		field: "svg.model",
		reason: "required-by-api",
	},
	{ status: 400, code: "empty_string", param: "svg.model", field: "svg.model", reason: "rejected-by-api" },
	{ status: 404, code: "model_not_found", param: "svg.model", field: "svg.model", reason: "rejected-by-api" },
	{ status: 422, code: "invalid_value", param: "svg.model", field: "svg.model", reason: "rejected-by-api" },
	{ status: 400, code: "unsupported_parameter", param: "svg", field: "svg", reason: "unsupported-by-api" },
	{ status: 400, code: "unknown_parameter", param: "svg", field: "svg", reason: "unsupported-by-api" },
	{ status: 400, code: "unsupported_parameter", param: "svg.model", field: "svg.model", reason: "unsupported-by-api" },
];

describe("svg API errors map to typed invalid-option errors (#4615)", () => {
	it.each(MAPPING_CASES)(
		"maps HTTP $status $code on $param to invalid-option $field $reason (#4615)",
		async ({ status, code, param, field, reason }) => {
			const { fetch, requests } = mockFetch(() =>
				apiError(status, { type: "invalid_request_error", param, code }, { "x-request-id": "req_4615" }),
			);

			const result = await run({ outputFormat: "svg", svg: { model: "gpt-6-luna" } }, fetch);

			assert.equal(requests.length, 1);
			assert.equal(result.stopReason, "error");
			const error = configErrorOf(result);
			assert.equal(error.code, "invalid-option");
			assert.equal(error.name, "ImageGenerationConfigError");
			assert.equal(error.source, "sdk");
			assert.equal(error.field, field);
			assert.equal(error.reason, reason);
			assert.equal(error.model, "gpt-image-2.6-flare");
			assert.equal(error.related, undefined);
			assert.equal(error.retryable, false);
			assert.ok(error.hint && error.hint.length > 10);
			assert.ok(error.detail.includes(field), error.detail);
			assert.equal(error.message.includes("provider said no"), false);
			assert.ok(error.detail.includes("req_4615"), error.detail);
			assert.ok(error.detail.includes(`HTTP ${status}`), error.detail);
		},
	);

	it("gives each reason its own hint (#4615)", async () => {
		const hints = new Map<ImageGenerationConfigReason, Set<string | undefined>>();
		for (const { status, code, param, reason } of MAPPING_CASES) {
			const { fetch } = mockFetch(() => apiError(status, { type: "invalid_request_error", param, code }));
			const error = configErrorOf(await run({ outputFormat: "svg", svg: { model: "gpt-6-luna" } }, fetch));
			hints.set(reason, (hints.get(reason) ?? new Set()).add(error.hint));
		}

		assert.deepEqual([...hints.keys()].sort(), ["rejected-by-api", "required-by-api", "unsupported-by-api"]);
		for (const [reason, forReason] of hints) assert.equal(forReason.size, 1, reason);
		assert.equal(new Set([...hints.values()].flatMap((forReason) => [...forReason])).size, 3);
	});

	it("keeps the provider message that can quote the prompt out of the typed error (#4615)", async () => {
		const { fetch } = mockFetch(() =>
			apiError(
				400,
				{
					message: "Your request was rejected: SECRET-PROMPT-4615",
					type: "invalid_request_error",
					param: "svg.model",
					code: "empty_string",
				},
				{ "x-request-id": "req_4615" },
			),
		);

		const result = await run({ outputFormat: "svg", svg: { model: "x" } }, fetch);

		assert(result.error);
		assert.equal(JSON.stringify(result.error).includes("SECRET-PROMPT"), false);
		assert.deepEqual(result.error.cause, { name: "APIError", message: "[foreign error message omitted]" });
		const error = configErrorOf(result);
		assert(error.cause instanceof Error);
		assert.equal(error.cause.name, "APIError");
	});

	it("carries the typed svg error across a JSON round trip (#4615)", async () => {
		const { fetch } = mockFetch(() => svgModelRequired());

		const result = await run({ outputFormat: "svg", svg: { reasoning: {} } as never }, fetch);
		const revived = imageGenerationErrorFromData(JSON.parse(JSON.stringify(result)).error);

		assert(isImageGenerationConfigError(revived));
		assert.equal(revived.field, "svg.model");
		assert.equal(revived.reason, "required-by-api");
		assert.equal(revived.model, "gpt-image-2.6-flare");
		assert.equal(revived.hint, configErrorOf(result).hint);
		assert.equal(revived.message, result.error?.message);
	});

	it.each([
		["another parameter", { status: 400, param: "prompt", code: "missing_required_parameter" }],
		["no parameter", { status: 400, param: undefined, code: "missing_required_parameter" }],
		["svg without a code", { status: 400, param: "svg", code: null }],
		["svg with an unrelated code", { status: 400, param: "svg", code: "empty_string" }],
		["a missing svg field", { status: 400, param: "svg", code: "missing_required_parameter" }],
		["an svg subfield", { status: 400, param: "svg.reasoning", code: "unsupported_parameter" }],
		["a look-alike parameter", { status: 400, param: "svg.models", code: "missing_required_parameter" }],
		["a server failure", { status: 500, param: "svg.model", code: "missing_required_parameter" }],
		["a rate limit", { status: 429, param: "svg.model", code: "missing_required_parameter" }],
		["an auth failure", { status: 401, param: "svg.model", code: "missing_required_parameter" }],
	])("leaves a failure with %s as a generic API error (#4615)", async (_name, { status, param, code }) => {
		const { fetch, requests } = mockFetch(() => apiError(status, { type: "invalid_request_error", param, code }));

		const result = await run({ outputFormat: "svg", svg: { model: "gpt-6-luna" } }, fetch);

		assert.equal(requests.length, 1);
		assert(result.error);
		const error = errorOf(result);
		assert(!isImageGenerationConfigError(error));
		assert(isImageGenerationApiError(error));
	});

	it("keeps a moderation block on svg.model typed as moderation, not as an option error (#4615)", async () => {
		const { fetch } = mockFetch(() =>
			apiError(400, {
				type: "image_generation_user_error",
				param: "svg.model",
				code: "moderation_blocked",
				moderation_details: { moderation_stage: "input", categories: ["violence"] },
			}),
		);

		const result = await run({ outputFormat: "svg", svg: { model: "gpt-6-luna" } }, fetch);

		assert(isImageModerationBlockedError(errorOf(result)));
	});

	it("renders the message of a missing svg.model from its fields as a UX contract (#4615)", async () => {
		const { fetch } = mockFetch(() => svgModelRequired());

		const result = await run({ outputFormat: "svg", svg: { reasoning: {} } as never }, fetch);

		assert.equal(
			configErrorOf(result).message,
			'Invalid image generation option: svg.model for gpt-image-2.6-flare (invalid-option). the API requires svg.model for SVG output on this account (HTTP 400, type invalid_request_error, code missing_required_parameter). Set svg.model to an SVG authoring model your account can use, for example svg: { model: "gpt-6.1-sol" }.',
		);
	});
});

describe("SVG authoring time limits (#4615)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function delayedFetch(delayMs: number, respond: Responder): typeof globalThis.fetch {
		let calls = 0;
		return (_input, init) =>
			new Promise((resolve, reject) => {
				const call = ++calls;
				const timer = setTimeout(() => resolve(respond(call)), delayMs);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new DOMException("aborted", "AbortError"));
				});
			});
	}

	it("lets an SVG request take five minutes under the default timeout (#4615)", async () => {
		vi.useFakeTimers();
		const fetch = delayedFetch(300_000, () => svgOk());

		const pending = run({ outputFormat: "svg", svg: { model: DEFAULT_SVG_AUTHOR_MODEL } }, fetch);
		await vi.advanceTimersByTimeAsync(300_000);
		const result = await pending;

		assert.equal(result.stopReason, "stop");
		assert.equal(result.output.length, 1);
	});

	it("applies a ten-minute default timeout to a request that never answers (#4615)", async () => {
		vi.useFakeTimers();
		const fetch = delayedFetch(2 ** 30, () => svgOk());
		let settled = false;

		const pending = run({ outputFormat: "svg", svg: { model: DEFAULT_SVG_AUTHOR_MODEL } }, fetch).finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(599_999);
		assert.equal(settled, false);
		await vi.advanceTimersByTimeAsync(1);
		const result = await pending;

		const error = errorOf(result);
		assert(isImageGenerationTimeoutError(error));
		assert.equal(error.timeoutMs, 600_000);
	});

	it("gives the default-model retry its own full timeout (#4615)", async () => {
		vi.useFakeTimers();
		const fetch = delayedFetch(40_000, (call) => (call === 1 ? svgModelRequired() : svgOk()));

		const pending = run({ outputFormat: "svg", timeoutMs: 60_000 }, fetch);
		await vi.advanceTimersByTimeAsync(80_000);
		const result = await pending;

		assert.equal(result.stopReason, "stop");
		assert.equal(result.svgModel, DEFAULT_SVG_AUTHOR_MODEL);
	});

	it("still times out a caller-set timeoutMs that is too short for the SVG (#4615)", async () => {
		vi.useFakeTimers();
		const fetch = delayedFetch(46_000, () => svgOk());

		const pending = run({ outputFormat: "svg", svg: { model: DEFAULT_SVG_AUTHOR_MODEL }, timeoutMs: 30_000 }, fetch);
		await vi.advanceTimersByTimeAsync(30_000);
		const result = await pending;

		const error = errorOf(result);
		assert(isImageGenerationTimeoutError(error));
		assert.equal(error.timeoutMs, 30_000);
	});
});

describe("GIF output (#4615)", () => {
	const gifOk = () => Response.json({ created: 1, output_format: "gif", data: [{ b64_json: "R0lGODlh" }] });

	it("requests a four-frame GIF and types the output image/gif (#4615)", async () => {
		const { fetch, requests } = mockFetch(gifOk);

		const result = await run(
			{ outputFormat: "gif", frameCount: 4, frameDurationMs: 250, size: "512x512", quality: "low" },
			fetch,
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 1);
		assert.deepEqual(jsonBody(requests[0]), {
			model: "gpt-image-2.6-flare",
			prompt: "A paper lantern swinging",
			size: "512x512",
			quality: "low",
			output_format: "gif",
			frame_count: 4,
			frame_duration_ms: 250,
		});
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/gif", data: "R0lGODlh" }]);
		assert.equal("svgModel" in result, false);
	});

	it("requests a GIF with the API defaults when no frame options are set (#4615)", async () => {
		const { fetch, requests } = mockFetch(gifOk);

		const result = await run({ outputFormat: "gif" }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal("frame_count" in jsonBody(requests[0]), false);
		assert.equal("frame_duration_ms" in jsonBody(requests[0]), false);
	});

	const { gifFrameCount, gifFrameDurationMs } = OPENAI_IMAGES_LIMITS;

	it.each([
		["frameCount", gifFrameCount.min, "frame_count"],
		["frameCount", gifFrameCount.max, "frame_count"],
		["frameDurationMs", gifFrameDurationMs.min, "frame_duration_ms"],
		["frameDurationMs", gifFrameDurationMs.max, "frame_duration_ms"],
	] as const)("sends %s of %i, a documented bound (#4615)", async (option, value, wireField) => {
		const { fetch, requests } = mockFetch(gifOk);

		const result = await run({ outputFormat: "gif", [option]: value }, fetch);

		assert.equal(result.stopReason, "stop");
		assert.equal(jsonBody(requests[0])[wireField], value);
	});

	it("documents 2-16 frames and 20-2000 ms per frame (#4615)", () => {
		assert.deepEqual(gifFrameCount, { min: 2, max: 16 });
		assert.deepEqual(gifFrameDurationMs, { min: 20, max: 2000 });
	});

	it.each([
		["frameCount", gifFrameCount.min - 1],
		["frameCount", gifFrameCount.max + 1],
		["frameCount", 0],
		["frameCount", -4],
		["frameCount", 4.5],
		["frameCount", Number.NaN],
		["frameCount", Number.POSITIVE_INFINITY],
		["frameDurationMs", gifFrameDurationMs.min - 1],
		["frameDurationMs", gifFrameDurationMs.max + 1],
		["frameDurationMs", 0],
		["frameDurationMs", 250.5],
		["frameDurationMs", Number.NaN],
	] as const)("rejects %s of %s before sending anything (#4615)", async (option, value) => {
		const { fetch, requests } = mockFetch(gifOk);

		const result = await run({ outputFormat: "gif", [option]: value }, fetch);

		assert.equal(requests.length, 0);
		assert.equal(result.stopReason, "error");
		const error = configErrorOf(result);
		assert.equal(error.field, option);
		assert.equal(error.reason, "out-of-range");
		assert.equal(error.model, "gpt-image-2.6-flare");
		assert.equal(error.retryable, false);
	});

	it.each([
		["frameCount", 4],
		["frameDurationMs", 250],
	] as const)("requires GIF output for %s, also with svg output (#4615)", async (option, value) => {
		const { fetch, requests } = mockFetch(gifOk);

		const result = await run({ outputFormat: "svg", [option]: value }, fetch);

		assert.equal(requests.length, 0);
		const error = configErrorOf(result);
		assert.equal(error.field, option);
		assert.equal(error.reason, "requires-option");
		assert.equal(error.related, "outputFormat");
	});

	it("rejects GIF output that combines with svg options before sending (#4615)", async () => {
		const { fetch, requests } = mockFetch(gifOk);

		const result = await run({ outputFormat: "gif", svg: { model: DEFAULT_SVG_AUTHOR_MODEL } }, fetch);

		assert.equal(requests.length, 0);
		const error = configErrorOf(result);
		assert.equal(error.field, "svg");
		assert.equal(error.reason, "requires-option");
	});

	it("does not retry a failed GIF request, whatever the API says about svg (#4615)", async () => {
		const { fetch, requests } = mockFetch(() => svgModelRequired());

		const result = await run({ outputFormat: "gif", frameCount: 4 }, fetch);

		assert.equal(requests.length, 1);
		assert.equal(result.stopReason, "error");
		assert.equal("svg" in jsonBody(requests[0]), false);
	});
});
