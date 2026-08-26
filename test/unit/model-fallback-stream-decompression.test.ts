import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isRetryableModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";

/**
 * Stream decompression failures must advance model fallback (#2553).
 *
 * GitHub Copilot on the default `transport: "auto"` repeatedly reported
 * "Library error: zlib error: incorrect header check". The classifier had no
 * pattern for it, so the failure was not fallbackable and workflow stages stayed
 * `running` forever instead of retrying or failing terminally.
 */
describe("stream decompression fallback (#2553)", () => {
	const decompressionMessages = [
		"Library error: zlib error: incorrect header check",
		"zlib error: incorrect header check",
		"incorrect header check",
		"Library error: failed to decompress response body",
		"decompression failed",
		// The literal text Bun 1.4.0 throws for a lying Content-Encoding, verified
		// against a real server; the shipped Atomic binary runs on Bun.
		'ZlibError fetching "https://api.githubcopilot.com/chat/completions"',
	];

	test("decompression failures classify as transport errors and are fallbackable", () => {
		for (const message of decompressionMessages) {
			assert.equal(
				normalizeModelFailureSignal({ message }).kind,
				"transport_error",
				`expected transport_error for ${JSON.stringify(message)}`,
			);
			assert.equal(isRetryableModelFailure({ message }), true, `expected retryable for ${JSON.stringify(message)}`);
		}
	});

	test("the stream deadline surfaces as a fallbackable transport error", () => {
		const message = "Provider stream timed out after 300000ms without a new event (stream deadline exceeded)";
		assert.equal(normalizeModelFailureSignal({ message }).kind, "transport_error");
		assert.equal(isRetryableModelFailure({ message }), true);
	});

	test("an assistant error message carrying the zlib text is fallbackable", () => {
		assert.equal(
			isRetryableModelFailure({
				role: "assistant",
				stopReason: "error",
				errorMessage: "Library error: zlib error: incorrect header check",
			}),
			true,
		);
	});

	test("cancellation still wins over the transport classification", () => {
		assert.equal(
			isRetryableModelFailure({
				name: "AbortError",
				message: "Library error: zlib error: incorrect header check",
				stopReason: "aborted",
			}),
			false,
		);
	});
});
