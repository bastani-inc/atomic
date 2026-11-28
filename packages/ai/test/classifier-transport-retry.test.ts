import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { postClassifierRequest } from "../src/api/classifier-shared.ts";
import { classify as classifyCloudflare } from "../src/api/cloudflare-workers-ai-system-one.ts";
import { classify as classifyLlama } from "../src/api/llama-cpp-classify.ts";
import { classify as classifyOpenAI } from "../src/api/openai-decisions.ts";
import { classify as classifyTypeSafe } from "../src/api/typesafe-system-one.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { findTlsCertificateRefusal } from "../src/utils/tls-certificate.ts";

const model: ClassifierModel<"openai-decisions"> = {
	type: "classifier",
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	api: "openai-decisions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64_000,
};

const url = new URL("https://api.openai.com/v1/decisions");

const context: ClassifierContext = {
	state: { text: "The order arrived." },
	questions: {
		order: { type: "choice", instructions: "Classify order status", criteria: { arrived: "Delivered", late: "Late" } },
	},
};

const classifierApis = [
	["openai-decisions", classifyOpenAI],
	["typesafe-system-one", classifyTypeSafe],
	["cloudflare-workers-ai-system-one", classifyCloudflare],
	["llama-cpp-classify", classifyLlama],
] as const;

function classifierRejection(code: string, retryAfter: string) {
	let attempts = 0;
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const path = new URL(String(url)).pathname;
		if (path === "/tokenize") {
			const { content }: { content: string } = JSON.parse(String(init?.body));
			return Response.json({ tokens: [...content].map((char) => char.codePointAt(0)) });
		}
		if (path === "/apply-template") return Response.json({ prompt: "Order status: " });
		attempts++;
		return Response.json({ error: { code, message: "Request rejected" } }, {
			status: 429,
			headers: { "Retry-After": retryAfter },
		});
	};
	return { fetch, attempts: () => attempts };
}

it.each(classifierApis)("%s does not retry a quota 429 (#6783)", async (api, classify) => {
	const rejected = classifierRejection("insufficient_quota", "0.001");
	const result = await classify({ ...model, api }, context, { apiKey: "secret", fetch: rejected.fetch });
	assert.equal(result.stopReason, "error");
	assert.equal(rejected.attempts(), 1);
});

describe.each(classifierApis)("%s retry advice", (api, classify) => {
	it.each([
		["0.001", 1, 3],
		["360", 360_000, 1],
	] as const)("retains Retry-After: %s after exhausting or skipping retries (#6783)", async (header, delay, attempts) => {
		const rejected = classifierRejection("rate_limit_exceeded", header);
		const result = await classify({ ...model, api }, context, {
			apiKey: "secret", fetch: rejected.fetch, maxRetryDelayMs: 5,
		});
		assert.equal(result.stopReason, "error");
		assert.equal(rejected.attempts(), attempts);
		assert.equal(result.retryAfterMs, delay);
	});
});

describe("postClassifierRequest transport retries", () => {
	it("retries a bare UND_ERR_SOCKET fetch error and succeeds on retry", async () => {
		let attempts = 0;
		const body = await postClassifierRequest(
			"OpenAI Decisions",
			url,
			model,
			{ input: "hello" },
			{
				apiKey: "secret",
				maxRetries: 1,
				fetch: async () => {
					attempts += 1;
					if (attempts === 1) {
						throw Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
					}
					return Response.json({ ok: true });
				},
			},
		);

		assert.equal(attempts, 2);
		assert.deepEqual(body, { ok: true });
	});

	it("retries a wrapped fetch-failed UND_ERR_SOCKET error and preserves cause when retries exhaust", async () => {
		const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
		const fetchError = new TypeError("fetch failed", { cause: socketError });
		let attempts = 0;
		let caught: unknown;

		try {
			await postClassifierRequest(
				"OpenAI Decisions",
				url,
				model,
				{ input: "hello" },
				{
					apiKey: "secret",
					maxRetries: 1,
					fetch: async () => {
						attempts += 1;
						throw fetchError;
					},
				},
			);
		} catch (error) {
			caught = error;
		}

		assert.equal(attempts, 2);
		assert.ok(caught instanceof Error);
		assert.equal(caught.cause, fetchError);
		assert.equal(normalizeProviderError(caught).message, "fetch failed: other side closed (UND_ERR_SOCKET)");
	});

	it("does not retry when the caller abort signal is aborted", async () => {
		const controller = new AbortController();
		let attempts = 0;

		await assert.rejects(
			postClassifierRequest(
				"OpenAI Decisions",
				url,
				model,
				{ input: "hello" },
				{
					apiKey: "secret",
					maxRetries: 2,
					signal: controller.signal,
					fetch: async () => {
						attempts += 1;
						controller.abort();
						throw Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
					},
				},
			),
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);

		assert.equal(attempts, 1);
	});

	it("does not retry a TLS certificate refusal", async () => {
		let attempts = 0;
		let caught: unknown;

		try {
			await postClassifierRequest(
				"OpenAI Decisions",
				url,
				model,
				{ input: "hello" },
				{
					apiKey: "secret",
					maxRetries: 2,
					fetch: async () => {
						attempts += 1;
						const certErr = Object.assign(new Error("self-signed certificate"), {
							code: "DEPTH_ZERO_SELF_SIGNED_CERT",
						});
						throw new TypeError("fetch failed", { cause: certErr });
					},
				},
			);
		} catch (error) {
			caught = error;
		}

		assert.equal(attempts, 1);
		assert.equal(findTlsCertificateRefusal(caught)?.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
	});

	it("does not retry invalid JSON in an HTTP 200 response", async () => {
		let attempts = 0;

		await assert.rejects(
			postClassifierRequest(
				"OpenAI Decisions",
				url,
				model,
				{ input: "hello" },
				{
					apiKey: "secret",
					maxRetries: 2,
					fetch: async () => {
						attempts += 1;
						return new Response("<html>not json</html>", { status: 200 });
					},
				},
			),
			SyntaxError,
		);

		assert.equal(attempts, 1);
	});
});
