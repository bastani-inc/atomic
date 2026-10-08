import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

const context = normalizeContext({
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
});

function ultrafastVariant(baseModelId: "gpt-5.6-sol" | "gpt-6.1-sol"): Model<"openai-responses"> {
	return {
		...getModel("openai", baseModelId),
		id: `${baseModelId}-ultrafast`,
		fastRoute: { baseModelId, upstreamModelId: baseModelId, serviceTier: "ultrafast" },
	};
}

function fastVariant(baseModelId: "gpt-5.6-sol" | "gpt-6.1-sol"): Model<"openai-responses"> {
	return {
		...getModel("openai", baseModelId),
		id: `${baseModelId}-fast`,
		fastRoute: { baseModelId, upstreamModelId: baseModelId, serviceTier: "priority" },
	};
}

function completedResponse(serviceTier: string | undefined): Response {
	const sse = `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			status: "completed",
			service_tier: serviceTier,
			usage: {
				input_tokens: 100_000,
				output_tokens: 10_000,
				total_tokens: 110_000,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}\n\n`;
	return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rejection(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: null } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A streamed request the Responses API refuses after HTTP 200, the way it rejects an unsupported service_tier. */
function streamedRejection(message: string, param: string | null): Response {
	const response = { id: "resp_1", object: "response", status: "in_progress", service_tier: "ultrafast", output: [] };
	const events = [
		{ type: "response.created", response, sequence_number: 0 },
		{ type: "response.in_progress", response, sequence_number: 1 },
		{ type: "error", error: { type: "invalid_request_error", code: null, message, param }, sequence_number: 2 },
		{
			type: "response.failed",
			response: { ...response, status: "failed", error: { code: "unknown", message } },
			sequence_number: 3,
		},
	];
	const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A token shaped like an `openai` ChatGPT sign-in access token: a JWT whose auth claim has no account ID. */
function chatGPTSignInToken(): string {
	const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
	const claims = { "https://api.openai.com/auth": { per_user_salt: "salt" } };
	return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

/** A streamed request that fails with a nested tier error in `response.failed` and no top-level `error` event. */
function failedResponseRejection(message: string): Response {
	const response = { id: "resp_1", object: "response", status: "in_progress", service_tier: "ultrafast", output: [] };
	const events = [
		{ type: "response.created", response, sequence_number: 0 },
		{
			type: "response.failed",
			response: { ...response, status: "failed", error: { code: "invalid_request_error", message } },
			sequence_number: 1,
		},
	];
	const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function serviceTierWarnings(message: AssistantMessage): string[] {
	return (message.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "service_tier_unavailable")
		.map((diagnostic) => String(diagnostic.details?.message));
}

type RequestAuth = { apiKey: string } | { headers: Record<string, string> };

async function run(
	model: Model<"openai-responses">,
	responses: Response[],
	auth: string | RequestAuth = "sk-test-key",
) {
	const { result, payloads } = await runRecordingOrder(model, responses, auth);
	return { result, payloads };
}

/** Run a request and record `onResponse` calls interleaved with the stream's start, done, and error events. */
async function runRecordingOrder(
	model: Model<"openai-responses">,
	responses: Response[],
	auth: string | RequestAuth = "sk-test-key",
) {
	const payloads: Array<{ model?: string; service_tier?: string }> = [];
	const order: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		payloads.push(JSON.parse(String(init?.body)) as { model?: string; service_tier?: string });
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		return next;
	});
	const events = streamOpenAIResponses(model, context, {
		...(typeof auth === "string" ? { apiKey: auth } : auth),
		onResponse: (response) => {
			order.push(`onResponse:${response.status}`);
		},
	});
	for await (const event of events) {
		if (event.type === "start" || event.type === "done" || event.type === "error") order.push(event.type);
	}
	const result = await events.result();
	return { result, payloads, order };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("catalog ultrafast tiers (#3529)", () => {
	test("gpt-6.1-sol and gpt-5.6-sol advertise ultrafast next to priority on openai (#3529)", () => {
		for (const id of ["gpt-6.1-sol", "gpt-5.6-sol"] as const) {
			const tierIds = getModel("openai", id).serviceTiers?.map((tier) => tier.id);
			assert.deepEqual(tierIds, ["priority", "ultrafast"]);
		}
	});

	test("openai-codex advertises ultrafast for gpt-6.1-sol but only priority for gpt-5.6-sol (#3529)", () => {
		assert.deepEqual(
			getModel("openai-codex", "gpt-6.1-sol").serviceTiers?.map((tier) => tier.id),
			["priority", "ultrafast"],
		);
		assert.deepEqual(
			getModel("openai-codex", "gpt-5.6-sol").serviceTiers?.map((tier) => tier.id),
			["priority"],
		);
	});
});

describe("service tier rejection (#3529)", () => {
	test("retries once at the default tier and warns when ultrafast is rejected (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			rejection(400, "Invalid service_tier argument"),
			completedResponse("default"),
		]);

		assert.equal(result.stopReason, "stop");
		assert.equal(payloads.length, 2);
		assert.equal(payloads[0]?.service_tier, "ultrafast");
		assert.equal(payloads[1]?.service_tier, undefined);
		assert.equal(payloads[1]?.model, "gpt-5.6-sol");
		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-5.6-sol on this account; ran at default",
		]);
	});

	test("prices the retried request at the default tier (#3529)", async () => {
		const model = ultrafastVariant("gpt-5.6-sol");
		const { result } = await run(model, [
			rejection(400, "Invalid service_tier argument"),
			completedResponse("default"),
		]);

		assert.ok(Math.abs(result.usage.cost.input - (100_000 / 1_000_000) * model.cost.input) < 1e-9);
		assert.ok(Math.abs(result.usage.cost.output - (10_000 / 1_000_000) * model.cost.output) < 1e-9);
	});

	test("retries a rejected fast tier once at the default tier and names it fast (#3529)", async () => {
		const { result, payloads } = await run(fastVariant("gpt-6.1-sol"), [
			rejection(400, "Invalid service_tier argument"),
			completedResponse(undefined),
		]);

		assert.equal(result.stopReason, "stop");
		assert.equal(payloads.length, 2);
		assert.equal(payloads[1]?.service_tier, undefined);
		assert.deepEqual(serviceTierWarnings(result), [
			"fast isn't available for gpt-6.1-sol on this account; ran at default",
		]);
	});

	test("retries once at the default tier when a streamed response rejects ultrafast after HTTP 200 (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			streamedRejection("Invalid service_tier argument", "service_tier"),
			completedResponse("default"),
		]);

		assert.equal(result.stopReason, "stop");
		assert.equal(payloads.length, 2);
		assert.equal(payloads[0]?.service_tier, "ultrafast");
		assert.equal(payloads[1]?.service_tier, undefined);
		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-5.6-sol on this account; ran at default",
		]);
	});

	test("retries at the default tier when response.failed carries the tier rejection before any output (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			failedResponseRejection("Invalid service_tier argument"),
			completedResponse("default"),
		]);

		assert.equal(payloads.length, 2);
		assert.equal(payloads[1]?.service_tier, undefined);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-5.6-sol on this account; ran at default",
		]);
	});

	test("does not retry a response.failed that is not about the service tier (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			failedResponseRejection("The server had an error processing your request"),
		]);

		assert.equal(payloads.length, 1);
		assert.equal(result.stopReason, "error");
	});

	test("does not retry a streamed error that is not about the service tier (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			streamedRejection("Invalid value for 'input'", "input"),
		]);

		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 1);
		assert.deepEqual(serviceTierWarnings(result), []);
	});

	test("does not retry a second time when the default-tier request also fails (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			rejection(400, "Invalid service_tier argument"),
			rejection(400, "Invalid service_tier argument"),
		]);

		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 2);
		assert.equal(payloads[1]?.service_tier, undefined);
	});

	test("does not claim the request ran at default when the default-tier retry fails (#3529)", async () => {
		for (const firstAttempt of [
			rejection(400, "Invalid service_tier argument"),
			streamedRejection("Invalid service_tier argument", "service_tier"),
		]) {
			const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
				firstAttempt,
				rejection(400, "Invalid value for 'input'"),
			]);

			assert.equal(result.stopReason, "error");
			assert.equal(payloads.length, 2);
			assert.deepEqual(serviceTierWarnings(result), []);
			vi.restoreAllMocks();
		}
	});

	test("does not retry a 400 that is not about the service tier (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			rejection(400, "Invalid value for 'input'"),
		]);

		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 1);
		assert.deepEqual(serviceTierWarnings(result), []);
	});

	test("does not retry a service tier error that is not a 400 (#3529)", async () => {
		const { result, payloads } = await run(ultrafastVariant("gpt-5.6-sol"), [
			rejection(403, "service_tier ultrafast is not permitted"),
		]);

		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 1);
	});

	test("does not retry a request that sent no service tier (#3529)", async () => {
		const { result, payloads } = await run(getModel("openai", "gpt-5.6-sol"), [
			rejection(400, "Invalid service_tier argument"),
		]);

		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 1);
	});
});

