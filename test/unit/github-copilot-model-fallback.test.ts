import assert from "node:assert/strict";
import {
	GitHubCopilotAuthenticationError,
	GitHubCopilotContentFilterError,
	GitHubCopilotEmptyResponseError,
	type GitHubCopilotError,
	type GitHubCopilotErrorCode,
	GitHubCopilotInvalidRequestError,
	GitHubCopilotModelUnavailableError,
	GitHubCopilotPromptTooLargeError,
	GitHubCopilotQuotaExhaustedError,
	GitHubCopilotRateLimitError,
	GitHubCopilotServiceUnavailableError,
	GitHubCopilotStreamEndedEarlyError,
	GitHubCopilotUnrecognizedResponseError,
	getGitHubCopilotError,
	recordGitHubCopilotError,
	recordGitHubCopilotFailure,
	serializeGitHubCopilotError,
} from "@bastani/pi-ai";
import type { Api, AssistantMessage, Model } from "@bastani/pi-ai/compat";
import { getModel, streamSimple } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import { _isFallbackableError, _isRetryableError } from "../../packages/coding-agent/src/core/agent-session-retry.js";
import {
	isContentFilterRefusal,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	isUnrecognizedModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";
import { WorkflowPromptModelFailure } from "../../packages/workflows/src/runs/foreground/stage-runner-messages.js";

const context = { modelId: "gemini-4-argon", api: "openai-completions", status: 400 };

interface DecisionCase {
	readonly error: GitHubCopilotError;
	readonly kind: string;
	/** Same request again on the same model. */
	readonly sameModel: boolean;
	/** Spend the next configured fallback model. */
	readonly fallback: boolean;
}

const DECISIONS: Readonly<Record<GitHubCopilotErrorCode, DecisionCase>> = {
	"model-unavailable": {
		error: new GitHubCopilotModelUnavailableError("integration", context),
		kind: "model_unavailable",
		sameModel: false,
		fallback: true,
	},
	"rate-limited": {
		error: new GitHubCopilotRateLimitError({ ...context, status: 429 }, 1000),
		kind: "rate_limit",
		sameModel: true,
		fallback: true,
	},
	"quota-exhausted": {
		error: new GitHubCopilotQuotaExhaustedError({ ...context, status: 402 }),
		kind: "quota_exhausted",
		sameModel: false,
		fallback: true,
	},
	"content-filtered": {
		error: new GitHubCopilotContentFilterError({ ...context, status: 422 }),
		kind: "content_filter",
		sameModel: false,
		fallback: true,
	},
	"prompt-too-large": {
		error: new GitHubCopilotPromptTooLargeError(context, { promptTokens: 2, limitTokens: 1 }),
		kind: "request_incompatible",
		sameModel: false,
		fallback: true,
	},
	"invalid-request": {
		error: new GitHubCopilotInvalidRequestError("reasoning-effort", context),
		kind: "request_incompatible",
		sameModel: false,
		fallback: true,
	},
	"authentication-failed": {
		error: new GitHubCopilotAuthenticationError({ ...context, status: 401 }),
		kind: "auth_on_candidate_provider",
		sameModel: false,
		fallback: true,
	},
	"service-unavailable": {
		error: new GitHubCopilotServiceUnavailableError({ ...context, status: 529 }),
		kind: "provider_unavailable",
		sameModel: true,
		fallback: true,
	},
	"stream-ended-early": {
		error: new GitHubCopilotStreamEndedEarlyError({ modelId: context.modelId, api: context.api }),
		kind: "transport_error",
		sameModel: true,
		fallback: true,
	},
	"empty-response": {
		error: new GitHubCopilotEmptyResponseError({ modelId: context.modelId, api: context.api }),
		kind: "transport_error",
		sameModel: true,
		fallback: true,
	},
	"unrecognized-response": {
		error: new GitHubCopilotUnrecognizedResponseError("malformed-body", {
			modelId: context.modelId,
			api: context.api,
		}),
		kind: "provider_unavailable",
		sameModel: true,
		fallback: true,
	},
};

function failedMessage(error: GitHubCopilotError, providerText = "provider text"): AssistantMessage {
	const message = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "github-copilot",
		model: "gemini-4-argon",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "error",
		timestamp: 0,
	} as unknown as AssistantMessage;
	recordGitHubCopilotError(message, error, providerText);
	return message;
}

