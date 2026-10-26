import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const bedrockMock = vi.hoisted(() => {
	/** Stands in for the SDK's service exception base class until the mocked module defines the real one. */
	class PendingServiceException extends Error {}
	const state: { error: Error | undefined; ServiceException: new (message?: string) => Error } = {
		error: undefined,
		ServiceException: PendingServiceException,
	};
	return state;
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	bedrockMock.ServiceException = BedrockRuntimeServiceException;

	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };

		send(): Promise<never> {
			return Promise.reject(bedrockMock.error ?? new Error("test did not configure an error"));
		}
	}

	class ConverseStreamCommand {
		readonly input: object;
		constructor(input: object) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "@bastani/pi-ai/api/bedrock-converse-stream";
import { getModel, normalizeContext } from "@bastani/pi-ai/compat";
import { normalizeModelFailureSignal } from "../../packages/coding-agent/src/core/model-fallback-failures.js";
import {
	providerCooldownMs,
	providerUnavailableMs,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { admitProviderStream } from "../../packages/coding-agent/src/core/provider-request-admission.js";

const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

/** What the SDK throws for a non-2xx response: the modeled code as `name`, the raw HTTP response on `$response`. */
function serviceException(name: string, status: number, message: string, headers: Record<string, string>): Error {
	const error = new bedrockMock.ServiceException(message);
	error.name = name;
	return Object.assign(error, {
		$metadata: { httpStatusCode: status, requestId: "request-1" },
		$response: { statusCode: status, headers, body: undefined },
	});
}

/** One real Bedrock stream turn through admission, as the session runs it, ending in the returned failure. */
async function failedBedrockTurn() {
	const admission = await admitProviderStream(model, { cacheRetention: "none", maxRetries: 0 }, true);
	const message = await admission.run(() => streamBedrock(model, context, admission.options).result());
	if (message.stopReason === "error") admission.observeFailure(message);
	return message;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	bedrockMock.error = undefined;
});
afterEach(() => vi.useRealTimers());

test("a throttled Bedrock stream is a rate limit that cools the model down for its Retry-After", async () => {
	bedrockMock.error = serviceException(
		"ThrottlingException",
		429,
		"Too many tokens, please wait before trying again.",
		{
			"retry-after": "7",
		},
	);
	const message = await failedBedrockTurn();
	assert.equal(message.retryAfterMs, 7000);
	assert.equal(normalizeModelFailureSignal(message).kind, "rate_limit");
	assert.equal(providerCooldownMs(model.provider, model.id), 7000);
});

test("a Bedrock service-quota exception from the stream is an exhausted quota", async () => {
	bedrockMock.error = serviceException(
		"ServiceQuotaExceededException",
		400,
		"Your request exceeds the service quota for your account.",
		{ "retry-after": "3600" },
	);
	const message = await failedBedrockTurn();
	assert.equal(normalizeModelFailureSignal(message).kind, "quota_exhausted");
	assert.equal(providerUnavailableMs(model.provider, model.id), 3_600_000);
});
