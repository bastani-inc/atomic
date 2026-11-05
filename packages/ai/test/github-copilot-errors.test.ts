import assert from "node:assert/strict";
import { describe, expectTypeOf, it } from "vitest";
import {
	classifyGitHubCopilotFailure,
	deserializeGitHubCopilotError,
	findGitHubCopilotError,
	GITHUB_COPILOT_ERROR_DIAGNOSTIC,
	GitHubCopilotAuthenticationError,
	GitHubCopilotContentFilterError,
	GitHubCopilotEmptyResponseError,
	GitHubCopilotError,
	type GitHubCopilotErrorCode,
	type GitHubCopilotErrorContext,
	type GitHubCopilotFailureContext,
	GitHubCopilotInvalidRequestError,
	type GitHubCopilotInvalidRequestReason,
	GitHubCopilotModelUnavailableError,
	type GitHubCopilotModelUnavailableReason,
	GitHubCopilotPromptTooLargeError,
	GitHubCopilotQuotaExhaustedError,
	GitHubCopilotRateLimitError,
	GitHubCopilotServiceUnavailableError,
	GitHubCopilotStreamEndedEarlyError,
	type GitHubCopilotUnrecognizedReason,
	GitHubCopilotUnrecognizedResponseError,
	getGitHubCopilotError,
	githubCopilotEmptyResponse,
	isGitHubCopilotAuthenticationError,
	isGitHubCopilotContentFilterError,
	isGitHubCopilotEmptyResponseError,
	isGitHubCopilotError,
	isGitHubCopilotInvalidRequestError,
	isGitHubCopilotModelUnavailableError,
	isGitHubCopilotPromptTooLargeError,
	isGitHubCopilotQuotaExhaustedError,
	isGitHubCopilotRateLimitError,
	isGitHubCopilotServiceUnavailableError,
	isGitHubCopilotStreamEndedEarlyError,
	isGitHubCopilotUnrecognizedResponseError,
	isRetryableGitHubCopilotError,
	recordGitHubCopilotError,
	recordGitHubCopilotFailure,
	serializeGitHubCopilotError,
} from "../src/providers/github-copilot-errors.ts";
import type { AssistantMessage } from "../src/types.ts";

const context: GitHubCopilotErrorContext = {
	modelId: "gemini-4-argon",
	api: "openai-completions",
	status: 400,
	providerCode: "fixture_code",
	requestId: "req-1",
	detail: "fixture detail",
};

const failure: GitHubCopilotFailureContext = { modelId: "grok-4.7", api: "openai-responses", streamStarted: false };

interface ClassCase {
	readonly error: GitHubCopilotError;
	readonly name: string;
	readonly code: GitHubCopilotErrorCode;
	readonly retryable: boolean;
	readonly hint: string;
	readonly what: string;
	readonly extraFields: Record<string, string | number | null>;
	readonly guard: (value: unknown) => boolean;
}

const MODEL_HINT = "Pick another model, or run /login to refresh the models this account can use.";
const RETRY_HINT = "Retry the request; Atomic retries it when retries are enabled.";

const CLASS_CASES: readonly ClassCase[] = [
	{
		error: new GitHubCopilotModelUnavailableError("integration", context),
		name: "GitHubCopilotModelUnavailableError",
		code: "model-unavailable",
		retryable: false,
		hint: "Copilot does not offer this model to Atomic's integration. Pick another model, or run /login to refresh the model list.",
		what: "GitHub Copilot model unavailable",
		extraFields: { reason: "integration" },
		guard: isGitHubCopilotModelUnavailableError,
	},
	{
		error: new GitHubCopilotModelUnavailableError("not-supported", context),
		name: "GitHubCopilotModelUnavailableError",
		code: "model-unavailable",
		retryable: false,
		hint: MODEL_HINT,
		what: "GitHub Copilot model unavailable",
		extraFields: { reason: "not-supported" },
		guard: isGitHubCopilotModelUnavailableError,
	},
	{
		error: new GitHubCopilotModelUnavailableError("wrong-api", context),
		name: "GitHubCopilotModelUnavailableError",
		code: "model-unavailable",
		retryable: false,
		hint: "Run /login to refresh the model list so Atomic calls the API Copilot serves this model on.",
		what: "GitHub Copilot model unavailable",
		extraFields: { reason: "wrong-api" },
		guard: isGitHubCopilotModelUnavailableError,
	},
	{
		error: new GitHubCopilotModelUnavailableError("no-endpoint", context),
		name: "GitHubCopilotModelUnavailableError",
		code: "model-unavailable",
		retryable: false,
		hint: "Copilot has no endpoint for this model under this account's settings. Pick another model.",
		what: "GitHub Copilot model unavailable",
		extraFields: { reason: "no-endpoint" },
		guard: isGitHubCopilotModelUnavailableError,
	},
	{
		error: new GitHubCopilotModelUnavailableError("not-found", context),
		name: "GitHubCopilotModelUnavailableError",
		code: "model-unavailable",
		retryable: false,
		hint: MODEL_HINT,
		what: "GitHub Copilot model unavailable",
		extraFields: { reason: "not-found" },
		guard: isGitHubCopilotModelUnavailableError,
	},
	{
		error: new GitHubCopilotRateLimitError(context, 1500),
		name: "GitHubCopilotRateLimitError",
		code: "rate-limited",
		retryable: true,
		hint: "Wait for the rate limit to reset; Atomic retries the request when retries are enabled.",
		what: "GitHub Copilot rate limit reached",
		extraFields: { retryAfterMs: 1500 },
		guard: isGitHubCopilotRateLimitError,
	},
	{
		error: new GitHubCopilotQuotaExhaustedError(context),
		name: "GitHubCopilotQuotaExhaustedError",
		code: "quota-exhausted",
		retryable: false,
		hint: "Pick another model, or wait until the Copilot plan's quota resets.",
		what: "GitHub Copilot quota exhausted",
		extraFields: {},
		guard: isGitHubCopilotQuotaExhaustedError,
	},
	{
		error: new GitHubCopilotContentFilterError(context),
		name: "GitHubCopilotContentFilterError",
		code: "content-filtered",
		retryable: false,
		hint: "Rephrase the request or pick another model; retry.fallbackOnContentFilter decides whether a fallback model is tried.",
		what: "GitHub Copilot content filter blocked the request",
		extraFields: {},
		guard: isGitHubCopilotContentFilterError,
	},
	{
		error: new GitHubCopilotPromptTooLargeError(context, { promptTokens: 200, limitTokens: 100 }),
		name: "GitHubCopilotPromptTooLargeError",
		code: "prompt-too-large",
		retryable: false,
		hint: "Run /compact or start a new session to shrink the conversation.",
		what: "GitHub Copilot prompt too large",
		extraFields: { promptTokens: 200, limitTokens: 100 },
		guard: isGitHubCopilotPromptTooLargeError,
	},
	{
		error: new GitHubCopilotInvalidRequestError("reasoning-effort", context),
		name: "GitHubCopilotInvalidRequestError",
		code: "invalid-request",
		retryable: false,
		hint: "Pick a thinking level this model lists.",
		what: "GitHub Copilot rejected the request",
		extraFields: { reason: "reasoning-effort" },
		guard: isGitHubCopilotInvalidRequestError,
	},
	{
		error: new GitHubCopilotInvalidRequestError("integration-id", context),
		name: "GitHubCopilotInvalidRequestError",
		code: "invalid-request",
		retryable: false,
		hint: "Remove the Copilot-Integration-Id header override from models.json.",
		what: "GitHub Copilot rejected the request",
		extraFields: { reason: "integration-id" },
		guard: isGitHubCopilotInvalidRequestError,
	},
	{
		error: new GitHubCopilotInvalidRequestError("rejected", context),
		name: "GitHubCopilotInvalidRequestError",
		code: "invalid-request",
		retryable: false,
		hint: "Check the model's thinking level and any models.json overrides for this model.",
		what: "GitHub Copilot rejected the request",
		extraFields: { reason: "rejected" },
		guard: isGitHubCopilotInvalidRequestError,
	},
	{
		error: new GitHubCopilotAuthenticationError(context),
		name: "GitHubCopilotAuthenticationError",
		code: "authentication-failed",
		retryable: false,
		hint: "Run /login to sign in to GitHub Copilot again, or check COPILOT_GITHUB_TOKEN.",
		what: "GitHub Copilot authentication failed",
		extraFields: {},
		guard: isGitHubCopilotAuthenticationError,
	},
	{
		error: new GitHubCopilotServiceUnavailableError(context),
		name: "GitHubCopilotServiceUnavailableError",
		code: "service-unavailable",
		retryable: true,
		hint: "Retry later; Atomic retries the request when retries are enabled.",
		what: "GitHub Copilot service unavailable",
		extraFields: {},
		guard: isGitHubCopilotServiceUnavailableError,
	},
	{
		error: new GitHubCopilotStreamEndedEarlyError(context),
		name: "GitHubCopilotStreamEndedEarlyError",
		code: "stream-ended-early",
		retryable: true,
		hint: RETRY_HINT,
		what: "GitHub Copilot response stream ended early",
		extraFields: {},
		guard: isGitHubCopilotStreamEndedEarlyError,
	},
	{
		error: new GitHubCopilotEmptyResponseError(context),
		name: "GitHubCopilotEmptyResponseError",
		code: "empty-response",
		retryable: true,
		hint: RETRY_HINT,
		what: "GitHub Copilot returned an empty response",
		extraFields: {},
		guard: isGitHubCopilotEmptyResponseError,
	},
	{
		error: new GitHubCopilotUnrecognizedResponseError("unknown-status", context),
		name: "GitHubCopilotUnrecognizedResponseError",
		code: "unrecognized-response",
		retryable: true,
		hint: "Retry the request, and report it if it keeps happening.",
		what: "GitHub Copilot returned an unrecognized response",
		extraFields: { reason: "unknown-status" },
		guard: isGitHubCopilotUnrecognizedResponseError,
	},
];

