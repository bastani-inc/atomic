import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { stream as streamOpenAICompletions } from "@bastani/atomic-ai/api/openai-completions";
import type { AssistantMessage, Model } from "@bastani/atomic-ai/compat";
import { normalizeContext } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { _isFallbackableError, _isRetryableError } from "../../packages/coding-agent/src/core/agent-session-retry.js";
import {
	isProviderCredentialRejection,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";
import { createTestCertificate } from "../helpers/tls-certificates.js";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

let server: Server | undefined;

afterEach(async () => {
	const running = server;
	server = undefined;
	if (running !== undefined) await new Promise<void>((resolve) => running.close(() => resolve()));
});

/** A custom OpenAI-compatible model whose endpoint shows a self-signed certificate. */
async function refusedTurn(): Promise<{ message: AssistantMessage; host: string }> {
	const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost"] });
	const listening = createServer({ cert: certificate.cert, key: certificate.key }, (_request, response) =>
		response.end(),
	);
	listening.on("tlsClientError", () => {});
	server = listening;
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
	const address = listening.address();
	assert.ok(address !== null && typeof address === "object");
	const host = `localhost:${address.port}`;
	const model: Model<"openai-completions"> = {
		id: "self-hosted",
		name: "Self-hosted",
		api: "openai-completions",
		provider: "self-hosted",
		baseUrl: `https://${host}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
	const message = await streamOpenAICompletions(model, context, { apiKey: "test-key", maxRetries: 0 }).result();
	assert.equal(message.stopReason, "error");
	return { message, host };
}

/** The main chat's decisions for this message, with a configured fallback chain. */
function mainChat(message: AssistantMessage): { retry: boolean; fallBack: boolean } {
	const session = { model: undefined, _fallbackModels: [{ provider: "anthropic", id: "claude-opus-4-8" }] };
	return {
		retry: _isRetryableError.call(session as never, message),
		fallBack: _isFallbackableError.call(session as never, message),
	};
}

test("a model request refused for its TLS certificate is not retried on the same model, and may fall back like a rejected credential (#6114)", async () => {
	const { message, host } = await refusedTurn();

	for (const failure of [message, JSON.parse(JSON.stringify(message)) as AssistantMessage]) {
		const signal = normalizeModelFailureSignal(failure);
		assert.equal(signal.kind, "certificate_refused");
		assert.equal(signal.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
		assert.ok(signal.message.startsWith(`The TLS certificate for ${host} was not accepted`), signal.message);
		assert.equal(isRetryableSameModelFailure(failure), false);
		assert.equal(isRetryableModelFailure(failure), true);
		assert.equal(isProviderCredentialRejection(failure), false);
		assert.deepEqual(mainChat(failure), { retry: false, fallBack: true });
	}
});

test("a thrown failure whose causes carry a refused certificate is classified the same way (#6114)", () => {
	const refusal = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
	const thrown = new Error("Connection error.", { cause: new TypeError("fetch failed", { cause: refusal }) });

	assert.equal(normalizeModelFailureSignal(thrown).kind, "certificate_refused");
	assert.equal(isRetryableSameModelFailure(thrown), false);
	assert.equal(isRetryableModelFailure(thrown), true);
});

test("a connection reset, and a 502 whose body quotes a certificate code, keep their same-model retries (#6114)", () => {
	const reset = new Error("Connection error.", {
		cause: new TypeError("fetch failed", {
			cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
		}),
	});
	const answered = Object.assign(new Error("502 upstream TLS: CERT_HAS_EXPIRED certificate has expired"), {
		status: 502,
		code: "CERT_HAS_EXPIRED",
	});
	for (const failure of [reset, answered]) {
		assert.notEqual(normalizeModelFailureSignal(failure).kind, "certificate_refused", failure.message);
		assert.equal(isRetryableSameModelFailure(failure), true, failure.message);
	}
});
