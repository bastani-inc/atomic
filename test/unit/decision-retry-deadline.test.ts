import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { decide } from "../../packages/coding-agent/src/core/decision/decide.js";
import {
	isDecisionProviderError,
	isDecisionTimeoutError,
} from "../../packages/coding-agent/src/core/decision/errors.js";
import type { DecisionRequest } from "../../packages/coding-agent/src/core/decision/types.js";
import { setProviderRequestGate } from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	decisionChatModel,
	decisionMessage,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

async function request(chat?: () => ReturnType<typeof messageStream>): Promise<DecisionRequest> {
	const { registry } = await registeredDecisionRuntime(
		chat ??
			(() => {
				throw new Error("unexpected chat fallback");
			}),
	);
	return {
		state: { task: "Review the patch" },
		questions: {
			ready: { type: "bool", instructions: "Is the patch ready?", criteria: { true: "Ready", false: "Not ready" } },
		},
		settings: SettingsManager.inMemory({ decisionModel: chat ? "" : "typesafe/jev-latest" }),
		currentModel: decisionChatModel,
		modelRegistry: registry,
		deadline: 1000,
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		requireProbabilities: !chat,
	};
}

function busyClassifier(clockAtFailure: number) {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const clock = vi.spyOn(performance, "now").mockReturnValue(10);
	const transport = vi.fn(async () => {
		clock.mockReturnValue(clockAtFailure);
		return new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } });
	});
	vi.stubGlobal("fetch", transport);
	return transport;
}

afterEach(() => {
	setProviderRequestGate(undefined);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

test("a decision does not send its classifier retry if its own deadline passed before the timer fired (#5627)", async () => {
	const transport = busyClassifier(1010);
	const failure = await decide(await request()).catch((error: unknown) => error);
	assert.equal(transport.mock.calls.length, 1);
	assert.ok(isDecisionTimeoutError(failure), String(failure));
	assert.equal(failure.phase, "classifier");
});

test("a decision uses the caller's earlier retry deadline instead of restarting its budget (#5627)", async () => {
	const transport = busyClassifier(60);
	const controller = new AbortController();
	const reason = new Error("workflow prediction expired");
	const failure = await decide({
		...(await request()),
		retryDeadline: { at: 60, onExpired: () => controller.abort(reason) },
		signal: controller.signal,
	}).catch((error: unknown) => error);
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(failure, reason);
});

test("a chat decision's outer retry can expire while its provider slot is being granted (#5627)", async () => {
	const chat = vi.fn(() => messageStream({ ...decisionMessage(), stopReason: "error", errorMessage: "503" }));
	const decision = await request(chat);
	const clock = vi.spyOn(performance, "now").mockReturnValue(10);
	let admissions = 0;
	setProviderRequestGate(async () => {
		if (++admissions === 2) clock.mockReturnValue(1010);
	});
	const failure = await decide(decision).catch((error: unknown) => error);
	assert.equal(admissions, 2);
	assert.equal(chat.mock.calls.length, 1);
	assert.ok(isDecisionTimeoutError(failure), String(failure));
});

test("a provider abort on the initial attempt is not mistaken for a refused retry (#5627)", async () => {
	const clock = vi.spyOn(performance, "now").mockReturnValue(10);
	const chat = vi.fn(() => {
		clock.mockReturnValue(1010);
		return messageStream({ ...decisionMessage(), stopReason: "aborted" });
	});
	await assert.rejects(decide(await request(chat)), (error: unknown) => isDecisionProviderError(error));
	assert.equal(chat.mock.calls.length, 1);
});
