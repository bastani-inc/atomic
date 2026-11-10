import assert from "node:assert/strict";
import { GitHubCopilotStreamAttempt, recordGitHubCopilotFailure } from "@bastani/pi-ai";
import type { Api, AssistantMessage, Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { _processAgentEvent } from "../../packages/coding-agent/src/core/agent-session-events.js";
import {
	_handleRetryableError,
	_isFallbackableError,
	_isRetryableError,
	_trySwitchToFallbackModel,
	abortRetry,
} from "../../packages/coding-agent/src/core/agent-session-retry.js";
import { LONG_STREAM_CUT_ADVICE, LONG_STREAM_CUT_MS } from "../../packages/coding-agent/src/core/retry-policy.js";

const SHORT_RUN_MS = 1_500;
const LONG_RUN_MS = LONG_STREAM_CUT_MS + 12_000;
const MAX_RETRIES = 3;

type SessionEvent = { type: string; [key: string]: unknown };

function copilotModel(id: string): Model<Api> {
	return {
		provider: "github-copilot",
		id,
		api: "anthropic-messages",
		contextWindow: 200_000,
		reasoning: true,
	} as Model<Api>;
}

function omitTrailingAssistantAttempt(this: { agent: { state: { messages: AssistantMessage[] } } }): boolean {
	const messages = this.agent.state.messages;
	if (messages.length === 0 || messages[messages.length - 1]?.role !== "assistant") return false;
	this.agent.state.messages = messages.slice(0, -1);
	return true;
}

interface Probe {
	readonly session: Record<string, unknown> & {
		_retryAttempt: number;
		_longStreamCutRetries: number;
		agent: { state: { model: Model<Api>; messages: AssistantMessage[] } };
	};
	readonly events: SessionEvent[];
	readonly continuedWith: AssistantMessage[][];
}

function createSession(options: { readonly fallbackModels?: readonly string[] } = {}): Probe {
	const primary = copilotModel("claude-opus-5.5");
	const fallback = copilotModel("claude-sonnet-5");
	const events: SessionEvent[] = [];
	const continuedWith: AssistantMessage[][] = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_agentRunAbortRequested: false,
		_fallbackModels: [...(options.fallbackModels ?? [])],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		_longStreamCutRetries: 0,
		_retryPromise: undefined,
		_retryAbortController: undefined as AbortController | undefined,
		settingsManager: {
			getRetrySettings: () => ({ enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1000 }),
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "github-copilot",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				[primary, fallback].find((candidate) => candidate.provider === provider && candidate.id === id),
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [] as AssistantMessage[] },
			continue: async () => {
				continuedWith.push([...session.agent.state.messages]);
			},
		},
		sessionManager: {
			appendModelChange: () => undefined,
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_recordSystemPromptForModelSwitch: async () => undefined,
		_omitTrailingAssistantAttempt: omitTrailingAssistantAttempt,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: SessionEvent) => events.push(event),
		_resolveRetry: () => undefined,
		_isRetryableError,
		_isFallbackableError,
		_trySwitchToFallbackModel,
	};
	return { session, events, continuedWith };
}

let requestCounter = 0;

/** A Copilot stream that ran for `runMs` on the fake clock before the remote side closed it. */
async function streamCutAfter(runMs: number): Promise<AssistantMessage> {
	const attempt = new GitHubCopilotStreamAttempt();
	attempt.begin();
	attempt.respond(new Headers({ "x-request-id": `req-4626-${++requestCounter}` }));
	for await (const _event of attempt.observe(
		(async function* () {
			yield "message_start";
		})(),
	)) {
		// the response started before it was cut
	}
	await vi.advanceTimersByTimeAsync(runMs);
	const message = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-opus-5.5",
		stopReason: "error",
		errorMessage: "terminated: other side closed",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		timestamp: 0,
	} as unknown as AssistantMessage;
	recordGitHubCopilotFailure(message, new TypeError("terminated"), attempt.snapshot());
	return message;
}