const BASE_FIELDS = {
	modelId: "gemini-4-argon",
	api: "openai-completions",
	status: 400,
	providerCode: "fixture_code",
	requestId: "req-1",
	detail: "fixture detail",
};

const ALL_GUARDS = [
	isGitHubCopilotModelUnavailableError,
	isGitHubCopilotRateLimitError,
	isGitHubCopilotQuotaExhaustedError,
	isGitHubCopilotContentFilterError,
	isGitHubCopilotPromptTooLargeError,
	isGitHubCopilotInvalidRequestError,
	isGitHubCopilotAuthenticationError,
	isGitHubCopilotServiceUnavailableError,
	isGitHubCopilotStreamEndedEarlyError,
	isGitHubCopilotEmptyResponseError,
	isGitHubCopilotUnrecognizedResponseError,
];

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "github-copilot",
		model: "gemini-4-argon",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 0,
		...overrides,
	};
}

describe("GitHub Copilot error family (#4324)", () => {
	it.each(CLASS_CASES)("$name ($code) carries its code, retryability, hint and fields", (testCase) => {
		const { error } = testCase;
		assert.ok(error instanceof GitHubCopilotError);
		assert.ok(error instanceof Error);
		assert.equal(error.name, testCase.name);
		assert.equal(error.code, testCase.code);
		assert.equal(error.retryable, testCase.retryable);
		assert.equal(error.hint, testCase.hint);
		assert.equal(error.message, `${testCase.what}: gemini-4-argon (${testCase.code}). ${testCase.hint}`);
		assert.deepEqual(error.fields(), { ...BASE_FIELDS, ...testCase.extraFields });
		assert.equal(isGitHubCopilotError(error), true);
		assert.equal(isRetryableGitHubCopilotError(error), testCase.retryable);
		for (const guard of ALL_GUARDS) assert.equal(guard(error), guard === testCase.guard, guard.name);
		const relayed = { name: testCase.name, code: testCase.code };
		for (const guard of ALL_GUARDS) assert.equal(guard(relayed), guard === testCase.guard, guard.name);
		assert.equal(isGitHubCopilotError(relayed), true);
		const rebuilt = findGitHubCopilotError(relayed);
		assert.ok(rebuilt instanceof testCase.error.constructor);
		assert.equal(rebuilt.modelId, "");
		assert.equal(rebuilt.retryable, testCase.retryable);
		assert.equal(isGitHubCopilotError({ name: testCase.name, code: "nope" }), false);
	});

	it("names the family base itself and gives it its code's hint and retryability", () => {
		const base = new GitHubCopilotError("rate-limited", context);
		assert.equal(base.name, "GitHubCopilotError");
		assert.equal(base.retryable, true);
		assert.equal(base.hint, "Wait for the rate limit to reset; Atomic retries the request when retries are enabled.");
		assert.equal(serializeGitHubCopilotError(base).name, "GitHubCopilotError");
		assert.equal(isGitHubCopilotError(base), true);
		for (const guard of ALL_GUARDS) assert.equal(guard(base), false, guard.name);
	});

	it("only objects are family members", () => {
		const impostor = Object.assign(function GitHubCopilotRateLimitError() {}, { code: "rate-limited" });
		assert.equal(isGitHubCopilotError(impostor), false);
		assert.equal(findGitHubCopilotError(impostor), undefined);
		for (const value of [undefined, null, "GitHubCopilotRateLimitError", 5]) {
			assert.equal(isGitHubCopilotError(value), false);
			for (const guard of ALL_GUARDS) assert.equal(guard(value), false, guard.name);
		}
	});

	it.each(CLASS_CASES)("$name survives a process boundary as its own class", (testCase) => {
		const cause = Object.assign(new Error("provider said no"), { code: "fixture_code" });
		const original = deserializeGitHubCopilotError({
			...serializeGitHubCopilotError(testCase.error),
			cause: { name: "Error", message: "provider said no", code: "fixture_code" },
		});
		assert.ok(original);
		const wire = JSON.parse(JSON.stringify(serializeGitHubCopilotError(original)));
		const rebuilt = deserializeGitHubCopilotError(wire);

		assert.ok(rebuilt instanceof testCase.error.constructor);
		assert.equal(rebuilt.name, testCase.name);
		assert.equal(rebuilt.code, testCase.code);
		assert.equal(rebuilt.message, testCase.error.message);
		assert.equal(rebuilt.hint, testCase.hint);
		assert.equal(rebuilt.retryable, testCase.retryable);
		assert.deepEqual(rebuilt.fields(), testCase.error.fields());
		assert.equal(testCase.guard(rebuilt), true);
		assert.equal((rebuilt.cause as Error).message, cause.message);
		assert.equal((rebuilt.cause as { code?: string }).code, "fixture_code");
		assert.equal((rebuilt.cause as Error).name, "Error");
	});

	it("keeps a nested cause chain, its names and only the codes it had", () => {
		const root = Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
		const middle = new RangeError("stream failed", { cause: root });
		const rebuilt = deserializeGitHubCopilotError(
			JSON.parse(
				JSON.stringify(
					serializeGitHubCopilotError(new GitHubCopilotStreamEndedEarlyError(context, { cause: middle })),
				),
			),
		);
		const first = rebuilt?.cause as Error & { code?: string };
		const second = first.cause as Error & { code?: string };
		assert.equal(first.name, "RangeError");
		assert.equal(first.message, "stream failed");
		assert.equal(Object.hasOwn(first, "code"), false);
		assert.equal(second.name, "TypeError");
		assert.equal(second.message, "socket closed");
		assert.deepEqual(Object.keys(second), ["code"]);
		assert.equal(second.code, "ECONNRESET");
		assert.equal(second.cause, undefined);
		const withNullCause = serializeGitHubCopilotError(
			new GitHubCopilotStreamEndedEarlyError(context, { cause: null }),
		);
		assert.equal("cause" in withNullCause, false);
	});

	it("rebuilds an error with no optional fields", () => {
		const bare = new GitHubCopilotServiceUnavailableError({ modelId: "m", api: "a" });
		assert.deepEqual(bare.fields(), {
			modelId: "m",
			api: "a",
			status: null,
			providerCode: null,
			requestId: null,
			detail: null,
		});
		const rebuilt = deserializeGitHubCopilotError(JSON.parse(JSON.stringify(serializeGitHubCopilotError(bare))));
		assert.ok(rebuilt instanceof GitHubCopilotServiceUnavailableError);
		assert.equal(rebuilt.status, undefined);
		assert.equal(rebuilt.providerCode, undefined);
		assert.equal(rebuilt.requestId, undefined);
		assert.equal(rebuilt.detail, undefined);
		assert.equal(rebuilt.cause, undefined);
		assert.equal("cause" in serializeGitHubCopilotError(bare), false);
		assert.deepEqual(new GitHubCopilotRateLimitError(context).fields().retryAfterMs, null);
		assert.deepEqual(
			[
				new GitHubCopilotPromptTooLargeError(context).promptTokens,
				new GitHubCopilotPromptTooLargeError(context).limitTokens,
			],
			[undefined, undefined],
		);
	});

	it("rebuilds a serialized error with missing reason fields as the class default", () => {
		const strip = (error: GitHubCopilotError) => {
			const serialized = serializeGitHubCopilotError(error);
			const { reason: _reason, ...fields } = serialized.fields;
			return { ...serialized, fields };
		};
		const unavailable = deserializeGitHubCopilotError(
			strip(new GitHubCopilotModelUnavailableError("integration", context)),
		);
		const invalid = deserializeGitHubCopilotError(
			strip(new GitHubCopilotInvalidRequestError("integration-id", context)),
		);
		const unrecognized = deserializeGitHubCopilotError(
			strip(new GitHubCopilotUnrecognizedResponseError("unknown-status", context)),
		);
		assert.equal((unavailable as GitHubCopilotModelUnavailableError).reason, "not-supported");
		assert.equal((invalid as GitHubCopilotInvalidRequestError).reason, "rejected");
		assert.equal((unrecognized as GitHubCopilotUnrecognizedResponseError).reason, "malformed-body");
		const noModel = deserializeGitHubCopilotError({
			...serializeGitHubCopilotError(new GitHubCopilotQuotaExhaustedError(context)),
			fields: {},
		});
		assert.equal(noModel?.modelId, "");
		assert.equal(noModel?.api, "");
	});

	it("rebuilds an unknown name as the family base, keeping name, code, message, hint and retryability", () => {
		const rebuilt = deserializeGitHubCopilotError({
			name: "GitHubCopilotFutureError",
			code: "service-unavailable",
			message: "A future failure",
			hint: "Do the future thing.",
			retryable: false,
			fields: { modelId: "m", api: "a" },
		});
		assert.ok(rebuilt);
		assert.equal(Object.getPrototypeOf(rebuilt), GitHubCopilotError.prototype);
		assert.equal(rebuilt.name, "GitHubCopilotFutureError");
		assert.equal(rebuilt.code, "service-unavailable");
		assert.equal(rebuilt.message, "A future failure");
		assert.equal(rebuilt.hint, "Do the future thing.");
		assert.equal(rebuilt.retryable, false);
		assert.equal(rebuilt.modelId, "m");
		assert.equal(isGitHubCopilotError(rebuilt), true);
		assert.equal(isGitHubCopilotServiceUnavailableError(rebuilt), false);
	});

	it.each([
		["a non-object", "nope"],
		["null", null],
		["an array", []],
		[
			"an unknown code",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), code: "nope" },
		],
		["a missing name", { ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), name: 1 }],
		[
			"a missing message",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), message: 1 },
		],
		["a missing hint", { ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), hint: 1 }],
		[
			"a non-boolean retryable",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), retryable: "no" },
		],
		[
			"non-object fields",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), fields: [] },
		],
		[
			"a nested field",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), fields: { detail: {} } },
		],
		[
			"a boolean field",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), fields: { detail: true } },
		],
		[
			"a malformed cause",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), cause: { name: 1 } },
		],
		[
			"a cause with a numeric name",
			{
				...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)),
				cause: { name: 1, message: "m" },
			},
		],
		[
			"string fields",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), fields: "abc" },
		],
		[
			"a cause without a message",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), cause: { name: "E" } },
		],
		[
			"a cause with a numeric code",
			{
				...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)),
				cause: { name: "E", message: "m", code: 5 },
			},
		],
		[
			"a non-object cause",
			{ ...serializeGitHubCopilotError(new GitHubCopilotAuthenticationError(context)), cause: "E" },
		],
	])("rejects %s at the boundary", (_label, value) => {
		assert.equal(deserializeGitHubCopilotError(value), undefined);
	});

	it("bounds a serialized cause chain and rejects one deeper than the bound", () => {
		let cause: Error | undefined;
		for (let depth = 0; depth < 12; depth++) cause = new Error(`cause ${depth}`, { cause });
		const serialized = serializeGitHubCopilotError(new GitHubCopilotStreamEndedEarlyError(context, { cause }));
		let depth = 0;
		for (let link = serialized.cause; link !== undefined; link = link.cause) depth++;
		assert.equal(depth, 8);
		assert.equal(serialized.cause?.message, "cause 11");
		assert.ok(deserializeGitHubCopilotError(serialized));

		let deep: Record<string, unknown> = { name: "E", message: "m" };
		for (let index = 0; index < 8; index++) deep = { name: "E", message: "m", cause: deep };
		assert.equal(deserializeGitHubCopilotError({ ...serialized, cause: deep }), undefined);
	});

	it("serializes non-Error causes and truncates long cause text", () => {
		const serialized = serializeGitHubCopilotError(
			new GitHubCopilotStreamEndedEarlyError(context, { cause: "x".repeat(400) }),
		);
		assert.deepEqual(serialized.cause, { name: "string", message: `${"x".repeat(300)}…` });
		const exact = serializeGitHubCopilotError(
			new GitHubCopilotStreamEndedEarlyError(context, { cause: "y".repeat(300) }),
		);
		assert.equal(exact.cause?.message, "y".repeat(300));
		const numeric = serializeGitHubCopilotError(
			new GitHubCopilotStreamEndedEarlyError(context, { cause: Object.assign(new Error("e"), { code: 5 }) }),
		);
		assert.deepEqual(numeric.cause, { name: "Error", message: "e" });
	});

	it("guards walk the cause chain within a bounded depth and match structurally across realms", () => {
		const typed = new GitHubCopilotRateLimitError(context);
		let wrapped: unknown = typed;
		for (let depth = 0; depth < 7; depth++) wrapped = new Error(`wrapper ${depth}`, { cause: wrapped });
		assert.equal(isGitHubCopilotRateLimitError(wrapped), true);
		assert.equal(findGitHubCopilotError(wrapped), typed);
		assert.equal(isRetryableGitHubCopilotError(wrapped), true);
		const tooDeep = new Error("wrapper 8", { cause: wrapped });
		assert.equal(isGitHubCopilotRateLimitError(tooDeep), false);
		assert.equal(isGitHubCopilotError(tooDeep), false);
		assert.equal(findGitHubCopilotError(tooDeep), undefined);
		assert.equal(isRetryableGitHubCopilotError(tooDeep), false);

		const structural = { name: "GitHubCopilotRateLimitError", code: "rate-limited" };
		const rebuilt = findGitHubCopilotError(new Error("relayed", { cause: structural }));
		assert.ok(rebuilt instanceof GitHubCopilotRateLimitError);
		assert.equal(rebuilt.retryable, true);
		assert.equal(
			rebuilt.hint,
			"Wait for the rate limit to reset; Atomic retries the request when retries are enabled.",
		);
		const withoutMessage = findGitHubCopilotError({ name: "GitHubCopilotError", code: "quota-exhausted" });
		assert.equal(withoutMessage?.message, "");
		const withMessage = findGitHubCopilotError({
			name: "GitHubCopilotError",
			code: "quota-exhausted",
			message: "relayed",
		});
		assert.ok(withMessage instanceof GitHubCopilotError);
		assert.equal(withMessage.message, "relayed");
		assert.equal(withMessage.retryable, false);
		const serialized = serializeGitHubCopilotError(
			new GitHubCopilotPromptTooLargeError(context, { promptTokens: 9 }),
		);
		const fromWire = findGitHubCopilotError(JSON.parse(JSON.stringify(serialized)));
		assert.ok(fromWire instanceof GitHubCopilotPromptTooLargeError);
		assert.equal(fromWire.promptTokens, 9);
		assert.equal(isGitHubCopilotRateLimitError(structural), true);
		assert.equal(isGitHubCopilotError(structural), true);
		assert.equal(
			isGitHubCopilotRateLimitError({ name: "GitHubCopilotRateLimitError", code: "quota-exhausted" }),
			false,
		);
		assert.equal(isGitHubCopilotError({ name: "GitHubCopilotRateLimitError", code: "quota-exhausted" }), false);
		assert.equal(isGitHubCopilotError({ name: "GitHubCopilotError", code: "rate-limited" }), true);
		assert.equal(isGitHubCopilotError({ name: "GitHubCopilotError", code: "nope" }), false);
		assert.equal(isGitHubCopilotError({ name: "toString", code: "rate-limited" }), false);
		assert.equal(isGitHubCopilotError({ name: "GitHubCopilotRateLimitError" }), false);
		assert.equal(isGitHubCopilotError({ code: "rate-limited" }), false);
		assert.equal(isGitHubCopilotError("GitHubCopilotRateLimitError"), false);
		assert.equal(isGitHubCopilotError(null), false);
		assert.equal(isRetryableGitHubCopilotError(new Error("plain")), false);
		assert.equal(isRetryableGitHubCopilotError(new GitHubCopilotQuotaExhaustedError(context)), false);
	});
});

