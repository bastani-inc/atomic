import assert from "node:assert/strict";
import { recordProviderRateLimit } from "@bastani/atomic";
import type { Model } from "@bastani/atomic-ai";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type {
	AgentSessionAdapter,
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "./stage-runner-helpers.js";
import { assistantMessageWithUsage, createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

const reasoningModel: Model<"openai-completions"> = {
	type: "chat",
	provider: "p",
	id: "a",
	name: "a",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
};

const nonReasoningModel: Model<"openai-completions"> = {
	...reasoningModel,
	provider: "n",
	id: "b",
	name: "b",
	reasoning: false,
};

describe("workflow stage admission and continuation effort checks", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("a stage whose first attach fails before readiness re-filters its chain after an effort change (#3326)", async () => {
		const created: string[] = [];
		let readyFailures = 1;
		const opts: StageRunnerOpts = {
			stageId: "stage-admission-readiness",
			stageName: "Reviewer",
			runId: "run-admission-readiness",
			stageOptions: {
				model: "p/a",
				fallbackModels: ["n/b"],
				modelConstraints: { allowedEfforts: [null, "high"] },
			},
			models: {
				async listModels() {
					return [
						{ provider: "p", id: "a", fullId: "p/a", model: reasoningModel },
						{ provider: "n", id: "b", fullId: "n/b", model: nonReasoningModel },
					];
				},
				hasCredentials: () => true,
			},
			onSessionReady() {
				if (readyFailures > 0) {
					readyFailures--;
					throw new Error("session ready hook failed");
				}
			},
			adapters: {
				agentSession: {
					async create(options: StageSessionCreateOptions): Promise<StageSessionRuntime> {
						const model = options.model as Model<"openai-completions">;
						created.push(`${model.provider}/${model.id}`);
						let thinkingLevel: StageSessionRuntime["thinkingLevel"] = model.reasoning
							? (options.thinkingLevel ?? "medium")
							: "off";
						const { session } = makeMockSession({
							model,
							setThinkingLevel(level) {
								if (model.reasoning) thinkingLevel = level;
							},
							async prompt() {
								return "ok";
							},
						});
						Object.defineProperty(session, "thinkingLevel", { get: () => thinkingLevel });
						return session;
					},
				},
			},
		};
		const ctx = createStageContext(opts);
		try {
			await ctx.setThinkingLevel("high");
			await assert.rejects(ctx.prompt("first"), /session ready hook failed/);
			await ctx.setThinkingLevel("low");
			assert.equal(await ctx.prompt("second"), "ok");
			assert.deepEqual(created, ["p/a", "n/b"]);
		} finally {
			await ctx.__dispose();
		}
	});

	test("cycling an adapter's unreported effort to an excluded level blocks the next stage request (#3326)", async () => {
		let appliedEffort: StageSessionRuntime["thinkingLevel"];
		const requestedEfforts: StageSessionRuntime["thinkingLevel"][] = [];
		const ctx = createStageContext(
			makeOpts({
				stageOptions: { model: "p/a:high", modelConstraints: { allowedEfforts: ["high"] } },
				adapters: {
					agentSession: {
						async create() {
							return makeMockSession({
								model: reasoningModel,
								thinkingLevel: undefined,
								setThinkingLevel(level) {
									appliedEffort = level;
								},
								async cycleThinkingLevel() {
									appliedEffort = "low";
									return "low";
								},
								async prompt() {
									requestedEfforts.push(appliedEffort);
									return "ok";
								},
							}).session;
						},
					},
				},
			}),
		);
		try {
			assert.equal(await ctx.prompt("first"), "ok");
			assert.equal(await ctx.cycleThinkingLevel(), "low");
			await assert.rejects(ctx.prompt("excluded"), /modelConstraints/);
			assert.deepEqual(requestedEfforts, ["high"]);
			await ctx.setThinkingLevel("high");
			assert.equal(await ctx.prompt("allowed"), "ok");
			assert.deepEqual(requestedEfforts, ["high", "high"]);
		} finally {
			await ctx.__dispose();
		}
	});

	test("a concurrent effort change is not overwritten when stage readiness finishes applying an earlier effort (#3326)", async () => {
		const applyingHigh = Promise.withResolvers<void>();
		const finishHigh = Promise.withResolvers<void>();
		let appliedEffort: StageSessionRuntime["thinkingLevel"];
		const requestedEfforts: StageSessionRuntime["thinkingLevel"][] = [];
		const ctx = createStageContext(
			makeOpts({
				stageOptions: { model: "p/a:low", modelConstraints: { allowedEfforts: ["high"] } },
				adapters: {
					agentSession: {
						async create() {
							return makeMockSession({
								thinkingLevel: undefined,
								async setThinkingLevel(level) {
									appliedEffort = level;
									if (level === "high") {
										applyingHigh.resolve();
										await finishHigh.promise;
									}
								},
								async prompt() {
									requestedEfforts.push(appliedEffort);
									return "ok";
								},
							}).session;
						},
					},
				},
			}),
		);
		await ctx.setThinkingLevel("high");
		const pending = ctx.prompt("run");
		const rejected = assert.rejects(pending, /modelConstraints/);
		try {
			await applyingHigh.promise;
			await ctx.setThinkingLevel("low");
			finishHigh.resolve();
			await rejected;
			assert.deepEqual(requestedEfforts, []);
		} finally {
			finishHigh.resolve();
			await Promise.allSettled([pending, rejected]);
			await ctx.__dispose();
		}
	});

	test("a retry continuation that waits for its provider rechecks the effective effort before continuing (#3326)", async () => {
		const messages: StageSessionRuntime["messages"] = [];
		let thinkingLevel: StageSessionRuntime["thinkingLevel"] = "high";
		const continuedAt: string[] = [];
		let promptCalls = 0;
		let waiting = false;
		const settings = { enabled: true, maxRetries: 2, baseDelayMs: 0 };
		const agentSession: AgentSessionAdapter = {
			async create() {
				const { session } = makeMockSession({
					async prompt(text) {
						promptCalls++;
						messages.push({ role: "user", content: text, timestamp: Date.now() });
						messages.push(
							Object.assign(
								assistantMessageWithUsage(
									"",
									{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
									"error",
								),
								{ errorMessage: "503 service unavailable" },
							),
						);
						recordProviderRateLimit("continuation-effort", { status: 429, retryAfterMs: 2000 });
						throw new Error("503 service unavailable");
					},
					setThinkingLevel(level) {
						thinkingLevel = level;
					},
					messages,
					getLastAssistantText: () => "ok",
				});
				Object.assign(session, {
					state: { messages },
					sessionManager: {},
					modelRuntime: {},
					getContextUsage: () => ({}),
					_runAgentContinue: async () => {
						continuedAt.push(String(thinkingLevel));
						messages.push(
							assistantMessageWithUsage("ok", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
						);
					},
				});
				Object.defineProperty(session, "thinkingLevel", { get: () => thinkingLevel });
				return { session, settingsManager: { getRetrySettings: () => settings } };
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "continuation-effort/a", modelConstraints: { allowedEfforts: ["high"] } },
				onModelFallbackMetaChange(meta) {
					if (meta.rateLimits?.some((limit) => limit.waitingUntil !== undefined)) waiting = true;
				},
			}),
		);
		await ctx.setThinkingLevel("high");
		const pending = ctx.prompt("run");
		const outcome = pending.then(
			() => undefined,
			(error: Error) => error,
		);
		try {
			for (let step = 0; step < 50 && !waiting; step++) await vi.advanceTimersByTimeAsync(10);
			assert.equal(waiting, true);
			await ctx.setThinkingLevel("low");
			await vi.advanceTimersByTimeAsync(3000);
			const failure = await outcome;
			assert.ok(failure instanceof Error);
			assert.match(failure.message, /modelConstraints/);
			assert.equal(promptCalls, 1);
			assert.deepEqual(continuedAt, []);
		} finally {
			await ctx.abort();
			await Promise.allSettled([pending, outcome]);
			await ctx.__dispose();
		}
	});
});
