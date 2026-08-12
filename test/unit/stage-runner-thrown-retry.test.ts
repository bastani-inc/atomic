import { describe, test } from "vitest";
import { nextRetryDecision as codingAgentNextRetryDecision } from "../../packages/coding-agent/src/core/retry-policy.js";
import type {
	AgentSessionAdapter,
	InternalStageContext,
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { WorkflowFastModeSettingsManager } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { nextRetryDecision as workflowsNextRetryDecision } from "../../packages/workflows/src/runs/shared/retry.js";
import {
	assert,
	assistantMessageWithUsage,
	createStageContext,
	flushMicrotasks,
	makeMockSession,
	makeOpts,
	Type,
} from "./stage-runner-helpers.js";

const retrySettings = (
	overrides: Partial<ReturnType<NonNullable<WorkflowFastModeSettingsManager["getRetrySettings"]>>> = {},
) => ({
	enabled: true,
	maxRetries: 2,
	baseDelayMs: 0,
	...overrides,
});

function sessionWithSettings(
	settings: ReturnType<typeof retrySettings>,
	prompt: StageSessionRuntime["prompt"],
	overrides: Partial<StageSessionRuntime> = {},
): { readonly session: StageSessionRuntime; readonly settingsManager: WorkflowFastModeSettingsManager } {
	const { session } = makeMockSession({ prompt, ...overrides });
	return {
		session,
		settingsManager: {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
			getRetrySettings: () => settings,
		},
	};
}

function modelFor(options: StageSessionCreateOptions): string {
	return typeof options.model === "string" ? options.model : "object-model";
}

describe("createStageContext — thrown model failure retry", () => {
	test("an adapter can require explicit workflow resume instead of transport retry", async () => {
		let promptCalls = 0;
		const agentSession: AgentSessionAdapter = {
			retryPolicy: "never",
			async create() {
				return sessionWithSettings(retrySettings(), async () => {
					promptCalls += 1;
					throw new Error("503 remote SSH transport unavailable");
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		await assert.rejects(ctx.prompt("go"), /remote SSH transport unavailable/);
		assert.equal(promptCalls, 1);
	});

	test("retries a transient thrown failure on the same session before succeeding", async () => {
		let promptCalls = 0;
		let created = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				created += 1;
				const result = sessionWithSettings(
					settings,
					async () => {
						promptCalls += 1;
						if (promptCalls < 3) throw new Error("503 service unavailable");
						return "ok";
					},
					{ getLastAssistantText: () => "ok" },
				);
				assert.equal(modelFor(options), "anthropic/primary");
				return result;
			},
		};

		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary" },
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "ok");
		assert.equal(promptCalls, 3);
		assert.equal(created, 1);
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.map(({ model, success }) => ({ model, success })),
			[{ model: "anthropic/primary", success: true }],
		);
	});

	test("restores admitted messages before retrying a thrown provider failure", async () => {
		let promptCalls = 0;
		let activeSession: StageSessionRuntime | undefined;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create() {
				const result = sessionWithSettings(
					settings,
					async () => {
						promptCalls += 1;
						activeSession?.messages.push({} as never);
						if (promptCalls < 3) throw new Error("503 service unavailable");
						return "ok";
					},
					{ getLastAssistantText: () => "ok" },
				);
				activeSession = result.session;
				return result;
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "ok");
		assert.equal(promptCalls, 3);
		assert.equal(activeSession?.messages.length, 1);
	});

	test("a same-model retry keeps the dropped error assistant's usage in the attempt aggregate", async () => {
		const messages: StageSessionRuntime["messages"] = [
			// Historical transcript usage must never be charged to this attempt.
			assistantMessageWithUsage("historical answer", {
				input: 9999,
				output: 8888,
				cacheRead: 7777,
				cacheWrite: 6666,
				cost: 9.99,
			}),
		];
		let promptCalls = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(
					settings,
					async () => {
						promptCalls += 1;
						messages.push({ role: "user", content: "go", timestamp: Date.now() } as never);
						if (promptCalls === 1) {
							messages.push(
								assistantMessageWithUsage(
									"failed attempt",
									{ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 0.011 },
									"error",
								),
							);
							throw new Error("503 service unavailable");
						}
						messages.push(
							assistantMessageWithUsage("final answer", {
								input: 111,
								output: 222,
								cacheRead: 333,
								cacheWrite: 444,
								cost: 0.111,
							}),
						);
						return "ok";
					},
					{ messages, getLastAssistantText: () => "ok" },
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "ok");
		assert.equal(promptCalls, 2, "the same session must retry once and succeed");
		assert.equal(
			messages.filter((message) => message.role === "assistant" && message.stopReason === "error").length,
			0,
			"restore semantics must still drop the failed error assistant from the live transcript",
		);
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts,
			[
				{
					model: "anthropic/primary",
					success: true,
					usage: { input: 122, output: 244, cacheRead: 366, cacheWrite: 488, cost: 0.122, turns: 2 },
				},
			],
			"one attempt record sums only the retry-window responses and counts both turns",
		);
	});

	test("keeps the admitted stage prompt when the retry continues the real session turn", async () => {
		// pi-agent-core's Agent.continue() rejects an empty transcript and a
		// transcript ending in an assistant message, so the continuation path must
		// see the stage prompt it is resuming.
		const messages: StageSessionRuntime["messages"] = [];
		const continuedTranscripts: Array<StageSessionRuntime["messages"]> = [];
		let promptCalls = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(
					settings,
					async (text) => {
						promptCalls += 1;
						messages.push({ role: "user", content: text, timestamp: Date.now() } as never);
						messages.push({
							role: "assistant",
							stopReason: "error",
							errorMessage: "503 service unavailable",
							content: [],
						} as never);
						throw new Error("503 service unavailable");
					},
					{
						messages,
						getLastAssistantText: () => "ok",
						// Shape recognized by asAgentSession()/retryableAgentSession().
						state: { messages },
						sessionManager: {},
						modelRuntime: {},
						getContextUsage: () => ({}),
						_runAgentContinue: async () => {
							continuedTranscripts.push([...messages]);
							messages.push({
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "ok" }],
							} as never);
						},
					} as unknown as Partial<StageSessionRuntime>,
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("do it"), "ok");
		assert.equal(promptCalls, 1, "the continuation path must not re-prompt");
		assert.equal(continuedTranscripts.length, 1);
		const observed = continuedTranscripts[0]!;
		assert.ok(observed.length > 0, "continue() must not observe an empty transcript");
		const last = observed[observed.length - 1]!;
		assert.equal(last.role, "user");
		assert.equal(last.content, "do it");
		assert.equal(
			observed.some((message) => message.role === "assistant" && message.stopReason === "error"),
			false,
			"the failed assistant error must still be dropped from live state",
		);
	});

	test("preserves a concurrent user message admitted before the retry-owned prompt", async () => {
		let promptCalls = 0;
		let activeSession: StageSessionRuntime | undefined;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create() {
				const result = sessionWithSettings(
					settings,
					async () => {
						promptCalls += 1;
						if (promptCalls === 1) {
							activeSession?.messages.push({
								role: "user",
								content: [{ type: "text", text: "concurrent" }],
								timestamp: Date.now(),
							} as never);
						}
						activeSession?.messages.push({
							role: "user",
							content: [{ type: "text", text: "go" }],
							timestamp: Date.now(),
						} as never);
						if (promptCalls < 3) throw new Error("503 service unavailable");
						return "ok";
					},
					{ getLastAssistantText: () => "ok" },
				);
				activeSession = result.session;
				return result;
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "ok");
		assert.deepEqual(
			activeSession?.messages.map((message) => {
				if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
				const first = message.content[0];
				return first?.type === "text" ? first.text : undefined;
			}),
			["concurrent", "go"],
		);
	});

	test("records one failed attempt after retry exhaustion, then advances to a fallback", async () => {
		const promptCalls: string[] = [];
		const created: string[] = [];
		const disposed: string[] = [];
		let primaryPromptCalls = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				created.push(model);
				const messages: StageSessionRuntime["messages"] = [];
				return sessionWithSettings(
					settings,
					async () => {
						promptCalls.push(model);
						if (model === "anthropic/primary") {
							primaryPromptCalls += 1;
							messages.push(
								assistantMessageWithUsage(
									`failed response ${primaryPromptCalls}`,
									{
										input: primaryPromptCalls,
										output: primaryPromptCalls * 2,
										cacheRead: primaryPromptCalls * 3,
										cacheWrite: primaryPromptCalls * 4,
										cost: primaryPromptCalls / 1000,
									},
									"error",
								),
							);
							throw new Error("503 service unavailable");
						}
						messages.push(
							assistantMessageWithUsage("fallback answer", {
								input: 10,
								output: 20,
								cacheRead: 30,
								cacheWrite: 40,
								cost: 0.01,
							}),
						);
						return "fallback answer";
					},
					{
						messages,
						dispose: () => {
							disposed.push(model);
						},
						getLastAssistantText: () => (model === "openai/fallback" ? "fallback answer" : undefined),
					},
				);
			},
		};

		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
				},
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "fallback answer");
		assert.deepEqual(promptCalls, ["anthropic/primary", "anthropic/primary", "anthropic/primary", "openai/fallback"]);
		assert.deepEqual(created, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(disposed, ["anthropic/primary"]);
		assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts, [
			{
				model: "anthropic/primary",
				success: false,
				error: "503 service unavailable",
				usage: { input: 6, output: 12, cacheRead: 18, cacheWrite: 24, cost: 0.006, turns: 3 },
			},
			{
				model: "openai/fallback",
				success: true,
				usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.01, turns: 1 },
			},
		]);
	});

	test("retries session creation on the same candidate before advancing", async () => {
		const created: string[] = [];
		const settings = retrySettings();
		const settingsManager = {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
			getRetrySettings: () => settings,
		};
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				created.push(model);
				if (model === "anthropic/primary") throw new Error("503 service unavailable during create");
				return sessionWithSettings(settings, async () => "fallback answer", {
					getLastAssistantText: () => "fallback answer",
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: settingsManager as never,
				},
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "fallback answer");
		assert.deepEqual(created, ["anthropic/primary", "anthropic/primary", "anthropic/primary", "openai/fallback"]);
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.map(({ model, success, error }) => ({ model, success, error })),
			[
				{ model: "anthropic/primary", success: false, error: "503 service unavailable during create" },
				{ model: "openai/fallback", success: true, error: undefined },
			],
		);
	});

	test("session creation advances immediately on auth and request-incompatible failures", async () => {
		for (const failure of ["401 unauthorized during create", "400 bad request during create"]) {
			const created: string[] = [];
			const settings = retrySettings();
			const settingsManager = {
				getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
				getRetrySettings: () => settings,
			};
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					const model = modelFor(options);
					created.push(model);
					if (model === "anthropic/primary") throw new Error(failure);
					return sessionWithSettings(settings, async () => "fallback answer", {
						getLastAssistantText: () => "fallback answer",
					});
				},
			};
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: {
						model: "anthropic/primary",
						fallbackModels: ["openai/fallback"],
						settingsManager: settingsManager as never,
					},
				}),
			) as InternalStageContext;

			assert.equal(await ctx.prompt("go"), "fallback answer");
			assert.deepEqual(created, ["anthropic/primary", "openai/fallback"]);
		}
	});

	test("disabled retry advances immediately without another prompt", async () => {
		const calls: string[] = [];
		const settings = retrySettings({ enabled: false });
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				return sessionWithSettings(
					settings,
					async () => {
						calls.push(model);
						if (model === "anthropic/primary") throw new Error("503 service unavailable");
						return "fallback answer";
					},
					{ getLastAssistantText: () => "fallback answer" },
				);
			},
		};

		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "fallback answer");
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
	});

	test("auth and request-incompatible thrown failures advance immediately without same-model retry", async () => {
		for (const failure of ["401 unauthorized", "400 bad request"]) {
			const calls: string[] = [];
			const settings = retrySettings();
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					const model = modelFor(options);
					return sessionWithSettings(
						settings,
						async () => {
							calls.push(model);
							if (model === "anthropic/primary") throw new Error(failure);
							return "fallback answer";
						},
						{ getLastAssistantText: () => "fallback answer" },
					);
				},
			};
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
				}),
			) as InternalStageContext;

			assert.equal(await ctx.prompt("go"), "fallback answer");
			assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
		}
	});

	test("does not retry a non-retryable thrown failure", async () => {
		let calls = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(settings, async () => {
					calls += 1;
					throw new Error("command failed: bun test");
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		await assert.rejects(ctx.prompt("go"), /command failed/);
		assert.equal(calls, 1);
	});

	test("structured output capture suppresses thrown retry", async () => {
		let createOptions: StageSessionCreateOptions | undefined;
		let promptCalls = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				return sessionWithSettings(
					settings,
					async () => {
						promptCalls += 1;
						const tool = createOptions?.customTools?.find((entry) => entry.name === "structured_output");
						assert.ok(tool);
						await tool.execute("structured-call", { ok: true }, undefined, undefined, undefined as never);
						throw new Error("503 service unavailable after structured output");
					},
					{ getLastAssistantText: () => undefined },
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("go"), { ok: true });
		assert.equal(promptCalls, 1);
	});

	test("workflow abort during backoff prevents the next prompt and preserves its reason", async () => {
		const signalController = new AbortController();
		const workflowError = new Error("workflow killed");
		let calls = 0;
		const settings = retrySettings({ baseDelayMs: 1000 });
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(settings, async () => {
					calls += 1;
					throw new Error("503 service unavailable");
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary" },
				signal: signalController.signal,
			}),
		) as InternalStageContext;
		const prompt = ctx.prompt("go");
		await flushMicrotasks();
		assert.equal(calls, 1);
		signalController.abort(workflowError);
		await assert.rejects(prompt, workflowError);
		assert.equal(calls, 1);
	});

	test("ctx.abort cancels thrown-error backoff", async () => {
		let calls = 0;
		const settings = retrySettings({ baseDelayMs: 1000 });
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(settings, async () => {
					calls += 1;
					throw new Error("503 service unavailable");
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;
		const prompt = ctx.prompt("go");
		await flushMicrotasks();
		await ctx.abort();
		await assert.rejects(prompt, /stage aborted/);
		assert.equal(calls, 1);
	});

	test("pause during backoff defers the retry until resume and uses resumed text", async () => {
		const promptTexts: string[] = [];
		let calls = 0;
		const settings = retrySettings({ baseDelayMs: 1000 });
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(
					settings,
					async (text) => {
						calls += 1;
						promptTexts.push(text);
						if (calls === 1) throw new Error("503 service unavailable");
						return "resumed answer";
					},
					{ getLastAssistantText: () => "resumed answer" },
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;
		const prompt = ctx.prompt("first");
		await flushMicrotasks();
		await ctx.__requestPause();
		await new Promise((resolve) => setTimeout(resolve, 15));
		assert.equal(calls, 1);
		await ctx.__resume("resumed");
		await flushMicrotasks();
		assert.equal(calls, 2);
		assert.equal(await prompt, "resumed answer");
		assert.deepEqual(promptTexts, ["first", "resumed"]);
	});

	test("a paused session creation can be cancelled and retried by a later prompt", async () => {
		let creates = 0;
		const settings = retrySettings({ baseDelayMs: 1000 });
		const settingsManager = {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
			getRetrySettings: () => settings,
		};
		const agentSession: AgentSessionAdapter = {
			async create() {
				creates += 1;
				if (creates === 1) throw new Error("503 service unavailable during create");
				return sessionWithSettings(settings, async () => "fresh answer", {
					getLastAssistantText: () => "fresh answer",
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { settingsManager: settingsManager as never } }),
		) as InternalStageContext;
		const firstPrompt = ctx.prompt("first");
		await flushMicrotasks();
		await ctx.__requestPause();
		await ctx.__resume();
		assert.equal(await firstPrompt, "");
		assert.equal(await ctx.prompt("second"), "fresh answer");
		assert.equal(creates, 2);
	});

	test("a cancelled paused retry cannot leak its resume text into a later prompt", async () => {
		const promptTexts: string[] = [];
		let calls = 0;
		const settings = retrySettings({ baseDelayMs: 1000 });
		const agentSession: AgentSessionAdapter = {
			async create() {
				return sessionWithSettings(
					settings,
					async (text) => {
						calls += 1;
						promptTexts.push(text);
						if (calls < 3) throw new Error("503 service unavailable");
						return "new answer";
					},
					{ getLastAssistantText: () => "new answer" },
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;
		const firstPrompt = ctx.prompt("first");
		await flushMicrotasks();
		await ctx.__requestPause();
		await ctx.__resume("stale-resume");
		await flushMicrotasks();
		assert.equal(calls, 2);
		await ctx.abort();
		await assert.rejects(firstPrompt, /stage aborted/);

		assert.equal(await ctx.prompt("new-objective"), "new answer");
		assert.deepEqual(promptTexts, ["first", "stale-resume", "new-objective"]);
	});
});

describe("shared retry policy", () => {
	test("companion packages expose the one shared policy implementation", () => {
		assert.strictEqual(workflowsNextRetryDecision, codingAgentNextRetryDecision);
	});

	test("honours enabled, maxRetries, and exponential baseDelayMs", () => {
		const settings = { enabled: true, maxRetries: 3, baseDelayMs: 250 };
		assert.deepEqual(workflowsNextRetryDecision(settings, 0, true), { attempt: 1, delayMs: 250 });
		assert.deepEqual(workflowsNextRetryDecision(settings, 1, true), { attempt: 2, delayMs: 500 });
		assert.deepEqual(workflowsNextRetryDecision(settings, 2, true), { attempt: 3, delayMs: 1000 });
		assert.equal(workflowsNextRetryDecision(settings, 3, true), undefined);
	});

	test("disabled retry and missing settings advance immediately", () => {
		assert.equal(workflowsNextRetryDecision({ enabled: false, maxRetries: 3, baseDelayMs: 250 }, 0, true), undefined);
		assert.equal(workflowsNextRetryDecision(undefined, 0, true), undefined);
	});

	test("an ineligible failure is never retried on the same target", () => {
		assert.equal(workflowsNextRetryDecision({ enabled: true, maxRetries: 3, baseDelayMs: 250 }, 0, false), undefined);
	});
});

/**
 * Real-AgentSession-shaped probe: `asAgentSession()`/`retryableAgentSession()`
 * accept it, so tests reach the `_runAgentContinue()` continuation branch that
 * lightweight adapters skip.
 */
function realSessionProbe(
	settings: ReturnType<typeof retrySettings>,
	options: {
		readonly failCalls: number;
		/** Extra messages the failing attempt admits after its user prompt. */
		readonly admit?: (messages: StageSessionRuntime["messages"], call: number) => void;
	},
): {
	readonly agentSession: AgentSessionAdapter;
	readonly messages: StageSessionRuntime["messages"];
	readonly continuedTranscripts: Array<StageSessionRuntime["messages"]>;
	readonly promptTexts: string[];
} {
	const messages: StageSessionRuntime["messages"] = [];
	const continuedTranscripts: Array<StageSessionRuntime["messages"]> = [];
	const promptTexts: string[] = [];
	let call = 0;
	const agentSession: AgentSessionAdapter = {
		async create() {
			return sessionWithSettings(
				settings,
				async (text) => {
					call += 1;
					promptTexts.push(text);
					messages.push({ role: "user", content: text, timestamp: Date.now() } as never);
					options.admit?.(messages, call);
					if (call > options.failCalls) return "ok";
					messages.push({
						role: "assistant",
						stopReason: "error",
						errorMessage: "503 service unavailable",
						content: [],
						// Meaningful usage so retry-discard accounting keeps this response
						// in the final attempt aggregate even though restore drops it.
						usage: {
							input: 11,
							output: 22,
							cacheRead: 33,
							cacheWrite: 44,
							totalTokens: 110,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.011 },
						},
					} as never);
					throw new Error("503 service unavailable");
				},
				{
					messages,
					getLastAssistantText: () => "ok",
					state: { messages },
					sessionManager: {},
					modelRuntime: {},
					getContextUsage: () => ({}),
					_runAgentContinue: async () => {
						continuedTranscripts.push([...messages]);
						messages.push({
							role: "assistant",
							stopReason: "stop",
							content: [{ type: "text", text: "ok" }],
						} as never);
					},
				} as unknown as Partial<StageSessionRuntime>,
			);
		},
	};
	return { agentSession, messages, continuedTranscripts, promptTexts };
}

function userMessagesWithText(messages: StageSessionRuntime["messages"], text: string): number {
	return messages.filter((message) => message.role === "user" && message.content === text).length;
}

describe("createStageContext — continuation eligibility across admitted orderings", () => {
	test("a tool-result tail is a valid continuation and keeps the same turn", async () => {
		const probe = realSessionProbe(retrySettings(), {
			failCalls: 1,
			admit: (messages, call) => {
				if (call === 1) messages.push({ role: "toolResult", content: "tool output" } as never);
			},
		});
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession: probe.agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("do it"), "ok");
		assert.deepEqual(probe.promptTexts, ["do it"], "a valid tail must not re-prompt");
		assert.equal(probe.continuedTranscripts.length, 1);
		const observed = probe.continuedTranscripts[0]!;
		assert.equal(observed[observed.length - 1]?.role, "toolResult");
	});

	test("a retained non-error assistant tail re-prompts instead of an invalid continuation", async () => {
		// pi-agent-core rejects continue() with "Cannot continue from message
		// role: assistant", so the retry must not take the continuation path.
		const probe = realSessionProbe(retrySettings(), {
			failCalls: 1,
			admit: (messages, call) => {
				if (call === 1) {
					messages.push(
						assistantMessageWithUsage("partial", {
							input: 1,
							output: 2,
							cacheRead: 3,
							cacheWrite: 4,
							cost: 0.001,
						}),
					);
				} else {
					messages.push(
						assistantMessageWithUsage("final", {
							input: 111,
							output: 222,
							cacheRead: 333,
							cacheWrite: 444,
							cost: 0.111,
						}),
					);
				}
			},
		});
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession: probe.agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("do it"), "ok");
		assert.deepEqual(probe.continuedTranscripts, [], "an assistant tail is not a valid continuation");
		assert.deepEqual(probe.promptTexts, ["do it", "do it"], "the retry must re-send the prompt instead");
		assert.equal(userMessagesWithText(probe.messages, "do it"), 1, "the re-prompt must not duplicate the input");
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.[0]?.usage,
			{ input: 123, output: 246, cacheRead: 369, cacheWrite: 492, cost: 0.123, turns: 3 },
			"the latched window includes the retained response, discarded error, and re-prompt response",
		);
	});

	test("a pause during backoff drops the retained prompt and uses the resumed text", async () => {
		const probe = realSessionProbe(retrySettings({ baseDelayMs: 1000 }), {
			failCalls: 1,
			// The replacement prompt's own response also carries usage, so a
			// lastPromptStartIndex-based aggregate would see only this value.
			admit: (messages, call) => {
				if (call === 2) {
					messages.push(
						assistantMessageWithUsage("resumed answer", {
							input: 111,
							output: 222,
							cacheRead: 333,
							cacheWrite: 444,
							cost: 0.111,
						}),
					);
				}
			},
		});
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession: probe.agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		const prompt = ctx.prompt("do it");
		await flushMicrotasks();
		await ctx.__requestPause();
		await new Promise((resolve) => setTimeout(resolve, 15));
		await ctx.__resume("resumed");
		await flushMicrotasks();

		assert.equal(await prompt, "ok");
		assert.deepEqual(probe.continuedTranscripts, [], "a resumed prompt does not continue the old turn");
		assert.deepEqual(probe.promptTexts, ["do it", "resumed"]);
		assert.equal(userMessagesWithText(probe.messages, "do it"), 0, "the abandoned input must not survive the resume");
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.[0]?.usage,
			{ input: 122, output: 244, cacheRead: 366, cacheWrite: 488, cost: 0.122, turns: 2 },
			"the aggregate spans the original boundary: the pre-pause dropped error and the replacement response both count",
		);
	});

	test("ctx.abort during backoff stops before any continuation", async () => {
		const probe = realSessionProbe(retrySettings({ baseDelayMs: 1000 }), { failCalls: 1 });
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession: probe.agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		const prompt = ctx.prompt("do it");
		await flushMicrotasks();
		await ctx.abort();

		await assert.rejects(prompt, /stage aborted/);
		assert.deepEqual(probe.promptTexts, ["do it"]);
		assert.deepEqual(probe.continuedTranscripts, [], "an aborted retry must not resume the turn");
	});

	test("a tail that converts away is not a valid continuation", async () => {
		// pi-agent-core requires the CONVERTED tail to be user/toolResult. A custom
		// message excluded from context is dropped by convertToLlm(), exposing the
		// retained assistant beneath it, so the raw role alone cannot decide.
		const probe = realSessionProbe(retrySettings(), {
			failCalls: 1,
			admit: (messages, call) => {
				if (call !== 1) return;
				messages.push({
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "partial" }],
				} as never);
				messages.push({
					role: "custom",
					customType: "workflow:note",
					content: "hidden note",
					excludeFromContext: true,
				} as never);
			},
		});
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession: probe.agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("do it"), "ok");
		assert.deepEqual(probe.continuedTranscripts, [], "a converted assistant tail is not a valid continuation");
		assert.deepEqual(probe.promptTexts, ["do it", "do it"], "the retry must re-send the prompt instead");
		assert.equal(userMessagesWithText(probe.messages, "do it"), 1, "the re-prompt must not duplicate the input");
	});
});