describe("GitHub Copilot errors carried by failed assistant messages in a cause chain (#4324)", () => {
	function failedMessage(error: GitHubCopilotError): AssistantMessage {
		const message = assistant({ errorMessage: "provider text" });
		recordGitHubCopilotError(message, error, "provider text");
		return message;
	}

	function wrapped(link: unknown, depth: number): unknown {
		let current = link;
		for (let index = 0; index < depth; index++) current = new Error(`wrapper ${index}`, { cause: current });
		return current;
	}

	it.each(CLASS_CASES)("finds $name through a message a wrapper names as its cause", (testCase) => {
		const message = failedMessage(testCase.error);
		const wrapper = new Error("Workflow stage failed", { cause: message });
		const relayed = JSON.parse(JSON.stringify({ name: "WorkflowFailure", message: "stage failed", cause: message }));
		for (const chain of [message, wrapper, relayed]) {
			const found = findGitHubCopilotError(chain);
			assert.ok(found instanceof testCase.error.constructor);
			assert.equal(found.code, testCase.code);
			assert.deepEqual(found.fields(), testCase.error.fields());
			assert.equal(isGitHubCopilotError(chain), true);
			assert.equal(isRetryableGitHubCopilotError(chain), testCase.retryable);
			for (const guard of ALL_GUARDS) assert.equal(guard(chain), guard === testCase.guard, guard.name);
		}
	});

	it("walks at most eight links, counting the message as one", () => {
		const message = failedMessage(new GitHubCopilotStreamEndedEarlyError(context));
		assert.ok(findGitHubCopilotError(wrapped(message, 7)) instanceof GitHubCopilotStreamEndedEarlyError);
		assert.equal(findGitHubCopilotError(wrapped(message, 8)), undefined);
		assert.equal(isGitHubCopilotStreamEndedEarlyError(wrapped(message, 8)), false);
		const typed = new GitHubCopilotStreamEndedEarlyError(context);
		assert.equal(findGitHubCopilotError(wrapped(typed, 7)), typed);
		assert.equal(findGitHubCopilotError(wrapped(typed, 8)), undefined);
	});

	it("returns the first typed error but lets a class guard find a later one", () => {
		const outer = failedMessage(new GitHubCopilotRateLimitError(context));
		const inner = new GitHubCopilotQuotaExhaustedError(context);
		const chain = new Error("outer", { cause: { ...outer, cause: inner } });
		assert.ok(findGitHubCopilotError(chain) instanceof GitHubCopilotRateLimitError);
		assert.equal(isGitHubCopilotRateLimitError(chain), true);
		assert.equal(isGitHubCopilotQuotaExhaustedError(chain), true);
		assert.equal(isGitHubCopilotContentFilterError(chain), false);
		assert.equal(isRetryableGitHubCopilotError(chain), true);
	});

	it("skips messages without a Copilot diagnostic", () => {
		const untyped = assistant({ errorMessage: "(stream-ended-early) text only" });
		assert.equal(findGitHubCopilotError(new Error("wrapper", { cause: untyped })), undefined);
		const typedBelow = new GitHubCopilotEmptyResponseError(context);
		assert.equal(findGitHubCopilotError({ ...untyped, cause: typedBelow }), typedBelow);
	});
});

