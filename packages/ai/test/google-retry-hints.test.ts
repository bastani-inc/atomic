import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	streamError: undefined as Error | undefined,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async () => {
				if (googleGenAiMock.streamError) throw googleGenAiMock.streamError;
				return (async function* () {})();
			},
		};
	}
	return {
		FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS" },
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { retryGoogleRequest } from "../src/api/google-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { getProviderRetryAfterMs } from "../src/utils/retry-hints.ts";

/** A Google API error body as the SDK serializes it into `ApiError.message`. */
function googleErrorBody(retryDelay: string, quotaId = "GenerateRequestsPerMinutePerProjectPerModel"): string {
	return JSON.stringify({
		error: {
			code: 429,
			message: "Resource has been exhausted (e.g. check quota).",
			status: "RESOURCE_EXHAUSTED",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.QuotaFailure",
					violations: [{ quotaMetric: "generate_requests", quotaId }],
				},
				{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
			],
		},
	});
}

/** Shaped like `@google/genai`'s ApiError: `status`, the JSON body in `message`, and no `headers`. */
function googleApiError(message: string, status = 429): Error {
	return Object.assign(new Error(message), { name: "ApiError", status });
}

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

beforeEach(() => {
	googleGenAiMock.streamError = undefined;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Google retry hints", () => {
	it("reads RetryInfo.retryDelay from an error body folded into the message", () => {
		assert.equal(getProviderRetryAfterMs(googleApiError(googleErrorBody("17s"))), 17_000);
		assert.equal(getProviderRetryAfterMs(googleApiError(googleErrorBody("0.250s"))), 250);
		// The streaming form prefixes the body.
		assert.equal(getProviderRetryAfterMs(googleApiError(`got status: 429. ${googleErrorBody("3s")}`)), 3000);
		// An array of bodies, as some streaming endpoints send.
		assert.equal(getProviderRetryAfterMs(googleApiError(`[${googleErrorBody("5s")}]`)), 5000);
		assert.equal(getProviderRetryAfterMs(googleApiError("got status: 429 Too Many Requests")), undefined);
	});

	it("reports the server's RetryInfo delay on a failed Google stream", async () => {
		googleGenAiMock.streamError = googleApiError(googleErrorBody("17s"));
		const message = await streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "test-api-key",
			maxRetries: 0,
		}).result();
		assert.equal(message.stopReason, "error");
		assert.equal(message.retryAfterMs, 17_000);
	});

	it("waits the RetryInfo delay before retrying a Google request", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(googleApiError(googleErrorBody("3s")))
			.mockResolvedValue("ok");
		const result = retryGoogleRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(2900);
		assert.equal(request.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(await result, "ok");
		assert.equal(request.mock.calls.length, 2);
	});

	it("fails at once with the hint when the RetryInfo delay exceeds the retry-delay cap", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(googleApiError(googleErrorBody("120s")));
		const failure = await retryGoogleRequest(request, { maxRetries: 2, maxRetryDelayMs: 60_000 }).then(
			() => undefined,
			(error: Error) => error,
		);
		assert.ok(failure);
		assert.equal(getProviderRetryAfterMs(failure), 120_000);
		assert.equal(request.mock.calls.length, 1);
	});
});
