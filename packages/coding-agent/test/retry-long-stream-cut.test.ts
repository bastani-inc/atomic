import assert from "node:assert/strict";
import {
	type AssistantMessage,
	type GitHubCopilotError,
	GitHubCopilotRateLimitError,
	GitHubCopilotStreamEndedEarlyError,
	recordGitHubCopilotError,
} from "@bastani/pi-ai";
import { describe, test } from "vitest";
import { streamCutDurationMs } from "../src/core/model-fallback-failures.ts";
import {
	isLongStreamCut,
	LONG_STREAM_CUT_ADVICE,
	LONG_STREAM_CUT_MS,
	MAX_LONG_STREAM_CUT_RETRIES,
	nextRetryDecision,
	repeatsLongStreamCut,
} from "../src/core/retry-policy.ts";

const context = { modelId: "claude-opus-5.5", api: "anthropic-messages" };
const settings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

function streamCut(durationMs: number | undefined): GitHubCopilotStreamEndedEarlyError {
	return new GitHubCopilotStreamEndedEarlyError(context, { durationMs, startedContent: true });
}

function failedMessage(error: GitHubCopilotError): AssistantMessage {
	const message = {
		role: "assistant",
		content: [],
		api: context.api,
		provider: "github-copilot",
		model: context.modelId,
		stopReason: "error",
		errorMessage: error.message,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		timestamp: 0,
	} as unknown as AssistantMessage;
	recordGitHubCopilotError(message, error, error.message);
	return message;
}

describe("long stream cuts (#4626)", () => {
	test("the threshold is five minutes and one extra retry is allowed (#4626)", () => {
		assert.equal(LONG_STREAM_CUT_MS, 5 * 60_000);
		assert.equal(MAX_LONG_STREAM_CUT_RETRIES, 1);
	});

	test("a stream cut counts as long from the threshold on, not before (#4626)", () => {
		assert.equal(isLongStreamCut(failedMessage(streamCut(LONG_STREAM_CUT_MS - 1))), false);
		assert.equal(isLongStreamCut(failedMessage(streamCut(LONG_STREAM_CUT_MS))), true);
		assert.equal(isLongStreamCut(failedMessage(streamCut(LONG_STREAM_CUT_MS + 1))), true);
		assert.equal(isLongStreamCut(failedMessage(streamCut(0))), false);
	});

	test("a cut with no duration, another failure and plain text never count as long (#4626)", () => {
		assert.equal(isLongStreamCut(failedMessage(streamCut(undefined))), false);
		assert.equal(streamCutDurationMs(failedMessage(streamCut(undefined))), undefined);
		assert.equal(isLongStreamCut(failedMessage(new GitHubCopilotRateLimitError(context))), false);
		assert.equal(
			isLongStreamCut(new Error("GitHub Copilot response stream ended early (stream-ended-early)")),
			false,
		);
		assert.equal(isLongStreamCut(undefined), false);
	});

	test("the duration is read from the typed error wherever it travels (#4626)", () => {
		const error = streamCut(412_345);
		const message = failedMessage(error);

		assert.equal(streamCutDurationMs(error), 412_345);
		assert.equal(streamCutDurationMs(message), 412_345);
		assert.equal(streamCutDurationMs(new Error("turn failed", { cause: error })), 412_345);
		assert.equal(streamCutDurationMs(new Error("turn failed", { cause: message })), 412_345);
		assert.equal(streamCutDurationMs(JSON.parse(JSON.stringify(message))), 412_345);
	});

	test("short cuts keep the ordinary budget whatever long cuts came before (#4626)", () => {
		const short = failedMessage(streamCut(LONG_STREAM_CUT_MS - 1));

		assert.deepEqual(nextRetryDecision(settings, 0, true, short, 0), { attempt: 1, delayMs: 2000 });
		assert.deepEqual(nextRetryDecision(settings, 1, true, short, MAX_LONG_STREAM_CUT_RETRIES), {
			attempt: 2,
			delayMs: 4000,
		});
		assert.deepEqual(nextRetryDecision(settings, 2, true, short, 5), { attempt: 3, delayMs: 8000 });
		assert.equal(nextRetryDecision(settings, 3, true, short, 0), undefined);
	});

	test("a long cut gets one more same-model retry, and a second long cut gets none (#4626)", () => {
		const long = failedMessage(streamCut(LONG_STREAM_CUT_MS));

		assert.deepEqual(nextRetryDecision(settings, 0, true, long, 0), { attempt: 1, delayMs: 2000 });
		assert.equal(nextRetryDecision(settings, 1, true, long, 1), undefined);
		assert.equal(nextRetryDecision(settings, 1, true, long, 2), undefined);
	});

	test("a caller that does not count long-cut retries keeps today's policy (#4626)", () => {
		const long = failedMessage(streamCut(LONG_STREAM_CUT_MS * 2));

		assert.deepEqual(nextRetryDecision(settings, 2, true, long), { attempt: 3, delayMs: 8000 });
		assert.equal(nextRetryDecision(settings, 3, true, long), undefined);
	});

	test("the ordinary gates still apply to a first long cut (#4626)", () => {
		const long = failedMessage(streamCut(LONG_STREAM_CUT_MS));

		assert.equal(nextRetryDecision(settings, 3, true, long, 0), undefined);
		assert.equal(nextRetryDecision(settings, 0, false, long, 0), undefined);
		assert.equal(nextRetryDecision({ ...settings, enabled: false }, 0, true, long, 0), undefined);
		assert.equal(nextRetryDecision(undefined, 0, true, long, 0), undefined);
	});

	test("only a long cut repeats a long cut (#4626)", () => {
		const long = failedMessage(streamCut(LONG_STREAM_CUT_MS));
		const short = failedMessage(streamCut(LONG_STREAM_CUT_MS - 1));

		assert.equal(repeatsLongStreamCut(long, 0), false);
		assert.equal(repeatsLongStreamCut(long, MAX_LONG_STREAM_CUT_RETRIES), true);
		assert.equal(repeatsLongStreamCut(short, MAX_LONG_STREAM_CUT_RETRIES), false);
		assert.equal(repeatsLongStreamCut(failedMessage(new GitHubCopilotRateLimitError(context)), 1), false);
	});

	test("the advice names splitting the work, lowering the thinking effort and another model (#4626)", () => {
		assert.match(LONG_STREAM_CUT_ADVICE, /Split the work into smaller steps/);
		assert.match(LONG_STREAM_CUT_ADVICE, /lower the thinking effort/);
		assert.match(LONG_STREAM_CUT_ADVICE, /another model/);
		assert.match(LONG_STREAM_CUT_ADVICE, /fallbackModels/);
		assert.match(LONG_STREAM_CUT_ADVICE, /5 minutes/);
	});
});