describe("GitHub Copilot failure classification at the provider boundary (#4324)", () => {
	function httpError(status: number, body?: Record<string, unknown>, message?: string): Error {
		return Object.assign(new Error(message ?? `${status} ${String(body?.message ?? "status")}`), {
			status,
			error: body,
			...(body?.code === undefined ? {} : { code: body.code }),
		});
	}

	it.each([
		[400, GitHubCopilotInvalidRequestError, "invalid-request"],
		[401, GitHubCopilotAuthenticationError, "authentication-failed"],
		[402, GitHubCopilotQuotaExhaustedError, "quota-exhausted"],
		[403, GitHubCopilotAuthenticationError, "authentication-failed"],
		[404, GitHubCopilotModelUnavailableError, "model-unavailable"],
		[408, GitHubCopilotServiceUnavailableError, "service-unavailable"],
		[409, GitHubCopilotInvalidRequestError, "invalid-request"],
		[413, GitHubCopilotPromptTooLargeError, "prompt-too-large"],
		[422, GitHubCopilotInvalidRequestError, "invalid-request"],
		[429, GitHubCopilotRateLimitError, "rate-limited"],
		[499, GitHubCopilotInvalidRequestError, "invalid-request"],
		[500, GitHubCopilotServiceUnavailableError, "service-unavailable"],
		[503, GitHubCopilotServiceUnavailableError, "service-unavailable"],
		[529, GitHubCopilotServiceUnavailableError, "service-unavailable"],
		[599, GitHubCopilotServiceUnavailableError, "service-unavailable"],
		[600, GitHubCopilotUnrecognizedResponseError, "unrecognized-response"],
		[399, GitHubCopilotUnrecognizedResponseError, "unrecognized-response"],
		[302, GitHubCopilotUnrecognizedResponseError, "unrecognized-response"],
	] as const)("maps HTTP %i without a code to %o", (status, type, code) => {
		const raw = httpError(status, { message: "fixture" });
		const error = classifyGitHubCopilotFailure(raw, failure);
		assert.ok(error instanceof type);
		assert.equal(error.cause, raw);
		assert.equal(error.code, code);
		assert.equal(error.status, status);
		assert.equal(error.providerCode, undefined);
	});

	it("records the reason for a 404 and the raw status for an unknown one", () => {
		const notFound = classifyGitHubCopilotFailure(httpError(404), failure);
		assert.equal((notFound as GitHubCopilotModelUnavailableError).reason, "not-found");
		const unknown = classifyGitHubCopilotFailure(httpError(302), failure);
		assert.equal((unknown as GitHubCopilotUnrecognizedResponseError).reason, "unknown-status");
		const rejected = classifyGitHubCopilotFailure(httpError(422), failure);
		assert.equal((rejected as GitHubCopilotInvalidRequestError).reason, "rejected");
	});

	it.each([
		["model_not_available_for_integrator", GitHubCopilotModelUnavailableError, "integration"],
		["MODEL_NOT_SUPPORTED", GitHubCopilotModelUnavailableError, "not-supported"],
		["unsupported_api_for_model", GitHubCopilotModelUnavailableError, "wrong-api"],
		["invalid_reasoning_effort", GitHubCopilotInvalidRequestError, "reasoning-effort"],
		["content_filter", GitHubCopilotContentFilterError, undefined],
		["cyber_policy", GitHubCopilotContentFilterError, undefined],
		["rate_limit_exceeded", GitHubCopilotRateLimitError, undefined],
		["insufficient_quota", GitHubCopilotQuotaExhaustedError, undefined],
		["quota_exceeded", GitHubCopilotQuotaExhaustedError, undefined],
		["server_error", GitHubCopilotServiceUnavailableError, undefined],
		["context_length_exceeded", GitHubCopilotPromptTooLargeError, undefined],
		["model_max_prompt_tokens_exceeded", GitHubCopilotPromptTooLargeError, undefined],
	] as const)("maps the provider code %s ahead of the HTTP status", (code, type, reason) => {
		const raw = httpError(503, { message: "m", code });
		const error = classifyGitHubCopilotFailure(raw, failure);
		assert.ok(error instanceof type);
		assert.equal(error.cause, raw);
		assert.equal(error.providerCode, code);
		assert.equal((error as { reason?: string }).reason, reason);
		const streamed = classifyGitHubCopilotFailure(Object.assign(new Error("in stream"), { code }), failure);
		assert.ok(streamed instanceof type);
		assert.equal(streamed.status, undefined);
	});

	it("reads the provider code from the SDK, then the nested body, then the flat body", () => {
		const sdk = Object.assign(new Error("400"), {
			status: 400,
			code: "model_not_supported",
			error: { code: "cyber_policy" },
		});
		assert.equal(classifyGitHubCopilotFailure(sdk, failure)?.providerCode, "model_not_supported");
		const nested = Object.assign(new Error("400"), {
			status: 400,
			error: { error: { code: "cyber_policy", message: "nested message" }, code: "model_not_supported" },
		});
		const nestedError = classifyGitHubCopilotFailure(nested, failure);
		assert.equal(nestedError?.providerCode, "cyber_policy");
		assert.equal(nestedError?.detail, "nested message");
		const flat = Object.assign(new Error("400"), { status: 400, error: { code: "  model_not_supported  " } });
		assert.equal(classifyGitHubCopilotFailure(flat, failure)?.providerCode, "model_not_supported");
		const blank = Object.assign(new Error("400 x"), { status: 400, code: "   ", error: { code: "" } });
		assert.equal(classifyGitHubCopilotFailure(blank, failure)?.providerCode, undefined);
		const numeric = Object.assign(new Error("400 x"), { status: 400, code: 7 });
		assert.equal(classifyGitHubCopilotFailure(numeric, failure)?.providerCode, undefined);
	});

	it("keeps a short provider detail and the request ID, never more", () => {
		const long = classifyGitHubCopilotFailure(httpError(400, { message: "z".repeat(500) }), failure);
		assert.equal(long?.detail, `${"z".repeat(300)}…`);
		const exact = classifyGitHubCopilotFailure(httpError(400, { message: "w".repeat(300) }), failure);
		assert.equal(exact?.detail, "w".repeat(300));
		const plain = classifyGitHubCopilotFailure(httpError(400, undefined, "400 Bad Request"), failure);
		assert.equal(plain?.detail, "Bad Request");
		const unprefixed = classifyGitHubCopilotFailure(httpError(400, undefined, "Bad Request"), failure);
		assert.equal(unprefixed?.detail, "Bad Request");
		const otherStatusPrefix = classifyGitHubCopilotFailure(httpError(400, undefined, "500 Bad Request"), failure);
		assert.equal(otherStatusPrefix?.detail, "500 Bad Request");
		const empty = classifyGitHubCopilotFailure(httpError(400, { message: "  " }, "400  "), failure);
		assert.equal(empty?.detail, undefined);
		const withRequestId = Object.assign(httpError(500), { requestID: "req-a" });
		assert.equal(classifyGitHubCopilotFailure(withRequestId, failure)?.requestId, "req-a");
		const snakeRequestId = Object.assign(httpError(500), { request_id: "req-b" });
		assert.equal(classifyGitHubCopilotFailure(snakeRequestId, failure)?.requestId, "req-b");
		assert.equal(classifyGitHubCopilotFailure(httpError(500), failure)?.requestId, undefined);
		const headerOnly = Object.assign(httpError(500), { headers: new Headers({ "x-request-id": "req-c" }) });
		assert.equal(classifyGitHubCopilotFailure(headerOnly, failure)?.requestId, "req-c");
		const sdkFirst = Object.assign(httpError(500), {
			requestID: "req-d",
			headers: new Headers({ "x-request-id": "req-c" }),
		});
		assert.equal(classifyGitHubCopilotFailure(sdkFirst, failure)?.requestId, "req-d");
		const plainHeaders = Object.assign(httpError(500), { headers: { "x-request-id": "req-e" } });
		assert.equal(classifyGitHubCopilotFailure(plainHeaders, failure)?.requestId, undefined);
	});

	it("matches the exact plain-text bodies only on a 400 without a code", () => {
		const noEndpoint = "No model endpoints available given user constraints";
		const noEndpointError = httpError(400, undefined, `400 ${noEndpoint}`);
		const unavailable = classifyGitHubCopilotFailure(noEndpointError, failure);
		assert.equal((unavailable as GitHubCopilotModelUnavailableError).reason, "no-endpoint");
		assert.equal(unavailable?.cause, noEndpointError);
		const integrationError = httpError(400, undefined, "400 bad request: unknown Copilot-Integration-Id");
		const integration = classifyGitHubCopilotFailure(integrationError, failure);
		assert.equal((integration as GitHubCopilotInvalidRequestError).reason, "integration-id");
		assert.equal(integration?.cause, integrationError);
		const other500 = classifyGitHubCopilotFailure(httpError(500, undefined, `500 ${noEndpoint}`), failure);
		assert.ok(other500 instanceof GitHubCopilotServiceUnavailableError);
		const longer = classifyGitHubCopilotFailure(httpError(400, undefined, `400 ${noEndpoint} today`), failure);
		assert.equal((longer as GitHubCopilotInvalidRequestError).reason, "rejected");
		const coded = classifyGitHubCopilotFailure(
			Object.assign(httpError(400, undefined, `400 ${noEndpoint}`), { code: "fixture_code" }),
			failure,
		);
		assert.equal((coded as GitHubCopilotInvalidRequestError).reason, "rejected");
	});

	it("reads prompt and limit tokens from the overflow text when present", () => {
		const parsed = classifyGitHubCopilotFailure(
			httpError(400, {
				message: "prompt token count of 12 exceeds the limit of 10",
				code: "model_max_prompt_tokens_exceeded",
			}),
			failure,
		);
		assert.deepEqual(
			[
				(parsed as GitHubCopilotPromptTooLargeError).promptTokens,
				(parsed as GitHubCopilotPromptTooLargeError).limitTokens,
			],
			[12, 10],
		);
		const bare = classifyGitHubCopilotFailure(httpError(413), failure) as GitHubCopilotPromptTooLargeError;
		assert.deepEqual([bare.promptTokens, bare.limitTokens], [undefined, undefined]);
		const silent = Object.assign(new Error(""), { status: 413 });
		const noDetail = classifyGitHubCopilotFailure(silent, failure) as GitHubCopilotPromptTooLargeError;
		assert.equal(noDetail.detail, undefined);
		assert.deepEqual([noDetail.promptTokens, noDetail.limitTokens], [undefined, undefined]);
		assert.equal(noDetail.cause, silent);
	});

	it("takes a rate limit's retry delay from the provider", () => {
		const limited = classifyGitHubCopilotFailure(Object.assign(httpError(429), { retryAfterMs: 2500 }), failure);
		assert.equal((limited as GitHubCopilotRateLimitError).retryAfterMs, 2500);
		const coded = classifyGitHubCopilotFailure(
			Object.assign(new Error("e"), { code: "rate_limit_exceeded", retryAfterMs: 900 }),
			failure,
		);
		assert.equal((coded as GitHubCopilotRateLimitError).retryAfterMs, 900);
	});

	it("classifies failures after the stream started without an HTTP status", () => {
		const started = { ...failure, streamStarted: true };
		const filterStop = new Error("x");
		const filtered = classifyGitHubCopilotFailure(filterStop, {
			...started,
			api: "openai-completions",
			finishReason: "content_filter",
		});
		assert.ok(filtered instanceof GitHubCopilotContentFilterError);
		assert.equal(filtered.cause, filterStop);
		const oddEvent = Object.assign(new Error("x"), { code: "odd" });
		assert.equal(classifyGitHubCopilotFailure(oddEvent, started)?.cause, oddEvent);
		const badJson = new SyntaxError("bad json");
		assert.equal(classifyGitHubCopilotFailure(badJson, started)?.cause, badJson);
		const undefinedText = classifyGitHubCopilotFailure(new Error("undefined value in stream"), started);
		assert.equal(undefinedText?.detail, "undefined value in stream");
		const incomplete = classifyGitHubCopilotFailure(new Error("x"), {
			...started,
			finishReason: "incomplete.content_filter",
		});
		assert.ok(incomplete instanceof GitHubCopilotContentFilterError);
		const otherFinish = classifyGitHubCopilotFailure(new Error("x"), { ...started, finishReason: "stop" });
		assert.ok(otherFinish instanceof GitHubCopilotStreamEndedEarlyError);
		const unknownEvent = classifyGitHubCopilotFailure(Object.assign(new Error("x"), { code: "odd" }), started);
		assert.equal((unknownEvent as GitHubCopilotUnrecognizedResponseError).reason, "unknown-error-event");
		const malformed = classifyGitHubCopilotFailure(new SyntaxError("bad json"), started);
		assert.equal((malformed as GitHubCopilotUnrecognizedResponseError).reason, "malformed-body");
		const malformedBeforeStart = classifyGitHubCopilotFailure(new SyntaxError("bad json"), failure);
		assert.ok(malformedBeforeStart instanceof GitHubCopilotUnrecognizedResponseError);
		const cut = classifyGitHubCopilotFailure(new Error("socket closed"), started);
		assert.ok(cut instanceof GitHubCopilotStreamEndedEarlyError);
		assert.equal(cut.detail, "socket closed");
		assert.equal((cut.cause as Error).message, "socket closed");
	});

	it.each([
		["openai-completions", "content_filter", true],
		["openai-completions", "incomplete.content_filter", false],
		["openai-completions", "refusal", false],
		["openai-responses", "incomplete.content_filter", true],
		["openai-responses", "content_filter", false],
		// A refusal delta that did not end the turn leaves `refusal` behind on Responses.
		["openai-responses", "refusal", false],
		["anthropic-messages", "refusal", true],
		["anthropic-messages", "sensitive", true],
		["anthropic-messages", "content_filter", false],
		["anthropic-messages", "end_turn", false],
		["google-generative-ai", "content_filter", false],
	] as const)("on %s, a %s stop is a content-filter refusal: %s", (api, finishReason, filtered) => {
		const stop = new Error("The model refused to complete the request");
		const error = classifyGitHubCopilotFailure(stop, { modelId: "m", api, streamStarted: true, finishReason });
		assert.equal(error instanceof GitHubCopilotContentFilterError, filtered);
		assert.equal(error?.code, filtered ? "content-filtered" : "stream-ended-early");
		assert.equal(error?.retryable, !filtered);
		assert.equal(error?.detail, "The model refused to complete the request");
		assert.equal(error?.cause, stop);
	});

	it.each([
		{
			name: "the quota header",
			error: () =>
				Object.assign(new Error("429 Too Many Requests"), {
					status: 429,
					headers: new Headers({ "x-ratelimit-exceeded": " Quota_Exceeded ", "retry-after": "228711" }),
				}),
		},
		{ name: "the plain body", error: () => Object.assign(new Error("429 Quota Exceeded"), { status: 429 }) },
		{
			name: "a retry-delay wrapper around the response",
			error: () =>
				Object.assign(
					new Error("Server requested 228711s retry delay (max: 60s). 429 quota exceeded", {
						cause: Object.assign(new Error("429 quota exceeded"), {
							status: 429,
							headers: new Headers({ "x-ratelimit-exceeded": "quota_exceeded" }),
						}),
					}),
					{ status: 429, retryAfterMs: 228_711_000 },
				),
		},
		{
			name: "a retry-delay wrapper around a plain body",
			error: () =>
				Object.assign(
					new Error("Server requested 228711s retry delay (max: 60s).", {
						cause: Object.assign(new Error("429 quota exceeded"), { status: 429 }),
					}),
					{ status: 429, retryAfterMs: 228_711_000 },
				),
		},
	])("types a used-up monthly quota sent as HTTP 429 by $name as quota-exhausted", ({ error }) => {
		const raw = error();
		const typed = classifyGitHubCopilotFailure(raw, failure);
		assert.ok(typed instanceof GitHubCopilotQuotaExhaustedError);
		assert.equal(typed.retryable, false);
		assert.equal(typed.status, 429);
		assert.equal(typed.cause, raw);
	});

	it.each([
		{ name: "a short rate limit", error: Object.assign(new Error("429 Rate limit exceeded"), { status: 429 }) },
		{
			name: "another limit header",
			error: Object.assign(new Error("429 Too Many Requests"), {
				status: 429,
				headers: new Headers({ "x-ratelimit-exceeded": "user_global_rate_limited" }),
			}),
		},
		{ name: "longer quota text", error: Object.assign(new Error("429 quota exceeded soon"), { status: 429 }) },
		{ name: "an empty body", error: Object.assign(new Error(""), { status: 429 }) },
		{
			name: "a wrapper around an empty body",
			error: new Error("Server requested 90s retry delay (max: 60s).", {
				cause: Object.assign(new Error(""), { status: 429 }),
			}),
		},
		{
			name: "a wrapper around a short rate limit",
			error: new Error("Server requested 90s retry delay (max: 60s).", {
				cause: Object.assign(new Error("429 slow down"), { status: 429 }),
			}),
		},
		{
			name: "a non-Error cause",
			error: Object.assign(new Error("429 x", { cause: "quota exceeded" }), { status: 429 }),
		},
	])("keeps $name as rate-limited", ({ error }) => {
		const limited = Object.assign(error, { status: 429, retryAfterMs: 1500 });
		const typed = classifyGitHubCopilotFailure(limited, failure);
		assert.ok(typed instanceof GitHubCopilotRateLimitError);
		assert.equal(typed.retryAfterMs, 1500);
	});

	it("reads Copilot's prompt-token overflow text on a 400 with no recognized code", () => {
		const text = "prompt token count of 209736 exceeds the limit of 128000";
		for (const code of [undefined, "invalid_request_body"]) {
			const raw = Object.assign(httpError(400, { message: text }), code === undefined ? {} : { code });
			const typed = classifyGitHubCopilotFailure(raw, failure);
			assert.ok(typed instanceof GitHubCopilotPromptTooLargeError, code);
			assert.deepEqual([typed.promptTokens, typed.limitTokens], [209_736, 128_000]);
			assert.equal(typed.cause, raw);
		}
		assert.ok(
			classifyGitHubCopilotFailure(httpError(500, { message: text }), failure) instanceof
				GitHubCopilotServiceUnavailableError,
		);
		assert.equal(
			(
				classifyGitHubCopilotFailure(
					httpError(400, { message: "prompt is too long" }),
					failure,
				) as GitHubCopilotInvalidRequestError
			).reason,
			"rejected",
		);
	});

	it("leaves a failure that never reached Copilot to the generic network handling", () => {
		assert.equal(classifyGitHubCopilotFailure(new Error("fetch failed"), failure), undefined);
		assert.equal(classifyGitHubCopilotFailure("thrown text", failure), undefined);
		assert.equal(
			classifyGitHubCopilotFailure(Object.assign(new Error("500"), { status: "500" }), failure),
			undefined,
		);
		const textStatus = Object.assign(new Error("500 boom"), { status: "500" });
		const afterStart = classifyGitHubCopilotFailure(textStatus, { ...failure, streamStarted: true });
		assert.ok(afterStart instanceof GitHubCopilotStreamEndedEarlyError);
		assert.equal(afterStart.status, undefined);
		assert.equal(afterStart.detail, "500 boom");
		const wrapped = classifyGitHubCopilotFailure("thrown text", { ...failure, streamStarted: true });
		assert.ok(wrapped instanceof GitHubCopilotStreamEndedEarlyError);
		assert.equal(wrapped.detail, "thrown text");
		assert.equal((wrapped.cause as Error).cause, "thrown text");
	});

	describe("behind the retry helper's delay-cap wrapper", () => {
		function wrapperAround(response: Error, status = 429, retryAfterMs = 3_600_000): Error {
			return Object.assign(
				new Error(`Server requested ${retryAfterMs / 1000}s retry delay (max: 60s). ${response.message}`, {
					cause: response,
				}),
				{
					status,
					retryAfterMs,
				},
			);
		}

		function response(
			status: number,
			body: Record<string, unknown> | undefined,
			headers: Record<string, string> = {},
		): Error {
			return Object.assign(httpError(status, body), {
				headers: new Headers({ "x-request-id": "req-wrapped", ...headers }),
			});
		}

		it.each([
			{
				name: "a coded quota 429",
				wrapped: wrapperAround(response(429, { message: "You exceeded your quota.", code: "insufficient_quota" })),
				type: GitHubCopilotQuotaExhaustedError,
				providerCode: "insufficient_quota",
				detail: "You exceeded your quota.",
			},
			{
				name: "a coded rate limit",
				wrapped: wrapperAround(response(429, { message: "Slow down", code: "rate_limit_exceeded" })),
				type: GitHubCopilotRateLimitError,
				providerCode: "rate_limit_exceeded",
				detail: "Slow down",
			},
			{
				name: "an uncoded quota 429 with the quota header",
				wrapped: wrapperAround(response(429, undefined, { "x-ratelimit-exceeded": "quota_exceeded" })),
				type: GitHubCopilotQuotaExhaustedError,
				providerCode: undefined,
				detail: "status",
			},
			{
				name: "a coded server error",
				wrapped: wrapperAround(response(503, { message: "Upstream down", code: "server_error" }), 503),
				type: GitHubCopilotServiceUnavailableError,
				providerCode: "server_error",
				detail: "Upstream down",
			},
			{
				name: "a coded model rejection the SDK was told to retry",
				wrapped: wrapperAround(response(400, { message: "Model not supported", code: "model_not_supported" }), 400),
				type: GitHubCopilotModelUnavailableError,
				providerCode: "model_not_supported",
				detail: "Model not supported",
			},
		])("keeps the provider code, request ID and detail of $name", ({ wrapped, type, providerCode, detail }) => {
			const typed = classifyGitHubCopilotFailure(wrapped, failure);
			assert.ok(typed instanceof type);
			assert.equal(typed.providerCode, providerCode);
			assert.equal(typed.requestId, "req-wrapped");
			assert.equal(typed.detail, detail);
			assert.equal(typed.status, (wrapped as Error & { status?: number }).status);
			assert.equal(typed.cause, wrapped);
		});

		it("keeps the wrapper's retry hint on a rate limit", () => {
			const wrapped = wrapperAround(response(429, { message: "Slow down", code: "rate_limit_exceeded" }));
			const typed = classifyGitHubCopilotFailure(wrapped, failure);
			assert.equal((typed as GitHubCopilotRateLimitError).retryAfterMs, 3_600_000);
			const uncoded = classifyGitHubCopilotFailure(wrapperAround(response(429, undefined)), failure);
			assert.equal((uncoded as GitHubCopilotRateLimitError).retryAfterMs, 3_600_000);
		});

		it.each([
			{
				name: "an error that has a status and no cause",
				error: Object.assign(httpError(429, { message: "m", code: "rate_limit_exceeded" }), {
					headers: new Headers({ "x-request-id": "req-own" }),
				}),
				requestId: "req-own",
				providerCode: "rate_limit_exceeded",
			},
			{
				name: "a wrapper whose cause has no status",
				error: Object.assign(
					new Error("wrapped", { cause: Object.assign(new Error("inner"), { code: "insufficient_quota" }) }),
					{ status: 429 },
				),
				requestId: undefined,
				providerCode: undefined,
			},
			{
				name: "a wrapper whose cause is not an error",
				error: Object.assign(new Error("wrapped", { cause: { status: 429, code: "insufficient_quota" } }), {
					status: 429,
				}),
				requestId: undefined,
				providerCode: undefined,
			},
			{
				name: "an error with its own code",
				error: Object.assign(
					new Error("wrapped", { cause: response(429, { message: "m", code: "insufficient_quota" }) }),
					{ status: 429, code: "rate_limit_exceeded" },
				),
				requestId: undefined,
				providerCode: "rate_limit_exceeded",
			},
			{
				name: "an error with its own body",
				error: Object.assign(
					new Error("wrapped", { cause: response(429, { message: "m", code: "insufficient_quota" }) }),
					{ status: 429, error: { message: "outer", code: "rate_limit_exceeded" } },
				),
				requestId: undefined,
				providerCode: "rate_limit_exceeded",
			},
			{
				name: "an error with its own headers",
				error: Object.assign(
					new Error("wrapped", { cause: response(429, { message: "m", code: "insufficient_quota" }) }),
					{ status: 429, headers: new Headers({ "x-request-id": "req-outer" }) },
				),
				requestId: "req-outer",
				providerCode: undefined,
			},
		])("reads $name as its own response", ({ error, requestId, providerCode }) => {
			const typed = classifyGitHubCopilotFailure(error, failure);
			assert.equal(typed?.requestId, requestId);
			assert.equal(typed?.providerCode, providerCode);
			assert.equal(typed?.status, 429);
		});
	});

	it("returns an already typed failure unchanged, also from its cause chain", () => {
		const typed = new GitHubCopilotEmptyResponseError(context);
		assert.equal(classifyGitHubCopilotFailure(typed, failure), typed);
		assert.equal(classifyGitHubCopilotFailure(new Error("wrap", { cause: typed }), failure), typed);
	});

	it("carries the model and API it failed for", () => {
		const error = classifyGitHubCopilotFailure(httpError(500), failure);
		assert.equal(error?.modelId, "grok-4.7");
		assert.equal(error?.api, "openai-responses");
	});
});