function session(options: { fallbackOnContentFilter?: boolean; fallbackModels?: string[] } = {}) {
	return {
		model: { provider: "github-copilot", id: "gemini-4-argon", contextWindow: 1_000_000 } as Model<Api>,
		_fallbackModels: options.fallbackModels ?? ["openai/gpt-6-sol"],
		settingsManager: {
			getRetrySettings: () => ({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 1000,
				...(options.fallbackOnContentFilter === undefined
					? {}
					: { fallbackOnContentFilter: options.fallbackOnContentFilter }),
			}),
		},
	};
}

describe("typed GitHub Copilot failures drive retry and fallback (#4324)", () => {
	test.each(Object.entries(DECISIONS))("%s", (code, decision) => {
		assert.equal(decision.error.code, code);
		// Text that, on its own, reads as a different failure: the typed code must win.
		const misleading = failedMessage(decision.error, "429 Too Many Requests: rate limit exceeded");
		const wire = JSON.parse(JSON.stringify(misleading)) as AssistantMessage;
		const carriers = [
			misleading,
			wire,
			decision.error,
			new Error("wrapped", { cause: decision.error }),
			// A workflow stage wraps the failed assistant message; its typed error rides in the message's diagnostics.
			new WorkflowPromptModelFailure(misleading),
			JSON.parse(JSON.stringify({ name: "WorkflowPromptModelFailure", message: "failed", cause: wire })),
			new Error("subagent failed", { cause: new WorkflowPromptModelFailure(wire) }),
		];
		for (const carrier of carriers) {
			const signal = normalizeModelFailureSignal(carrier);
			assert.equal(signal.kind, decision.kind);
			assert.equal(signal.code, code);
			assert.equal(signal.name, decision.error.name);
			assert.equal(isRetryableModelFailure(carrier), decision.fallback);
			assert.equal(isRetryableSameModelFailure(carrier), decision.sameModel);
			assert.equal(isUnrecognizedModelFailure(carrier), false);
			assert.equal(isContentFilterRefusal(carrier), code === "content-filtered");
			assert.notEqual(signal.kind, "cancelled");
		}
		assert.equal(normalizeModelFailureSignal(misleading).source, "assistant_message");
		assert.equal(normalizeModelFailureSignal(decision.error).source, "throw");
		assert.equal(normalizeModelFailureSignal(serializeGitHubCopilotError(decision.error)).kind, decision.kind);
		assert.equal(normalizeModelFailureSignal(serializeGitHubCopilotError(decision.error)).source, "structured");
	});

	test("the session retries, falls back, or compacts as each code says", () => {
		const live = session();
		for (const [code, decision] of Object.entries(DECISIONS)) {
			const message = failedMessage(decision.error);
			const overflow = code === "prompt-too-large";
			assert.equal(_isRetryableError.call(live as never, message), decision.sameModel, `${code} same-model retry`);
			assert.equal(
				_isFallbackableError.call(live as never, message),
				overflow ? false : decision.fallback,
				`${code} fallback`,
			);
		}
	});

	test("a content filter refusal falls back only when retry.fallbackOnContentFilter allows it", () => {
		const refused = failedMessage(DECISIONS["content-filtered"].error);
		assert.equal(isContentFilterRefusal(refused), true);
		assert.equal(isRetryableModelFailure(refused, { fallbackOnContentFilter: false }), false);
		assert.equal(_isFallbackableError.call(session({ fallbackOnContentFilter: true }) as never, refused), true);
		assert.equal(_isFallbackableError.call(session({ fallbackOnContentFilter: false }) as never, refused), false);
		// Without fallback the refusal is retried as a bounded safety refusal, never sent to another model.
		assert.equal(_isRetryableError.call(session({ fallbackOnContentFilter: false }) as never, refused), true);
		assert.equal(_isRetryableError.call(session({ fallbackOnContentFilter: true }) as never, refused), false);
	});

	test.each([
		{ fallbackOnContentFilter: true, sameModel: false, fallback: true },
		{ fallbackOnContentFilter: false, sameModel: true, fallback: false },
	])(
		"a Claude refusal stop on Messages follows retry.fallbackOnContentFilter=$fallbackOnContentFilter",
		({ fallbackOnContentFilter, sameModel, fallback }) => {
			for (const stop of ["refusal", "sensitive"]) {
				const refused = {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "github-copilot",
					model: "claude-sonnet-5",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					stopReason: "error",
					rawStopReason: stop,
					errorMessage: "The model refused to complete the request",
					timestamp: 0,
				} as unknown as AssistantMessage;
				recordGitHubCopilotFailure(refused, new Error("The model refused to complete the request"), true);
				assert.equal(normalizeModelFailureSignal(refused).kind, "content_filter", stop);
				const live = session({ fallbackOnContentFilter });
				assert.equal(_isRetryableError.call(live as never, refused), sameModel, stop);
				assert.equal(_isFallbackableError.call(live as never, refused), fallback, stop);
			}
		},
	);

	test.each(Object.entries(DECISIONS))("no text of %s reads as a cancellation", (_code, decision) => {
		const message = failedMessage(decision.error, "provider text");
		for (const text of [decision.error.message, decision.error.hint, message.errorMessage ?? ""]) {
			assert.notEqual(normalizeModelFailureSignal(text).kind, "cancelled", text);
			assert.notEqual(normalizeModelFailureSignal(new Error(text)).kind, "cancelled", text);
		}
	});

	test.each([
		{
			name: "a coded quota 429",
			status: 429,
			body: { message: "You exceeded your quota.", code: "insufficient_quota" },
			kind: "quota_exhausted",
			sameModel: false,
		},
		{
			name: "a coded rate limit",
			status: 429,
			body: { message: "Slow down", code: "rate_limit_exceeded" },
			kind: "rate_limit",
			sameModel: true,
		},
		{
			name: "a coded model rejection the SDK was told to retry",
			status: 400,
			body: { message: "Model not supported", code: "model_not_supported" },
			kind: "model_unavailable",
			sameModel: false,
		},
	])("decides $name the same with provider retries on and off", async ({ status, body, kind, sameModel }) => {
		const model = getModel("github-copilot", "gemini-4-argon") as Model<Api>;
		const respond = () =>
			new Response(JSON.stringify({ error: body }), {
				status,
				headers: { "content-type": "text/plain", "retry-after": "3600", "x-should-retry": "true" },
			});
		const results: AssistantMessage[] = [];
		for (const maxRetries of [0, 1]) {
			let calls = 0;
			const message = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
					maxRetries,
					fetch: Object.assign(
						async () => {
							calls += 1;
							return respond();
						},
						{ preconnect: () => undefined },
					),
				},
			).result();
			assert.equal(calls, 1);
			results.push(message);
		}
		const live = session();
		for (const message of results) {
			const signal = normalizeModelFailureSignal(new WorkflowPromptModelFailure(message));
			assert.equal(signal.kind, kind);
			assert.equal(signal.code, getGitHubCopilotError(message)?.code);
			assert.equal(_isRetryableError.call(live as never, message), sameModel);
			assert.equal(isRetryableSameModelFailure(new WorkflowPromptModelFailure(message)), sameModel);
			assert.equal(_isFallbackableError.call(live as never, message), true);
		}
		assert.equal(getGitHubCopilotError(results[1])?.providerCode, body.code);
	});

	test("an unrecognized Copilot response is retried on the same model even without a fallback chain", () => {
		const unrecognized = failedMessage(DECISIONS["unrecognized-response"].error);
		assert.equal(_isRetryableError.call(session({ fallbackModels: [] }) as never, unrecognized), true);
	});
});