describe("createStageContext — eager session creation walks the candidate chain", () => {
	const eagerSettingsManager = (settings: ReturnType<typeof retrySettings>): WorkflowFastModeSettingsManager => ({
		getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
		getRetrySettings: () => settings,
	});

	test("an eagerly created session advances to a fallback candidate", async () => {
		// ctx.__ensureSession() has no prompt to drive promptWithFallback(), so the
		// creation path must walk the chain itself.
		const created: string[] = [];
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				created.push(model);
				if (model === "anthropic/primary") throw new Error("503 service unavailable during create");
				return sessionWithSettings(settings, async () => "fallback answer", {
					getLastAssistantText: () => "fallback answer",
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: eagerSettingsManager(settings) as never,
				},
			}),
		) as InternalStageContext;

		await ctx.__ensureSession();

		assert.deepEqual(created, ["anthropic/primary", "anthropic/primary", "anthropic/primary", "openai/fallback"]);
		assert.equal(await ctx.prompt("go"), "fallback answer");
	});

	test("a terminal creation failure is not replayed to a later ensureSession", async () => {
		let creates = 0;
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				creates += 1;
				// Three attempts on the primary plus three on the fallback exhaust
				// the first walk; anything after that succeeds.
				if (creates <= 6) throw new Error(`503 service unavailable during create ${modelFor(options)}`);
				return sessionWithSettings(settings, async () => "late answer", {
					getLastAssistantText: () => "late answer",
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: eagerSettingsManager(settings) as never,
				},
			}),
		) as InternalStageContext;

		await assert.rejects(ctx.__ensureSession(), /503 service unavailable during create/);
		assert.equal(creates, 6);

		// The cached rejection must not be handed to the next caller.
		await ctx.__ensureSession();
		assert.equal(creates, 7);
	});

	test("a paused eager creation resumes with the replacement objective", async () => {
		const promptTexts: string[] = [];
		let creates = 0;
		const settings = retrySettings({ baseDelayMs: 1000 });
		const agentSession: AgentSessionAdapter = {
			async create() {
				creates += 1;
				if (creates === 1) throw new Error("503 service unavailable during create");
				return sessionWithSettings(
					settings,
					async (text) => {
						promptTexts.push(text);
						return "resumed answer";
					},
					{ getLastAssistantText: () => "resumed answer" },
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: eagerSettingsManager(settings) as never,
				},
			}),
		) as InternalStageContext;

		const eager = ctx.__ensureSession();
		await flushMicrotasks();
		await ctx.__requestPause();
		await ctx.__resume("replacement objective");
		await eager;

		assert.equal(await ctx.prompt("stale original objective"), "resumed answer");
		assert.deepEqual(promptTexts, ["replacement objective"], "the replacement objective is authoritative");
	});
});

