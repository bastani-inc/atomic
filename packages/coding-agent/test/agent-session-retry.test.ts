import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@bastani/atomic-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		baseDelayMs?: number;
		maxAgentDelayMs?: number;
		delayAssistantMessageEndMs?: number;
		subagentPolicy?: import("../src/core/extensions/context-types.ts").SubagentChildPolicy;
	}) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		let callCount = 0;

		const model = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		settingsManager.applyOverrides({
			retry: {
				enabled: true,
				maxRetries,
				baseDelayMs: options?.baseDelayMs ?? 1,
				maxAgentDelayMs: options?.maxAgentDelayMs,
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			...(options?.subagentPolicy ? { subagentPolicy: options.subagentPolicy } : {}),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	async function createSessionWithStream(streamFn: StreamFn): Promise<AgentSession> {
		const model = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}
	it("retries after a transient error and succeeds", async () => {
		const created = await createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("caps agent retry delay (#8826)", async () => {
		const created = await createSession({ failCount: 4, maxRetries: 5, maxAgentDelayMs: 5 });
		const delays: number[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") delays.push(event.delayMs);
		});
		await created.session.prompt("Test");
		expect(delays).toEqual([1, 2, 4, 5]);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = await createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = await createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = await createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});

	it("retries bare provider finish_reason: error failures", async () => {
		let callCount = 0;
		await createSessionWithStream(() => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const error = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: error",
					});
					stream.push({ type: "start", partial: error });
					stream.push({ type: "error", reason: "error", error });
					return;
				}
				const recovered = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: recovered });
				stream.push({ type: "done", reason: "stop", message: recovered });
			});
			return stream;
		});

		await session.prompt("Test");
		expect(callCount).toBe(2);
	});

	it.each([
		'{"type":"error","error":{"type":"api_error","message":"Connection closed."}}',
		"gateway_error: connectionclosed",
	])("retries gateway closed-connection errors (#12093): %s", async (errorMessage) => {
		let callCount = 0;
		await createSessionWithStream(() => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const error = createAssistantMessage("", {
						stopReason: "error",
						errorMessage,
					});
					stream.push({ type: "start", partial: error });
					stream.push({ type: "error", reason: "error", error });
					return;
				}
				const recovered = createAssistantMessage("Recovered after closed connection");
				stream.push({ type: "start", partial: recovered });
				stream.push({ type: "done", reason: "stop", message: recovered });
			});
			return stream;
		});

		await session.prompt("Test");
		assert.equal(callCount, 2);
	});

	it.each([
		"read ECONNRESET",
		"connect ETIMEDOUT 140.82.113.3:443",
		"write EPIPE",
		"connect ECONNREFUSED 127.0.0.1:443",
		"ECONNABORTED",
		"Connection reset by peer",
	])("retries bare Node socket error codes (#12128): %s", async (errorMessage) => {
		let callCount = 0;
		await createSessionWithStream(() => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const error = createAssistantMessage("", {
						stopReason: "error",
						errorMessage,
					});
					stream.push({ type: "start", partial: error });
					stream.push({ type: "error", reason: "error", error });
					return;
				}
				const recovered = createAssistantMessage("Recovered after socket error");
				stream.push({ type: "start", partial: recovered });
				stream.push({ type: "done", reason: "stop", message: recovered });
			});
			return stream;
		});

		await session.prompt("Test");
		assert.equal(callCount, 2);
	});

	it.each(["Invalid value EXECONNRESET", "Unknown field ETIMEDOUTX", "Invalid key ERR_EPIPE_ID"])(
		"does not retry socket error codes inside longer identifiers (#12128): %s",
		async (errorMessage) => {
			let callCount = 0;
			await createSessionWithStream(() => {
				callCount++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const error = createAssistantMessage("", {
						stopReason: "error",
						errorMessage,
					});
					stream.push({ type: "start", partial: error });
					stream.push({ type: "error", reason: "error", error });
				});
				return stream;
			});

			await session.prompt("Test");
			assert.equal(callCount, 1);
		},
	);

	it("retries structured ECONNABORTED errors whose message contains abort wording (#12128)", async () => {
		let callCount = 0;
		await createSessionWithStream(() => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const error = Object.assign(
						createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "An established connection was aborted by the software in your host machine",
						}),
						{ code: "ECONNABORTED" },
					);
					stream.push({ type: "start", partial: error });
					stream.push({ type: "error", reason: "error", error });
					return;
				}
				const recovered = createAssistantMessage("Recovered after structured ECONNABORTED");
				stream.push({ type: "start", partial: recovered });
				stream.push({ type: "done", reason: "stop", message: recovered });
			});
			return stream;
		});

		await session.prompt("Test");
		assert.equal(callCount, 2);
	});

	it("retries degenerate empty completions and bounds them by maxRetries", async () => {
		let callCount = 0;
		await createSessionWithStream(() => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount <= 2) {
					const empty = createAssistantMessage("", { content: [], stopReason: "stop" });
					stream.push({ type: "start", partial: empty });
					stream.push({ type: "done", reason: "stop", message: empty });
					return;
				}
				const recovered = createAssistantMessage("Recovered after empty completions");
				stream.push({ type: "start", partial: recovered });
				stream.push({ type: "done", reason: "stop", message: recovered });
			});
			return stream;
		});
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");
		expect(callCount).toBe(3);
		expect(events).toEqual(["start:1", "start:2", "end:success=true"]);
	});

	it("sends structured content-filter refusals to the next fallback model, and retries them only when retry.fallbackOnContentFilter is off", async () => {
		const created = await createSession({ failCount: 0 });
		const probe = created.session as unknown as {
			_isRetryableError(message: AssistantMessage): boolean;
			_isFallbackableError(message: AssistantMessage): boolean;
			settingsManager: SettingsManager;
		};
		const refusals = [
			createAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Provider finish_reason: content_filter",
			}),
			createAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Provider finish_reason: content_filter",
				provider: "github-copilot",
				api: "openai-completions",
				model: "gemini-3.1-pro-preview",
			}),
			createAssistantMessage("", {
				stopReason: "error",
				errorMessage: "The model refused to complete the request",
			}),
		];
		for (const refusal of refusals) {
			assert.equal(probe._isRetryableError(refusal), false, refusal.errorMessage);
			assert.equal(probe._isFallbackableError(refusal), true, refusal.errorMessage);
		}
		probe.settingsManager.applyOverrides({ retry: { fallbackOnContentFilter: false } });
		for (const refusal of refusals) {
			assert.equal(probe._isRetryableError(refusal), true, refusal.errorMessage);
			assert.equal(probe._isFallbackableError(refusal), false, refusal.errorMessage);
		}
		assert.equal(
			probe._isRetryableError(
				createAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Invalid request: unknown parameter",
				}),
			),
			false,
		);
	});

	it("treats Codex token invalidation wrapped in abort diagnostics as fallbackable only", async () => {
		const created = await createSession({ failCount: 0 });
		const probe = created.session as unknown as {
			_isFallbackableError(message: AssistantMessage): boolean;
			_isRetryableError(message: AssistantMessage): boolean;
		};
		const wrappedInvalidation = {
			...createAssistantMessage("", {
				stopReason: "error",
				errorMessage: "invalidated oauth token",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: "gpt-5.5",
			}),
			diagnostics: [
				{
					type: "provider_transport_failure",
					error: { name: "AbortError", message: "The operation was aborted" },
				},
			],
		} as AssistantMessage;

		expect(probe._isFallbackableError(wrappedInvalidation)).toBe(true);
		expect(probe._isRetryableError(wrappedInvalidation)).toBe(false);
	});

	it("does not classify a reasoning-only turn with output tokens as empty", async () => {
		const created = await createSession({ failCount: 0 });
		const probe = created.session as unknown as { _isEmptyCompletion(message: AssistantMessage): boolean };
		expect(probe._isEmptyCompletion(createAssistantMessage("", { content: [], stopReason: "stop" }))).toBe(true);
		expect(
			probe._isEmptyCompletion(
				createAssistantMessage("", {
					content: [],
					stopReason: "stop",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			),
		).toBe(false);
	});

	it("settles waitForRetry and resets retry state if _omitTrailingAssistantAttempt throws", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 2 });
		const internal = created.session as unknown as {
			_omitTrailingAssistantAttempt: () => Promise<boolean>;
			_retryAttempt: number;
			_longStreamCutRetries: number;
			_retryAbortController: AbortController | undefined;
		};
		internal._omitTrailingAssistantAttempt = async () => {
			throw new Error("storage write failed");
		};
		const retryEnds: Array<{ success: boolean; attempt: number; finalError?: string }> = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_end") {
				retryEnds.push({ success: event.success, attempt: event.attempt, finalError: event.finalError });
			}
		});

		await Promise.race([
			created.session.prompt("Test"),
			new Promise<never>((_resolve, reject) =>
				setTimeout(
					() => reject(new Error("waitForRetry() stranded after _omitTrailingAssistantAttempt failure")),
					1_500,
				),
			),
		]);

		assert.equal(created.session.isRetrying, false);
		assert.equal(internal._retryAttempt, 0);
		assert.equal(internal._longStreamCutRetries, 0);
		assert.equal(internal._retryAbortController, undefined);
		assert.deepEqual(retryEnds, [{ success: false, attempt: 1, finalError: "storage write failed" }]);
	});

	it("settles waitForRetry and emits auto_retry_end if scheduled agent.continue rejects pre-loop", async () => {
		const created = await createSession({ failCount: 1, maxRetries: 2 });
		const internal = created.session as unknown as {
			_retryAttempt: number;
			_longStreamCutRetries: number;
		};
		created.session.agent.continue = async () => {
			throw new Error("Cannot continue from message role: assistant");
		};
		const retryEnds: Array<{ success: boolean; attempt: number; finalError?: string }> = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_end") {
				retryEnds.push({ success: event.success, attempt: event.attempt, finalError: event.finalError });
			}
		});

		await Promise.race([
			created.session.prompt("Test"),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("waitForRetry() stranded after agent.continue rejection")), 1_500),
			),
		]);

		assert.equal(created.session.isRetrying, false);
		assert.equal(internal._retryAttempt, 0);
		assert.equal(internal._longStreamCutRetries, 0);
		assert.deepEqual(retryEnds, [
			{ success: false, attempt: 1, finalError: "Cannot continue from message role: assistant" },
		]);
	});

	it("_sealMessageAdmissionIfDrained does not seal subagent admission while isRetrying is true", async () => {
		const ended = new AbortController();
		const created = await createSession({
			failCount: 1,
			maxRetries: 2,
			baseDelayMs: 5_000,
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: false,
				inheritSkills: false,
				depth: 1,
				executionEnded: ended.signal,
			},
		});
		const internal = created.session as unknown as {
			_activePromptCount: number;
			_sealMessageAdmissionIfDrained: () => boolean;
			_subagentMessageAdmission?: { isOpen(): boolean };
		};
		const retryStarted = Promise.withResolvers<void>();
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarted.resolve();
		});

		const pending = created.session.prompt("Test");
		await retryStarted.promise;

		// Simulate drain check during retry backoff when nothing streams and prompt count is 0.
		const savedActiveCount = internal._activePromptCount;
		internal._activePromptCount = 0;
		try {
			assert.equal(created.session.isStreaming, false);
			assert.equal(created.session.isRetrying, true);
			assert.equal(internal._sealMessageAdmissionIfDrained(), false);
			assert.equal(internal._subagentMessageAdmission?.isOpen(), true);
		} finally {
			internal._activePromptCount = savedActiveCount;
		}

		created.session.abortRetry();
		await pending;
		assert.equal(created.session.isRetrying, false);
		assert.equal(internal._sealMessageAdmissionIfDrained(), true);
		assert.equal(internal._subagentMessageAdmission?.isOpen(), false);
		ended.abort();
	});

	it("interrupt custom message waits for retry completion and does not signal drain while retrying", async () => {
		const created = await createSession({
			failCount: 1,
			maxRetries: 2,
			baseDelayMs: 40,
		});
		const drainedWhileRetrying: boolean[] = [];
		const internal = created.session as unknown as {
			_subagentPolicy?: { onTurnDrained?: () => void };
			_enqueueInterruptCustomMessage: (
				message: {
					role: "custom";
					customType: string;
					content: string;
					display: boolean;
					timestamp: number;
				},
				options?: { triggerTurn?: boolean; deliverAs?: "interrupt" },
			) => Promise<void>;
		};
		internal._subagentPolicy = {
			onTurnDrained: () => {
				drainedWhileRetrying.push(created.session.isRetrying);
			},
		};

		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await internal._enqueueInterruptCustomMessage(
			{
				role: "custom",
				customType: "interrupt_notice",
				content: "urgent update",
				display: true,
				timestamp: Date.now(),
			},
			{ triggerTurn: true, deliverAs: "interrupt" },
		);

		assert.equal(created.getCallCount(), 2, "interrupt turn waited for its retry to complete");
		assert.equal(created.session.isRetrying, false);
		assert.deepEqual(events, ["start:1", "end:success=true"]);
		assert.deepEqual(
			drainedWhileRetrying,
			[false],
			"onTurnDrained fires only after retry completes, never while isRetrying is true",
		);
	});
});
