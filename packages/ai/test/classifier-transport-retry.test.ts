import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { postClassifierRequest } from "../src/api/classifier-shared.ts";
import type { ClassifierModel } from "../src/types.ts";
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