describe("GitHub Copilot failures on assistant messages (#4324)", () => {
	it("records the typed error as a diagnostic and leads the error message with it", () => {
		const message = assistant({ errorMessage: "provider text" });
		const error = new GitHubCopilotRateLimitError(context, 4000);
		recordGitHubCopilotError(message, error, "provider text");

		assert.equal(message.errorMessage, `${error.message}\n\nprovider text`);
		assert.equal(message.retryAfterMs, 4000);
		assert.equal(message.diagnostics?.length, 1);
		const diagnostic = message.diagnostics?.[0];
		assert.equal(diagnostic?.type, GITHUB_COPILOT_ERROR_DIAGNOSTIC);
		assert.equal(diagnostic?.type, "github_copilot_error");
		assert.deepEqual(diagnostic?.error, { name: error.name, message: error.message, code: "rate-limited" });
		assert.equal(typeof diagnostic?.timestamp, "number");
		assert.deepEqual(diagnostic?.details, JSON.parse(JSON.stringify(serializeGitHubCopilotError(error))));

		const fromJson = getGitHubCopilotError(JSON.parse(JSON.stringify(message)));
		assert.ok(fromJson instanceof GitHubCopilotRateLimitError);
		assert.equal(fromJson.retryAfterMs, 4000);
	});

	it("keeps a single message when the provider text is the typed message or absent", () => {
		const error = new GitHubCopilotEmptyResponseError(context);
		const same = assistant({ retryAfterMs: 50 });
		recordGitHubCopilotError(same, error, error.message);
		assert.equal(same.errorMessage, error.message);
		assert.equal(same.retryAfterMs, 50);
		const none = assistant();
		recordGitHubCopilotError(none, error);
		assert.equal(none.errorMessage, error.message);
		const noDelay = assistant({ retryAfterMs: 50 });
		recordGitHubCopilotError(noDelay, new GitHubCopilotRateLimitError(context), "x");
		assert.equal(noDelay.retryAfterMs, 50);
	});

	it("reads the latest valid Copilot diagnostic and ignores everything else", () => {
		const first = new GitHubCopilotServiceUnavailableError(context);
		const second = new GitHubCopilotQuotaExhaustedError(context);
		const message = assistant();
		recordGitHubCopilotError(message, first);
		recordGitHubCopilotError(message, second);
		message.diagnostics?.push({ type: "other", timestamp: 0, details: { code: "rate-limited" } });
		message.diagnostics?.push({ type: GITHUB_COPILOT_ERROR_DIAGNOSTIC, timestamp: 0, details: { broken: true } });
		assert.ok(getGitHubCopilotError(message) instanceof GitHubCopilotQuotaExhaustedError);
		assert.equal(getGitHubCopilotError(assistant()), undefined);
		assert.equal(getGitHubCopilotError(undefined), undefined);
		assert.equal(getGitHubCopilotError({ diagnostics: "nope" }), undefined);
		assert.equal(getGitHubCopilotError({ diagnostics: [null, 4] }), undefined);
	});

	it("types only failed messages, never cancelled ones", () => {
		const aborted = assistant({ stopReason: "aborted", errorMessage: "Request was aborted" });
		recordGitHubCopilotFailure(aborted, Object.assign(new Error("x"), { status: 500 }), true);
		assert.equal(aborted.diagnostics, undefined);
		assert.equal(aborted.errorMessage, "Request was aborted");

		const failed = assistant({ errorMessage: "500 boom", rawStopReason: undefined });
		recordGitHubCopilotFailure(failed, Object.assign(new Error("500 boom"), { status: 500 }), false);
		const typed = getGitHubCopilotError(failed);
		assert.ok(typed instanceof GitHubCopilotServiceUnavailableError);
		assert.equal(typed.modelId, "gemini-4-argon");
		assert.equal(typed.api, "openai-completions");
		assert.equal(failed.errorMessage, `${typed.message}\n\n500 boom`);

		const filtered = assistant({
			errorMessage: "Provider finish_reason: content_filter",
			rawStopReason: "content_filter",
		});
		recordGitHubCopilotFailure(filtered, new Error("Provider finish_reason: content_filter"), true);
		assert.ok(getGitHubCopilotError(filtered) instanceof GitHubCopilotContentFilterError);

		const network = assistant({ errorMessage: "fetch failed" });
		recordGitHubCopilotFailure(network, new Error("fetch failed"), false);
		assert.equal(network.diagnostics, undefined);
		assert.equal(network.errorMessage, "fetch failed");
	});

	it("flags an answered-nothing Copilot turn as an empty response", () => {
		const empty = (overrides: Partial<AssistantMessage>) => githubCopilotEmptyResponse(assistant(overrides));
		for (const stopReason of ["stop", "toolUse"] as const) {
			const error = empty({ stopReason, content: [{ type: "thinking", thinking: "", redacted: true }] });
			assert.ok(error instanceof GitHubCopilotEmptyResponseError);
			assert.equal(error.modelId, "gemini-4-argon");
			assert.equal(error.api, "openai-completions");
			assert.ok(empty({ stopReason, content: [{ type: "text", text: " \n " }] }));
		}
		assert.equal(empty({ stopReason: "stop", content: [{ type: "text", text: "hi" }] }), undefined);
		assert.equal(
			empty({ stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "ping", arguments: {} }] }),
			undefined,
		);
		assert.equal(empty({ stopReason: "length" }), undefined);
		assert.equal(empty({ stopReason: "error" }), undefined);
		assert.equal(empty({ stopReason: "stop", provider: "openai" }), undefined);
	});
});