describe("createStageContext — unresolved overflow is terminal for its candidate", () => {
	test("an already-unresolved overflow advances without retrying the same model", async () => {
		const prompts: string[] = [];
		const settings = retrySettings({ maxRetries: 2 });
		const settingsManager: WorkflowFastModeSettingsManager = {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
			getRetrySettings: () => settings,
		};
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = String(options.model);
				const mock = makeMockSession({
					async prompt() {
						prompts.push(model);
						if (model === "anthropic/primary") {
							mock.emit({
								type: "compaction_end",
								reason: "overflow",
								result: undefined,
								aborted: false,
								willRetry: false,
								unresolvedOverflow: true,
								errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
							});
						}
						return undefined;
					},
					getLastAssistantText() {
						return model === "openai/fallback" ? "fallback answer" : undefined;
					},
				});
				return mock.session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: settingsManager as never,
				},
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "fallback answer");
		// Compaction already ran and failed, so re-sending the same request cannot
		// help: one attempt per candidate, not one per retry budget.
		assert.deepEqual(prompts, ["anthropic/primary", "openai/fallback"]);
	});
});

describe("createStageContext — one creation gate across concurrent callers", () => {
	const noRetry = retrySettings({ enabled: false });
	const gateSettingsManager: WorkflowFastModeSettingsManager = {
		getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
		getRetrySettings: () => noRetry,
	};

	test("a second ensureSession joins the walk in flight instead of starting another", async () => {
		const created: string[] = [];
		const disposed: string[] = [];
		let releaseFallback: (() => void) | undefined;
		const fallbackReady = new Promise<void>((resolve) => {
			releaseFallback = resolve;
		});
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				created.push(model);
				if (model === "anthropic/primary") throw new Error("503 service unavailable during create");
				await fallbackReady;
				const { session } = makeMockSession({
					async prompt() {
						return undefined;
					},
					dispose() {
						disposed.push(model);
					},
					getLastAssistantText: () => "fallback answer",
				});
				return { session, settingsManager: gateSettingsManager };
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: gateSettingsManager as never,
				},
			}),
		) as InternalStageContext;

		const first = ctx.__ensureSession();
		// The walk has failed the primary, disposed it, and is now awaiting the
		// fallback adapter — exactly the window where the promise used to be lost.
		await flushMicrotasks();
		await flushMicrotasks();
		const second = ctx.__ensureSession();
		releaseFallback?.();
		await first;
		await second;

		assert.deepEqual(created, ["anthropic/primary", "openai/fallback"], "only one candidate walk may run");
		assert.equal(created.filter((model) => model === "openai/fallback").length, 1, "no duplicate live session");
		assert.deepEqual(disposed, [], "the single attached session is still live");
	});

	test("a first prompt joins a creation already in flight", async () => {
		const created: string[] = [];
		let releaseFallback: (() => void) | undefined;
		const fallbackReady = new Promise<void>((resolve) => {
			releaseFallback = resolve;
		});
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				created.push(model);
				if (model === "anthropic/primary") throw new Error("503 service unavailable during create");
				await fallbackReady;
				return sessionWithSettings(noRetry, async () => "fallback answer", {
					getLastAssistantText: () => "fallback answer",
				});
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					settingsManager: gateSettingsManager as never,
				},
			}),
		) as InternalStageContext;

		const eager = ctx.__ensureSession();
		await flushMicrotasks();
		await flushMicrotasks();
		const prompt = ctx.prompt("go");
		releaseFallback?.();
		await eager;

		assert.equal(await prompt, "fallback answer");
		assert.deepEqual(created, ["anthropic/primary", "openai/fallback"], "the prompt must not start a second walk");
	});
});

