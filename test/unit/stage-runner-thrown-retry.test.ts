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
		const settings = retrySettings();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = modelFor(options);
				created.push(model);
				return sessionWithSettings(
					settings,
					async () => {
						promptCalls.push(model);
						if (model === "anthropic/primary") throw new Error("503 service unavailable");
						return "fallback answer";
					},
					{
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
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.map(({ model, success }) => ({ model, success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: true },
			],
		);
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

	test("retries auth and request-incompatible thrown failures before advancing", async () => {
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
			assert.deepEqual(calls, ["anthropic/primary", "anthropic/primary", "anthropic/primary", "openai/fallback"]);
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
