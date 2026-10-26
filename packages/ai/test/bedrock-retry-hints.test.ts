import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

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

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

/** What the SDK throws for a non-2xx response: the modeled code as `name`, the raw HTTP response on `$response`. */
function serviceException(name: string, headers: Record<string, string>): Error {
	const error = new bedrockMock.ServiceException("Too many requests, please wait before trying again.");
	error.name = name;
	return Object.assign(error, {
		$metadata: { httpStatusCode: 429, requestId: "request-1" },
		$response: { statusCode: 429, headers, body: undefined },
	});
}

async function runBedrock(): Promise<AssistantMessage> {
	return streamBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
		cacheRetention: "none",
		maxRetries: 0,
	}).result();
}

beforeEach(() => {
	bedrockMock.error = undefined;
});

describe("Bedrock retry hints", () => {
	it("reports the Retry-After header of a throttled request", async () => {
		bedrockMock.error = serviceException("ThrottlingException", { "retry-after": "7" });
		const message = await runBedrock();
		assert.equal(message.stopReason, "error");
		assert.equal(message.retryAfterMs, 7000);
	});

	it("reads the header case-insensitively and prefers the larger hint", async () => {
		bedrockMock.error = serviceException("ThrottlingException", { "Retry-After": "2", "retry-after-ms": "4500" });
		assert.equal((await runBedrock()).retryAfterMs, 4500);
	});

	it("reports no hint when the response carries none", async () => {
		bedrockMock.error = serviceException("ThrottlingException", { "x-amzn-requestid": "request-1" });
		assert.equal((await runBedrock()).retryAfterMs, undefined);
	});
});
