import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterAll, beforeAll, beforeEach, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { ClassifierContext, ClassifierOptions } from "../src/types.ts";

const context: ClassifierContext = {
	state: { text: "A cracked mug was delivered." },
	questions: {
		approved: {
			type: "bool",
			instructions: "Was the item damaged?",
			criteria: { true: "Damaged", false: "Intact" },
		},
		queue: {
			type: "choice",
			instructions: "Choose the support queue.",
			criteria: { replacement: "Damaged merchandise", billing: "Payment problems" },
		},
		severity: {
			type: "score",
			instructions: "How severe is the damage?",
			criteria: ["Unharmed", "Cosmetic", "Unusable"],
		},
	},
};
const answers = {
	severity: { type: "score", confidence: 0.9, score: 1.8, probabilities: { 0: 0, 1: 0.2, 2: 0.8 } },
	queue: {
		type: "choice",
		choice: "replacement",
		probabilities: { replacement: 0.98, billing: 0.02 },
		confidence: 0.9,
	},
	approved: { type: "noul", noul: 0.97, confidence: 0.97 },
};
const usage = { total_input_tokens: 152, total_output_tokens: 0, total_tokens: 152 };
const requests: { method?: string; path?: string; headers: IncomingHttpHeaders; body: object }[] = [];
let baseUrl: string;
let reply: (attempt: number) => Response;
const server = createServer(async (request, response) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk);
	requests.push({
		method: request.method,
		path: request.url,
		headers: request.headers,
		body: JSON.parse(Buffer.concat(chunks).toString()),
	});
	const result = reply(requests.length);
	response.writeHead(result.status, Object.fromEntries(result.headers));
	response.end(await result.text());
});

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	baseUrl = `http://127.0.0.1:${address.port}/v1beta/`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
	requests.length = 0;
	reply = () => Response.json({ answers, usage });
});

async function classify(
	input = context,
	options: ClassifierOptions = { apiKey: "test-gemini-key" },
	models = builtinModels(),
) {
	const model = models.getModelOfType("classifier", "google-decisions", "gemini-decision-1");
	assert(model, "Gemini Decision 1 is in the built-in classifier catalog");
	return models.classify({ ...model, baseUrl }, input, options);
}

it("classifies bool, choice, and score with images and records input-only usage (#6773)", async () => {
	const result = await classify({ ...context, images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] });

	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.equal(request.method, "POST");
	assert.equal(request.path, "/v1beta/decisions");
	assert.equal(request.headers["x-goog-api-key"], "test-gemini-key");
	assert.equal(request.headers.authorization, undefined);
	assert.deepEqual(request.body, {
		model: "gemini-decision-1",
		input: [
			{ type: "text", text: '{"text":"A cracked mug was delivered."}' },
			{ type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
		],
		questions: {
			approved: {
				type: "noul",
				instructions: "Was the item damaged?",
				criteria: { true_description: "Damaged", false_description: "Intact" },
			},
			queue: {
				type: "choice",
				instructions: "Choose the support queue.",
				criteria: { replacement: "Damaged merchandise", billing: "Payment problems" },
			},
			severity: {
				type: "score",
				instructions: "How severe is the damage?",
				criteria: ["Unharmed", "Cosmetic", "Unusable"],
			},
		},
	});
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.answers, {
		approved: { type: "bool", probability: 0.97 },
		queue: {
			type: "choice",
			choice: "replacement",
			probabilities: { replacement: 0.98, billing: 0.02 },
			confidence: 0.9,
		},
		severity: { type: "score", confidence: 0.9, score: 1.8 },
	});
	assert.equal(result.usage?.input, 152);
	assert.equal(result.usage?.output, 0);
	assert(Math.abs((result.usage?.cost.total ?? 0) - 0.0000152) < 1e-12);
});

it("rejects oversized question batches before sending (#6773)", async () => {
	const input = {
		state: {},
		questions: Object.fromEntries(
			Array.from({ length: 1001 }, (_, i) => [`question-${i}`, context.questions.approved]),
		),
	};
	const result = await classify(input);
	assert.equal(requests.length, 0);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /1 to 1000 questions/);
});

it("restores Choice schema IDs and option keys that Gemini does not accept (#6773)", async () => {
	const input: ClassifierContext = {
		state: {},
		questions: {
			"review.status": {
				type: "choice",
				instructions: "Choose the exact value for review.status.",
				criteria: { " choose me ": "Response requested by the user", other: "" },
			},
		},
	};
	reply = () =>
		Response.json({
			answers: { q0: { type: "choice", choice: "o0", confidence: 0.8, probabilities: { o0: 0.9, o1: 0.1 } } },
		});

	const result = await classify(input);
	assert.deepEqual(requests[0]?.body, {
		model: "gemini-decision-1",
		input: "{}",
		questions: {
			q0: {
				type: "choice",
				instructions: "Choose the exact value for review.status.",
				criteria: { o0: '" choose me ": Response requested by the user', o1: '"other"' },
			},
		},
	});
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.answers, {
		"review.status": {
			type: "choice",
			choice: " choose me ",
			probabilities: { " choose me ": 0.9, other: 0.1 },
			confidence: 0.8,
		},
	});
});