describe("provider response hook ordering (#3529)", () => {
	test("calls onResponse and emits start before a 200 stream's early error that is not about the tier (#3529)", async () => {
		const { result, payloads, order } = await runRecordingOrder(ultrafastVariant("gpt-5.6-sol"), [
			streamedRejection("Rate limit reached for requests", null),
		]);

		assert.deepEqual(order, ["onResponse:200", "start", "error"]);
		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 1);
	});

	test("calls onResponse for both attempts and emits start once when a streamed tier rejection is retried (#3529)", async () => {
		const { result, payloads, order } = await runRecordingOrder(ultrafastVariant("gpt-5.6-sol"), [
			streamedRejection("Invalid service_tier argument", "service_tier"),
			completedResponse("default"),
		]);

		assert.deepEqual(order, ["onResponse:200", "start", "onResponse:200", "done"]);
		assert.equal(result.stopReason, "stop");
		assert.equal(payloads.length, 2);
		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-5.6-sol on this account; ran at default",
		]);
	});
});

describe("reported service tier downgrade (#3529)", () => {
	test("warns when ultrafast is reported as default and prices at the default rates (#3529)", async () => {
		const model = ultrafastVariant("gpt-6.1-sol");
		const { result, payloads } = await run(model, [completedResponse("default")]);

		assert.equal(payloads.length, 1);
		assert.equal(payloads[0]?.service_tier, "ultrafast");
		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-6.1-sol on this account; ran at default",
		]);
		assert.ok(Math.abs(result.usage.cost.input - (100_000 / 1_000_000) * model.cost.input) < 1e-9);
	});

	test("does not warn on a ChatGPT sign-in reporting default and prices at the requested tier (#3529)", async () => {
		for (const model of [fastVariant("gpt-6.1-sol"), ultrafastVariant("gpt-6.1-sol")]) {
			const { result, payloads } = await run(model, [completedResponse("default")], chatGPTSignInToken());
			const requested = model.serviceTiers?.find((tier) => tier.id === model.fastRoute?.serviceTier);

			assert.equal(payloads[0]?.service_tier, model.fastRoute?.serviceTier);
			assert.deepEqual(serviceTierWarnings(result), []);
			assert.ok(requested);
			assert.ok(Math.abs(result.usage.cost.input - (100_000 / 1_000_000) * requested.cost.input) < 1e-9);
		}
	});

	test("does not warn when the ChatGPT sign-in token arrives only in the Authorization header (#3529)", async () => {
		const { result } = await run(ultrafastVariant("gpt-6.1-sol"), [completedResponse("default")], {
			headers: { Authorization: `Bearer ${chatGPTSignInToken()}` },
		});

		assert.deepEqual(serviceTierWarnings(result), []);
	});

	test("still retries at default with a warning when a ChatGPT sign-in rejects the tier (#3529)", async () => {
		const { result, payloads } = await run(
			ultrafastVariant("gpt-5.6-sol"),
			[rejection(400, "Unsupported service_tier: ultrafast"), completedResponse("default")],
			chatGPTSignInToken(),
		);

		assert.equal(payloads.length, 2);
		assert.equal(payloads[1]?.service_tier, undefined);
		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-5.6-sol on this account; ran at default",
		]);
	});

	test("warns when a fast model is reported at the default tier (#3529)", async () => {
		const { result } = await run(fastVariant("gpt-5.6-sol"), [completedResponse("default")]);

		assert.deepEqual(serviceTierWarnings(result), [
			"fast isn't available for gpt-5.6-sol on this account; ran at default",
		]);
	});

	test("warns when ultrafast is served at the fast tier (#3529)", async () => {
		const { result } = await run(ultrafastVariant("gpt-6.1-sol"), [completedResponse("fast")]);

		assert.deepEqual(serviceTierWarnings(result), [
			"ultrafast isn't available for gpt-6.1-sol on this account; ran at fast",
		]);
	});

	test("does not warn when the reported tier matches the requested tier (#3529)", async () => {
		for (const [model, reported] of [
			[ultrafastVariant("gpt-6.1-sol"), "ultrafast"],
			[fastVariant("gpt-6.1-sol"), "fast"],
			[fastVariant("gpt-6.1-sol"), "priority"],
			[fastVariant("gpt-6.1-sol"), "ultrafast"],
		] as const) {
			const { result } = await run(model, [completedResponse(reported)]);
			assert.deepEqual(result.diagnostics, undefined);
		}
	});

	test("does not warn when the server reports no tier or the request carried none (#3529)", async () => {
		const unreported = await run(ultrafastVariant("gpt-6.1-sol"), [completedResponse(undefined)]);
		assert.equal(unreported.result.diagnostics, undefined);

		const unrequested = await run(getModel("openai", "gpt-6.1-sol"), [completedResponse("default")]);
		assert.equal(unrequested.result.diagnostics, undefined);
	});
});