describe("createStageContext — pauses observed while a creation is in flight", () => {
	test("a pause that resolves during creation still delivers its replacement objective", async () => {
		const promptTexts: string[] = [];
		const created: string[] = [];
		let releaseCreate: (() => void) | undefined;
		const createReady = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const settings = retrySettings();
		const settingsManager: WorkflowFastModeSettingsManager = {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
			getRetrySettings: () => settings,
		};
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				created.push(modelFor(options));
				await createReady;
				return sessionWithSettings(
					settings,
					async (text) => {
						promptTexts.push(text);
						return "resumed answer";
					},
					{ getLastAssistantText: () => "resumed answer" },
				);
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", settingsManager: settingsManager as never },
			}),
		) as InternalStageContext;

		const eager = ctx.__ensureSession();
		await flushMicrotasks();
		// The pause both starts and finishes while the adapter is still in flight,
		// so a post-await currentResume() check would miss it.
		await ctx.__requestPause();
		await ctx.__resume("replacement objective");
		releaseCreate?.();
		await eager;

		assert.equal(await ctx.prompt("stale objective"), "resumed answer");
		assert.deepEqual(promptTexts, ["replacement objective"], "the replacement objective is authoritative");
		assert.deepEqual(created, ["anthropic/primary"], "the pause must not create a second session");
	});
});