describe("GitHub Copilot guards answer a question, they do not narrow (#4324)", () => {
	const typed = new GitHubCopilotRateLimitError(context, 5000);

	it("are plain boolean functions, not type predicates", () => {
		expectTypeOf(isGitHubCopilotError).toEqualTypeOf<(error: unknown) => boolean>();
		for (const guard of ALL_GUARDS) expectTypeOf(guard).toEqualTypeOf<(error: unknown) => boolean>();
		expectTypeOf(isRetryableGitHubCopilotError).toEqualTypeOf<(error: unknown) => boolean>();
		expectTypeOf(findGitHubCopilotError).returns.toEqualTypeOf<GitHubCopilotError | undefined>();
	});

	it("say yes for a wrapper, a relayed value and a message, whose own shape is not the error's", () => {
		const wrapper = new Error("stage failed", { cause: typed });
		const relayed = JSON.parse(JSON.stringify({ name: "GitHubCopilotRateLimitError", code: "rate-limited" }));
		const message = assistant({ errorMessage: "text" });
		recordGitHubCopilotError(message, typed, "text");
		for (const carrier of [wrapper, relayed, message]) {
			assert.equal(isGitHubCopilotRateLimitError(carrier), true);
			assert.equal(isGitHubCopilotError(carrier), true);
			assert.equal((carrier as { code?: string }).code === "rate-limited", carrier === relayed);
			assert.equal(carrier instanceof GitHubCopilotRateLimitError, false);
			assert.equal(typeof (carrier as { fields?: unknown }).fields, "undefined");
		}
	});

	it("leave the instance to findGitHubCopilotError, which rebuilds a relayed value", () => {
		const wrapper = new Error("stage failed", { cause: typed });
		const found = findGitHubCopilotError(wrapper);
		assert.equal(found, typed);
		assert.equal((found as GitHubCopilotRateLimitError).retryAfterMs, 5000);
		const message = assistant({ errorMessage: "text" });
		recordGitHubCopilotError(message, typed, "text");
		const fromMessage = findGitHubCopilotError({ cause: JSON.parse(JSON.stringify(message)) });
		assert.ok(fromMessage instanceof GitHubCopilotRateLimitError);
		assert.equal(fromMessage.retryAfterMs, 5000);
		assert.deepEqual(fromMessage.fields(), typed.fields());
		const relayed = findGitHubCopilotError({ name: "GitHubCopilotRateLimitError", code: "rate-limited" });
		assert.ok(relayed instanceof GitHubCopilotRateLimitError);
		assert.equal(typeof relayed.fields, "function");
	});
});

