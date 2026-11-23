import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";

describe("model fallback transport failures", () => {
	test("classifies generic connection failures as transport errors for provider-aware fallback", () => {
		const assistantFailure = {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Connection error.",
		};

		const directSignal = normalizeModelFailureSignal(assistantFailure);
		assert.equal(directSignal.kind, "transport_error");
		assert.equal(directSignal.source, "assistant_message");
		assert.equal(isRetryableModelFailure(assistantFailure), true);

		const wrappedSignal = normalizeModelFailureSignal(new Error("Connection error.", { cause: assistantFailure }));
		assert.equal(wrappedSignal.kind, "transport_error");
		assert.equal(isRetryableModelFailure(new Error("Connection error.", { cause: assistantFailure })), true);
	});

	test("classifies UND_ERR_SOCKET as transport_error across structured codes and error messages", () => {
		const bareCode = { code: "UND_ERR_SOCKET" };
		assert.equal(normalizeModelFailureSignal(bareCode).kind, "transport_error");
		assert.equal(isRetryableModelFailure(bareCode), true);
		assert.equal(isRetryableSameModelFailure(bareCode), true);

		const errorWithCode = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
		assert.equal(normalizeModelFailureSignal(errorWithCode).kind, "transport_error");

		const messageOnly = new Error("Connection error: other side closed (UND_ERR_SOCKET)");
		assert.equal(normalizeModelFailureSignal(messageOnly).kind, "transport_error");
	});

	test.each(["UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"])(
		"classifies %s as network_timeout across structured codes and error messages",
		(code) => {
			assert.equal(normalizeModelFailureSignal({ code }).kind, "network_timeout");
			assert.equal(normalizeModelFailureSignal(new Error(code)).kind, "network_timeout");
			assert.equal(isRetryableModelFailure({ code }), true);
			assert.equal(isRetryableSameModelFailure({ code }), true);
		},
	);
});