describe("createStageContext — pauses around a same-turn continuation", () => {
	test("a pause during the continuation recovers with the replacement objective", async () => {
		const messages: StageSessionRuntime["messages"] = [];
		const promptTexts: string[] = [];
		const created: string[] = [];
		let continueCalls = 0;
		let releaseContinue: (() => void) | undefined;
		const continueReady = new Promise<void>((resolve) => {
			releaseContinue = resolve;
		});
		const settings = retrySettings();
		let sessionRef: { abort: () => Promise<void> } | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				created.push(modelFor(options));
				const result = sessionWithSettings(
					settings,
					async (text) => {
						promptTexts.push(text);
						messages.push({ role: "user", content: text, timestamp: Date.now() } as never);
						if (promptTexts.length === 1) {
							messages.push({
								role: "assistant",
								stopReason: "error",
								errorMessage: "503 service unavailable",
								content: [],
							} as never);
							throw new Error("503 service unavailable");
						}
						return "resumed answer";
					},
					{
						messages,
						getLastAssistantText: () => "resumed answer",
						state: { messages },
						sessionManager: {},
						modelRuntime: {},
						getContextUsage: () => ({}),
						_runAgentContinue: async () => {
							continueCalls += 1;
							await continueReady;
							// A controlled pause aborts the in-flight continuation.
							throw new Error("Request aborted");
						},
					} as unknown as Partial<StageSessionRuntime>,
				);
				sessionRef = result.session;
				return result;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;

		const prompt = ctx.prompt("do it");
		// Let the first attempt fail, the backoff elapse, and the continuation start.
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(continueCalls, 1, "the retry must reach the continuation path");
		const pause = ctx.__requestPause();
		releaseContinue?.();
		await pause;
		await ctx.__resume("replacement objective");

		assert.equal(await prompt, "resumed answer");
		assert.deepEqual(promptTexts, ["do it", "replacement objective"]);
		assert.deepEqual(created, ["anthropic/primary"], "a controlled pause must not spend a fallback candidate");
		assert.equal(typeof sessionRef?.abort, "function");
	});
});
