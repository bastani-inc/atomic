import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { isDecisionTimeoutError } from "../../packages/coding-agent/src/core/decision/errors.js";
import { setProviderRequestGate } from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { generateStructuredOutput } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	decisionMessage,
	messageStream,
	registeredDecisionRuntime,
	structuredOutputRequest,
} from "../helpers/structured-output.js";

async function request(chat?: () => ReturnType<typeof messageStream>) {
	const { registry } = await registeredDecisionRuntime(
		chat ??
			(() => {
				throw new Error("unexpected chat fallback");
			}),
	);
	return {
		...structuredOutputRequest(),
		modelRegistry: registry,
		model: chat ? "decision-test/chat" : "typesafe/jev-latest",
		timeoutMs: 1000,
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
	};
}

afterEach(() => {
	setProviderRequestGate(undefined);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

test("structured output does not send its classifier retry if its timeout passed before its timer fired (#5627)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const clock = vi.spyOn(performance, "now").mockReturnValue(10);
	const transport = vi.fn(async () => {
		clock.mockReturnValue(1010);
		return new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } });
	});
	vi.stubGlobal("fetch", transport);
	const failure = await generateStructuredOutput(await request()).catch((error: unknown) => error);
	assert.equal(transport.mock.calls.length, 1);
	assert.ok(isDecisionTimeoutError(failure), String(failure));
	assert.equal(failure.phase, "classifier");
});

test("a structured output retry can expire while its provider slot is being granted (#5627)", async () => {
	const chat = vi.fn(() => messageStream({ ...decisionMessage(), stopReason: "error", errorMessage: "503" }));
	const input = await request(chat);
	const clock = vi.spyOn(performance, "now").mockReturnValue(10);
	let admissions = 0;
	setProviderRequestGate(async () => {
		if (++admissions === 2) clock.mockReturnValue(1010);
	});
	const failure = await generateStructuredOutput(input).catch((error: unknown) => error);
	assert.equal(admissions, 2);
	assert.equal(chat.mock.calls.length, 1);
	assert.ok(isDecisionTimeoutError(failure), String(failure));
});

test("an initial provider abort is not mistaken for a refused structured output retry (#5627)", async () => {
	const clock = vi.spyOn(performance, "now").mockReturnValue(10);
	const chat = vi.fn(() => {
		clock.mockReturnValue(1010);
		return messageStream({ ...decisionMessage(), stopReason: "aborted" });
	});
	await assert.rejects(generateStructuredOutput(await request(chat)), /aborted; no fallback was attempted/);
	assert.equal(chat.mock.calls.length, 1);
});