/** One failed attempt reaching the retry handler, with the backoff and the scheduled continue run on the fake clock. */
async function failWith(probe: Probe, runMs: number): Promise<{ handled: boolean; message: AssistantMessage }> {
	const message = await streamCutAfter(runMs);
	probe.session.agent.state.messages.push(message);
	const handling = _handleRetryableError.call(probe.session as never, message);
	await vi.advanceTimersByTimeAsync(120_000);
	return { handled: await handling, message };
}

function eventsOf(probe: Probe, type: string): SessionEvent[] {
	return probe.events.filter((event) => event.type === type);
}

function finalFailure(probe: Probe): SessionEvent | undefined {
	return eventsOf(probe, "auto_retry_end").find((event) => event.success === false);
}

describe("main-chat retry of a Copilot stream cut after a long attempt (#4626)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("cuts after short attempts keep the whole retry budget and the plain final error (#4626)", async () => {
		const probe = createSession();

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			assert.equal((await failWith(probe, SHORT_RUN_MS)).handled, true, `retry ${attempt}`);
		}
		const last = await failWith(probe, SHORT_RUN_MS);

		assert.equal(last.handled, false);
		assert.equal(eventsOf(probe, "auto_retry_start").length, MAX_RETRIES);
		assert.equal(probe.continuedWith.length, MAX_RETRIES);
		assert.deepEqual(finalFailure(probe), {
			type: "auto_retry_end",
			success: false,
			attempt: MAX_RETRIES,
			finalError: last.message.errorMessage,
		});
	});

	test("a long cut is retried once, and a second long cut stops with the advice (#4626)", async () => {
		const probe = createSession();

		const first = await failWith(probe, LONG_RUN_MS);
		const second = await failWith(probe, LONG_RUN_MS);

		assert.equal(first.handled, true);
		assert.equal(second.handled, false);
		assert.equal(eventsOf(probe, "auto_retry_start").length, 1);
		assert.equal(probe.continuedWith.length, 1);
		assert.deepEqual(finalFailure(probe), {
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: `${second.message.errorMessage}\n\n${LONG_STREAM_CUT_ADVICE}`,
		});
	});

	test("the advice stands alone when the failed message carries no text of its own (#4626)", async () => {
		const probe = createSession();
		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		const message = await streamCutAfter(LONG_RUN_MS);
		message.errorMessage = undefined;
		probe.session.agent.state.messages.push(message);

		const handling = _handleRetryableError.call(probe.session as never, message);
		await vi.advanceTimersByTimeAsync(120_000);

		assert.equal(await handling, false);
		assert.equal(finalFailure(probe)?.finalError, LONG_STREAM_CUT_ADVICE);
	});

	test("the failed attempt's partial output is dropped before the retry runs (#4626)", async () => {
		const probe = createSession();

		const first = await failWith(probe, LONG_RUN_MS);

		assert.equal(probe.continuedWith.length, 1);
		assert.equal(probe.continuedWith[0]?.includes(first.message), false);
		assert.deepEqual(probe.continuedWith[0], []);
	});

	test("the retry-start notice carries the cut's duration and request ID (#4626)", async () => {
		const probe = createSession();

		const first = await failWith(probe, LONG_RUN_MS);

		const [start] = eventsOf(probe, "auto_retry_start");
		assert.equal(start?.errorMessage, first.message.errorMessage);
		assert.match(String(start?.errorMessage), /Attempt ran 312\.0 s, response started, request ID req-4626-\d+\./);
	});

	test("a long cut after short ones still gets its one retry, then stops on the next long cut (#4626)", async () => {
		const probe = createSession();

		assert.equal((await failWith(probe, SHORT_RUN_MS)).handled, true);
		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		const stopped = await failWith(probe, LONG_RUN_MS);

		assert.equal(stopped.handled, false);
		assert.equal(eventsOf(probe, "auto_retry_start").length, 2);
		assert.equal(finalFailure(probe)?.finalError, `${stopped.message.errorMessage}\n\n${LONG_STREAM_CUT_ADVICE}`);
	});

	test("short cuts after a long one keep today's budget, counting the long cut's retry (#4626)", async () => {
		const probe = createSession();

		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		assert.equal((await failWith(probe, SHORT_RUN_MS)).handled, true);
		assert.equal((await failWith(probe, SHORT_RUN_MS)).handled, true);
		const last = await failWith(probe, SHORT_RUN_MS);

		assert.equal(last.handled, false);
		assert.equal(eventsOf(probe, "auto_retry_start").length, MAX_RETRIES);
		assert.equal(finalFailure(probe)?.finalError, last.message.errorMessage);
	});

	test("a second long cut after a short one between them stops too (#4626)", async () => {
		const probe = createSession();

		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		assert.equal((await failWith(probe, SHORT_RUN_MS)).handled, true);
		const stopped = await failWith(probe, LONG_RUN_MS);

		assert.equal(stopped.handled, false);
		assert.equal(finalFailure(probe)?.finalError, `${stopped.message.errorMessage}\n\n${LONG_STREAM_CUT_ADVICE}`);
	});

	test("a configured fallback model takes over after the second long cut, with its own long-cut retry (#4626)", async () => {
		const probe = createSession({ fallbackModels: ["github-copilot/claude-sonnet-5:high"] });

		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		const switched = await failWith(probe, LONG_RUN_MS);

		assert.equal(switched.handled, true);
		assert.equal(finalFailure(probe), undefined);
		assert.equal(probe.session.agent.state.model.id, "claude-sonnet-5");
		const [fallbackStart] = eventsOf(probe, "model_fallback_start");
		assert.equal(fallbackStart?.from, "github-copilot/claude-opus-5.5");
		assert.equal(fallbackStart?.to, "github-copilot/claude-sonnet-5");
		assert.equal(fallbackStart?.reason, switched.message.errorMessage);
		assert.equal(probe.session._retryAttempt, 0);
		assert.equal(probe.session._longStreamCutRetries, 0);

		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		assert.equal(finalFailure(probe), undefined);
		assert.equal(probe.session._longStreamCutRetries, 1);
	});

	test("a configured lower thinking level of the same model is the next candidate after the second long cut (#4626)", async () => {
		const probe = createSession({ fallbackModels: ["github-copilot/claude-opus-5.5:medium"] });

		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);

		const [fallbackStart] = eventsOf(probe, "model_fallback_start");
		assert.equal(fallbackStart?.to, "github-copilot/claude-opus-5.5");
		assert.equal(fallbackStart?.fromThinkingLevel, "high");
		assert.equal(fallbackStart?.toThinkingLevel, "medium");
		assert.equal(finalFailure(probe), undefined);
	});

	test("cancelling a retry clears the long-cut count (#4626)", async () => {
		const probe = createSession();
		const first = await streamCutAfter(LONG_RUN_MS);
		probe.session.agent.state.messages.push(first);
		const handling = _handleRetryableError.call(probe.session as never, first);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(probe.session._longStreamCutRetries, 1);

		abortRetry.call(probe.session as never);
		await vi.advanceTimersByTimeAsync(120_000);
		await handling;

		assert.equal(probe.session._retryAttempt, 0);
		assert.equal(probe.session._longStreamCutRetries, 0);
		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
	});

	test("a successful response clears the long-cut count (#4626)", async () => {
		const probe = createSession();
		assert.equal((await failWith(probe, LONG_RUN_MS)).handled, true);
		assert.equal(probe.session._longStreamCutRetries, 1);
		const answered = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		} as unknown as AssistantMessage;
		const session = {
			...probe.session,
			_applyInterruptAbortMessage: () => undefined,
			_applyProviderErrorGuidance: () => undefined,
			_emitExtensionEvent: async () => undefined,
			_protectedStreamingCustomMessages: [],
			_messagesAwaitingPersistence: new Set<unknown>(),
			_entryIdsByMessage: new Map<unknown, string>(),
			_isEmptyCompletion: () => false,
			_isSafetyRefusal: () => false,
			_lengthContinuationAttempts: 0,
			sessionManager: { appendMessage: async () => "entry-1" },
		};

		await _processAgentEvent.call(session as never, { type: "message_end", message: answered } as never);

		assert.equal(session._retryAttempt, 0);
		assert.equal(session._longStreamCutRetries, 0);
		assert.deepEqual(eventsOf(probe, "auto_retry_end").at(-1), {
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
	});
});
