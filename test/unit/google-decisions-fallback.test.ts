import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { decide } from "../../packages/coding-agent/src/core/decision/decide.js";
import { DecisionOutputError, DecisionProviderError } from "../../packages/coding-agent/src/core/decision/errors.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	decisionChatModel,
	decisionMessage,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

const modelId = "google-decisions/gemini-decision-1";
const questions = {
	queue: { type: "choice", instructions: "Choose a queue.", criteria: { billing: "Money", shipping: "Delivery" } },
} as const;
let baseUrl: string;
let calls: number;
let reply: () => Response;
const server = createServer(async (request, response) => {
	calls++;
	for await (const _chunk of request) {
		/* Drain the request before replying. */
	}
	const result = reply();
	response.writeHead(result.status, Object.fromEntries(result.headers));
	response.end(await result.text());
});

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	baseUrl = `http://127.0.0.1:${address.port}/v1beta`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
	calls = 0;
});

async function configuredDecision() {
	const chat = vi.fn(() => messageStream(decisionMessage({ queue: "shipping" })));
	const { runtime, registry } = await registeredDecisionRuntime(chat);
	runtime.registerProvider("google-decisions", { baseUrl, apiKey: "mock-key" });
	const settings = SettingsManager.inMemory({ decisionModel: modelId, retry: { provider: { maxRetryDelayMs: 50 } } });
	return {
		chat,
		request: {
			settings,
			modelRegistry: registry,
			currentModel: decisionChatModel,
			state: { shipment: "late" },
			questions,
		},
	};
}

function longThrottle(): Response {
	return Response.json(
		{
			error: {
				status: "RESOURCE_EXHAUSTED",
				details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }],
			},
		},
		{ status: 429 },
	);
}

test("a Gemini classifier skips the configured over-cap delay and falls back to chat (#6773)", async () => {
	reply = longThrottle;
	const { request, chat } = await configuredDecision();
	const result = await decide(request);

	assert.equal(calls, 1);
	assert.equal(chat.mock.calls.length, 1);
	assert.equal(result.source, "chat");
	assert.equal(result.fallback?.from, modelId);
	assert.equal(result.answers.queue.choice, "shipping");
});

test("a Gemini decision needing probabilities returns a typed throttle with the server hint (#6773)", async () => {
	reply = longThrottle;
	const { request, chat } = await configuredDecision();
	await assert.rejects(decide({ ...request, requireProbabilities: true }), (error) => {
		assert(error instanceof DecisionProviderError);
		assert.equal(error.providerStatus, 429);
		assert.equal(error.providerCode, "rate_limit_exceeded");
		assert.equal(error.retryAfterMs, 3000);
		return true;
	});
	assert.equal(calls, 1);
	assert.equal(chat.mock.calls.length, 0);
});

test("a malformed Gemini answer produces DecisionOutputError when no chat answer is allowed (#6773)", async () => {
	reply = () => Response.json({ answers: {} });
	const { request, chat } = await configuredDecision();
	await assert.rejects(decide({ ...request, requireProbabilities: true }), DecisionOutputError);
	assert.equal(calls, 1);
	assert.equal(chat.mock.calls.length, 0);
});