function throttle(retryDelay: string, quotaId: string, headers?: Record<string, string>): Response {
	return Response.json(
		{
			error: {
				code: 429,
				status: "RESOURCE_EXHAUSTED",
				message: "Request failed",
				details: [
					{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
					{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
				],
			},
		},
		{ status: 429, headers },
	);
}

it("keeps status and the longest retry hint without retrying a throttle over the cap (#6773)", async () => {
	reply = () => throttle("65s", "RequestsPerMinutePerProjectPerModel", { "retry-after": "1" });
	const result = await classify(context, { apiKey: "test-gemini-key", maxRetries: 2, maxRetryDelayMs: 50 });

	assert.equal(requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.status, 429);
	assert.equal(result.code, "RESOURCE_EXHAUSTED");
	assert.equal(result.retryAfterMs, 65_000);
});

it("does not retry a daily quota violation with a short retry hint (#6773)", async () => {
	reply = () => throttle("0.002s", "RequestsPerDayPerProjectPerModel-FreeTier");
	const result = await classify(context, { apiKey: "test-gemini-key", maxRetries: 2 });
	assert.equal(requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.status, 429);
	assert.equal(result.code, "insufficient_quota");
	assert.equal(result.retryAfterMs, 2);
});

it.each([
	["a temporary throttle", () => throttle("0.002s", "RequestsPerMinutePerProjectPerModel")],
	[
		"an unavailable service",
		() => Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503, headers: { "retry-after": "0" } }),
	],
] as const)("retries %s within its retry budget (#6773)", async (_name, failure) => {
	reply = (attempt) => (attempt === 1 ? failure() : Response.json({ answers, usage }));
	const result = await classify(context, { apiKey: "test-gemini-key", maxRetries: 1 });
	assert.equal(requests.length, 2);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.answers.approved?.type, "bool");
});

it.each([
	[400, { status: "INVALID_ARGUMENT" }, "INVALID_ARGUMENT"],
	[
		400,
		{
			status: "INVALID_ARGUMENT",
			details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
		},
		"api_key_invalid",
	],
	[401, { status: "UNAUTHENTICATED" }, "UNAUTHENTICATED"],
	[403, { status: "PERMISSION_DENIED" }, "PERMISSION_DENIED"],
	[404, { status: "NOT_FOUND" }, "NOT_FOUND"],
	[413, { status: "INVALID_ARGUMENT" }, "INVALID_ARGUMENT"],
	[400, { code: "prohibited_content" }, "content_filter"],
] as const)("preserves HTTP %s failure metadata (%o) without retrying (#6773)", async (status, error, code) => {
	reply = () => Response.json({ error }, { status });
	const result = await classify();
	assert.equal(requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.equal(result.status, status);
	assert.equal(result.code, code);
});

it("distinguishes a blocked prompt returned with HTTP 200 from a bad answer (#6773)", async () => {
	reply = () => Response.json({ answers: {}, prompt_feedback: { block_reason: "image_safety" } });
	const result = await classify();
	assert.equal(requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.code, "content_filter");
	assert.deepEqual(result.answers, {});
});

it("does not accept partial answers and retains billed usage (#6773)", async () => {
	reply = () => Response.json({ answers: { ...answers, approved: { ...answers.approved, noul: 1.5 } }, usage });
	const result = await classify();
	assert.equal(requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.code, "invalid-output");
	assert.deepEqual(result.answers, {});
	assert.equal(result.usage?.input, 152);
});

it("does not retry a successful HTTP response with malformed JSON (#6773)", async () => {
	reply = () => new Response("{", { headers: { "content-type": "application/json" } });
	const result = await classify();
	assert.equal(requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.code, "invalid-output");
	assert.deepEqual(result.answers, {});
});

it("rejects a body larger than the inline request limit before sending (#6773)", async () => {
	const result = await classify({ ...context, state: { text: "x".repeat(100_000_000) } });
	assert.equal(requests.length, 0);
	assert.equal(result.stopReason, "error");
	assert.equal(result.code, "request_too_large");
});

it.each([
	[
		"stored Google key",
		"stored-gemini-key",
		{ GEMINI_API_KEY: "gemini-env", GOOGLE_API_KEY: "google-env" },
		"stored-gemini-key",
	],
	["GEMINI_API_KEY", undefined, { GEMINI_API_KEY: "gemini-env", GOOGLE_API_KEY: "google-env" }, "gemini-env"],
	["GOOGLE_API_KEY", undefined, { GOOGLE_API_KEY: "google-env" }, "google-env"],
] as const)(
	"discovers Gemini Decision 1 and sends the key from %s (#6773)",
	async (_name, storedKey, env, expected) => {
		const credentials = new InMemoryCredentialStore();
		if (storedKey) await credentials.modify("google", async () => ({ type: "api_key", key: storedKey }));
		const vars: Readonly<Record<string, string>> = env;
		const models = builtinModels({
			credentials,
			authContext: { env: async (name) => vars[name], fileExists: async () => false },
		});
		assert.deepEqual(
			(await models.getAvailableOfType("classifier", "google-decisions")).map(({ id }) => id),
			["gemini-decision-1"],
		);
		assert.equal(models.getModel("google-decisions", "gemini-decision-1"), undefined);
		const result = await classify(context, {}, models);
		assert.equal(result.stopReason, "stop");
		assert.equal(requests[0]?.headers["x-goog-api-key"], expected);
	},
);

it("does not borrow Vertex credentials or offer a separate login (#6773)", async () => {
	const models = builtinModels({
		authContext: {
			env: async (name) => (name === "GOOGLE_CLOUD_API_KEY" ? "vertex-key" : undefined),
			fileExists: async () => false,
		},
	});
	assert.equal((await models.getAuth("google-vertex"))?.auth.apiKey, "vertex-key");
	assert.equal(models.getProvider("google-decisions")?.auth.apiKey?.login, undefined);
	assert.deepEqual(await models.getAvailableOfType("classifier", "google-decisions"), []);
	const result = await classify(context, {}, models);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Provider is not configured: google-decisions/);
	assert.equal(requests.length, 0);
});
