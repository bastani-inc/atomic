// @ts-nocheck

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";

describe("model fallback helpers", () => {
	// Regression #3031: an empty list alone does not disable implicit current-model fallback.
	test("retry classifier accepts provider failures but rejects task failures", () => {
		assert.equal(isRetryableModelFailure("429 rate limit exceeded"), true);
		assert.equal(isRetryableModelFailure("model not found"), true);
		assert.equal(isRetryableModelFailure("command failed: bun test"), false);
		assert.equal(isRetryableModelFailure("user cancelled"), false);
	});

	test.each([
		"The pending stream has been canceled",
		"The pending stream has been canceled (caused by: socket closed)",
	])("pending stream cancellation is a retryable network timeout: %s", (errorMessage) => {
		assert.equal(normalizeModelFailureSignal(errorMessage).kind, "network_timeout");
		assert.equal(isRetryableModelFailure(errorMessage), true);
	});

	test("retry classifier uses structured diagnostics before localized text", () => {
		const signal = normalizeModelFailureSignal({
			role: "assistant",
			stopReason: "error",
			errorMessage: "地域化されたプロバイダー エラー",
			diagnostics: [{ error: { code: 429, message: "quota exhausted" } }],
		});

		assert.equal(signal.kind, "rate_limit");
		assert.equal(signal.source, "diagnostic");
		assert.equal(
			isRetryableModelFailure({
				role: "assistant",
				stopReason: "error",
				errorMessage: "地域化されたプロバイダー エラー",
				diagnostics: [{ error: { code: 429, message: "quota exhausted" } }],
			}),
			true,
		);
		assert.equal(
			isRetryableModelFailure({
				message: "localized wrapper",
				diagnostics: [{ error: { message: "service unavailable" } }],
			}),
			true,
		);
	});

	test("retry classifier uses structured status and codes including auth failures", () => {
		assert.equal(isRetryableModelFailure({ status: 503, message: "localized" }), true);
		assert.equal(isRetryableModelFailure({ statusCode: 401, message: "localized" }), true);
		assert.equal(isRetryableModelFailure({ httpStatus: 403, message: "localized" }), true);
		assert.equal(isRetryableModelFailure({ code: "invalid_api_key", message: "localized" }), true);
		assert.equal(normalizeModelFailureSignal({ status: 408, message: "localized" }).kind, "network_timeout");
		assert.equal(normalizeModelFailureSignal({ status: 404, message: "localized" }).kind, "model_unavailable");
		assert.equal(normalizeModelFailureSignal({ code: "429", message: "localized" }).kind, "rate_limit");
	});

	test("retry classifier treats every structured HTTP-like 5xx status/code as provider unavailable", () => {
		const cases: readonly unknown[] = [
			{ status: 529, message: "localized" },
			{ statusCode: 520, message: "localized" },
			{ httpStatus: 599, message: "localized" },
			{ code: 529, message: "localized" },
			{ code: "520", message: "localized" },
			{ diagnostics: [{ error: { code: "529", message: "localized" } }] },
		];

		for (const failure of cases) {
			assert.equal(normalizeModelFailureSignal(failure).kind, "provider_unavailable");
			assert.equal(isRetryableModelFailure(failure), true);
		}
	});

	test("retry classifier preserves refusal precedence over structured 5xx", () => {
		assert.equal(isRetryableModelFailure({ stopReason: "aborted", status: 599, code: 529 }), false);
		assert.equal(isRetryableModelFailure({ name: "AbortError", statusCode: 520, message: "request aborted" }), false);
		assert.equal(isRetryableModelFailure({ httpStatus: 529, message: "shell command failed" }), false);
	});

	test("retry classifier lets nested refusals outrank wrapper structured provider signals", () => {
		const refusalCases: ReadonlyArray<{
			label: string;
			failure: unknown;
			expectedKind: "cancelled" | "task_failure";
			expectedSource?: "diagnostic";
		}> = [
			{
				label: "5xx wrapper with abort cause",
				failure: { status: 503, cause: { name: "AbortError", message: "aborted by user" } },
				expectedKind: "cancelled",
			},
			{
				label: "429 wrapper with abort cause",
				failure: { code: "429", cause: { name: "AbortError", message: "rate-limit wrapper hid abort" } },
				expectedKind: "cancelled",
			},
			{
				label: "auth wrapper with diagnostic task failure",
				failure: {
					statusCode: 401,
					diagnostics: [{ error: { message: "command failed after provider wrapper" } }],
				},
				expectedKind: "task_failure",
				expectedSource: "diagnostic",
			},
			{
				label: "timeout wrapper with diagnostic task failure",
				failure: {
					status: 408,
					diagnostics: [{ error: { message: "shell command failed after timeout wrapper" } }],
				},
				expectedKind: "task_failure",
				expectedSource: "diagnostic",
			},
			{
				label: "model unavailable wrapper with task failure cause",
				failure: { status: 404, cause: { message: "command failed: bun test" } },
				expectedKind: "task_failure",
			},
			{
				label: "nested abort below diagnostic 5xx",
				failure: {
					code: 529,
					diagnostics: [{ error: { status: 503, cause: { name: "AbortError", message: "nested abort" } } }],
				},
				expectedKind: "cancelled",
			},
		];

		for (const { label, failure, expectedKind, expectedSource } of refusalCases) {
			const signal = normalizeModelFailureSignal(failure);
			assert.equal(signal.kind, expectedKind, label);
			if (expectedSource !== undefined) assert.equal(signal.source, expectedSource, label);
			assert.equal(isRetryableModelFailure(failure), false, label);
		}
	});

	test("content-filter refusals spend a fallback candidate unless fallbackOnContentFilter is off; tool refusals do not", () => {
		const refusalCases: ReadonlyArray<{
			label: string;
			failure: unknown;
			expectedKind: "content_filter" | "task_failure";
			expectedSource?: "diagnostic";
		}> = [
			{
				label: "assistant content_filter message",
				expectedKind: "content_filter",
				failure: { role: "assistant", stopReason: "error", errorMessage: "content_filter" },
			},
			{
				label: "assistant finish_reason content_filter field",
				expectedKind: "content_filter",
				failure: { role: "assistant", stopReason: "error", finish_reason: "content_filter" },
			},
			{
				label: "diagnostic content_filter code",
				expectedKind: "content_filter",
				failure: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "localized provider error",
					diagnostics: [{ error: { code: "content_filter", message: "blocked by provider" } }],
				},
				expectedSource: "diagnostic",
			},
			{
				label: "safety policy refusal",
				expectedKind: "content_filter",
				failure: { role: "assistant", stopReason: "error", errorMessage: "request blocked by safety policy" },
			},
			{
				label: "tool refusal",
				expectedKind: "task_failure",
				failure: { role: "assistant", stopReason: "error", errorMessage: "tool call refused by provider" },
			},
			{
				label: "provider refusal",
				expectedKind: "content_filter",
				failure: { role: "assistant", stopReason: "error", errorMessage: "provider refused this request" },
			},
		];

		for (const { label, failure, expectedKind, expectedSource } of refusalCases) {
			const signal = normalizeModelFailureSignal(failure);
			assert.equal(signal.kind, expectedKind, label);
			if (expectedSource !== undefined) assert.equal(signal.source, expectedSource, label);
			assert.equal(isRetryableModelFailure(failure), expectedKind === "content_filter", label);
			assert.equal(isRetryableModelFailure(failure, { fallbackOnContentFilter: false }), false, label);
		}
	});

	test("retry classifier follows causes before regex fallback", () => {
		const err = new Error("outer localized failure", {
			cause: { diagnostics: [{ error: { code: "service_unavailable", message: "provider down" } }] },
		});

		assert.equal(isRetryableModelFailure(err), true);
		assert.equal(normalizeModelFailureSignal(err).kind, "provider_unavailable");
	});

	test("an auth-storage load failure stays retryable (not a hard task failure) (#1431)", () => {
		// Mirrors formatAuthStorageLoadFailedMessage(...) output. Fix #2 surfaces a
		// credential-store LOAD failure instead of "No API key found"; that message
		// must remain a recoverable/retryable auth failure so a transient store-read
		// failure can still fall back rather than hard-failing the stage.
		const message =
			"Could not load stored credentials for anthropic: the auth credential store could not be " +
			"read (Lock file is already being held). This is not a missing API key — stored credentials " +
			"may exist but the credential store could not be read (it may be temporarily locked by " +
			"another process). Retry shortly or run '/login anthropic' to re-authenticate.";
		assert.equal(isRetryableModelFailure(new Error(message)), true);
		assert.equal(normalizeModelFailureSignal(new Error(message)).kind, "auth_on_candidate_provider");
	});

	test("request-auth preparation timeout is fallbackable auth, not same-model retry (#3085)", () => {
		const failure = {
			role: "assistant",
			stopReason: "error",
			errorMessage:
				"Request authentication timed out for openai-codex. Check the provider's credential source and try again.",
		};
		assert.equal(isRetryableModelFailure(failure), true);
		assert.equal(normalizeModelFailureSignal(failure).kind, "auth_on_candidate_provider");
		assert.equal(isRetryableSameModelFailure(failure), false);
	});

	test("retry classifier refuses cancellation and task failures despite structured-looking text", () => {
		assert.equal(isRetryableModelFailure({ name: "AbortError", status: 503, message: "request aborted" }), false);
		assert.equal(isRetryableModelFailure({ status: 503, message: "request cancelled" }), false);
		assert.equal(isRetryableModelFailure({ stopReason: "aborted", status: 503, errorMessage: "aborted" }), false);
		assert.equal(isRetryableModelFailure({ status: 503, message: "shell command failed" }), false);
		assert.equal(isRetryableModelFailure("shell command failed with 503"), false);
	});
});