describe("GitHub Copilot rehydration validates what it rebuilds (#4324)", () => {
	const REASONS = {
		GitHubCopilotModelUnavailableError: {
			make: (reason: GitHubCopilotModelUnavailableReason) => new GitHubCopilotModelUnavailableError(reason, context),
			valid: ["integration", "not-supported", "wrong-api", "no-endpoint", "not-found"],
			default: "not-supported",
		},
		GitHubCopilotInvalidRequestError: {
			make: (reason: GitHubCopilotInvalidRequestReason) => new GitHubCopilotInvalidRequestError(reason, context),
			valid: ["reasoning-effort", "integration-id", "rejected"],
			default: "rejected",
		},
		GitHubCopilotUnrecognizedResponseError: {
			make: (reason: GitHubCopilotUnrecognizedReason) => new GitHubCopilotUnrecognizedResponseError(reason, context),
			valid: ["unknown-status", "unknown-error-event", "malformed-body"],
			default: "malformed-body",
		},
	} as const;

	it.each(CLASS_CASES.flatMap((first) => CLASS_CASES.map((second) => [first, second] as const)))(
		"rebuilds a $0.name payload only with its own code (against $1.code)",
		(first, second) => {
			const tampered = { ...serializeGitHubCopilotError(first.error), code: second.code };
			const rebuilt = deserializeGitHubCopilotError(tampered);
			if (first.code === second.code) {
				assert.ok(rebuilt instanceof first.error.constructor);
				assert.equal(rebuilt.code, first.code);
			} else {
				assert.equal(rebuilt, undefined);
			}
		},
	);

	it.each(Object.entries(REASONS))("rebuilds %s with each reason it has and rejects any other", (name, spec) => {
		for (const reason of spec.valid) {
			const wire = serializeGitHubCopilotError((spec.make as (reason: string) => GitHubCopilotError)(reason));
			assert.equal(
				(deserializeGitHubCopilotError(JSON.parse(JSON.stringify(wire))) as { reason?: string }).reason,
				reason,
			);
		}
		const wire = serializeGitHubCopilotError((spec.make as (reason: string) => GitHubCopilotError)(spec.valid[0]));
		for (const reason of ["made-up", "", "Integration", 3, true]) {
			assert.equal(
				deserializeGitHubCopilotError({ ...wire, fields: { ...wire.fields, reason } }),
				undefined,
				`${name} ${String(reason)}`,
			);
		}
		const { reason: _reason, ...withoutReason } = wire.fields;
		assert.equal(
			(deserializeGitHubCopilotError({ ...wire, fields: withoutReason }) as { reason?: string }).reason,
			spec.default,
		);
		assert.equal(
			(deserializeGitHubCopilotError({ ...wire, fields: { ...wire.fields, reason: null } }) as { reason?: string })
				.reason,
			spec.default,
		);
	});

	it("ignores a reason on a class that has none, and still rebuilds an unknown name as the base", () => {
		const wire = serializeGitHubCopilotError(new GitHubCopilotQuotaExhaustedError(context));
		assert.ok(
			deserializeGitHubCopilotError({ ...wire, fields: { ...wire.fields, reason: "made-up" } }) instanceof
				GitHubCopilotQuotaExhaustedError,
		);
		const future = deserializeGitHubCopilotError({ ...wire, name: "GitHubCopilotFutureError", code: "rate-limited" });
		assert.equal(future?.name, "GitHubCopilotFutureError");
		assert.equal(future?.code, "rate-limited");
		for (const name of ["toString", "constructor", "__proto__"]) {
			assert.equal(deserializeGitHubCopilotError({ ...wire, name })?.name, name);
		}
		const base = deserializeGitHubCopilotError({ ...wire, name: "GitHubCopilotError", code: "empty-response" });
		assert.equal(base?.code, "empty-response");
	});

	it("reads a tampered diagnostic as no Copilot error, without throwing", () => {
		const message = assistant({ errorMessage: "text" });
		recordGitHubCopilotError(message, new GitHubCopilotInvalidRequestError("rejected", context), "text");
		const wire = message.diagnostics?.[0]?.details as { fields: Record<string, unknown>; code: string };
		for (const tampered of [
			{ ...wire, code: "model-unavailable" },
			{ ...wire, fields: { ...wire.fields, reason: "made-up" } },
		]) {
			const broken = { ...message, diagnostics: [{ ...message.diagnostics?.[0], details: tampered }] };
			assert.equal(getGitHubCopilotError(broken as AssistantMessage), undefined);
			assert.equal(findGitHubCopilotError(new Error("wrapped", { cause: broken })), undefined);
			assert.equal(isGitHubCopilotError(broken), false);
		}
	});
});
