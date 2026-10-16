import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	createRunBudgetController,
	WorkflowBudgetExceededError,
} from "../../packages/workflows/src/engine/run-budget.js";
import { loadConfigFile } from "../../packages/workflows/src/extension/config-file-loader.js";
import { withWorkflowDefaults } from "../../packages/workflows/src/extension/config-loader.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	type EffectiveBudget,
	enforceDurationBudget,
	resolve_budget,
	validateWorkflowBudget,
	type WorkflowBudget,
} from "../../packages/workflows/src/shared/budget.js";
import { meter_run } from "../../packages/workflows/src/shared/budget-meter.js";
import {
	effectiveRunStatus,
	isReturnedBlockedWorkflowStatus,
	isReturnedResumableBlockedWorkflowStatus,
} from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowModelAttempt, WorkflowModelUsage } from "../../packages/workflows/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

afterEach(() => vi.useRealTimers());

function budgetRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "budget-test-run",
		name: "budget-test",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 0,
		...overrides,
	};
}

function budgetAttempt(model: string, usage: WorkflowModelUsage): WorkflowModelAttempt {
	return { model, success: true, usage };
}

function usageStage(name: string, modelAttempts: readonly WorkflowModelAttempt[]): RunSnapshot["stages"][number] {
	return {
		id: name,
		name,
		status: "completed",
		parentIds: [],
		toolEvents: [],
		modelAttempts,
	};
}

function budgetUsageSession(usage: WorkflowModelUsage): AgentSessionAdapter {
	return {
		async create() {
			const messages: AgentSession["messages"] = [];
			let answer = "";
			return makeMockSession({
				messages,
				async prompt() {
					answer = "budget usage answer";
					messages.push(
						assistantMessageWithUsage(answer, {
							input: usage.input ?? 0,
							output: usage.output ?? 0,
							cacheRead: usage.cacheRead ?? 0,
							cacheWrite: usage.cacheWrite ?? 0,
							cost: usage.cost ?? 0,
						}),
					);
				},
				getLastAssistantText: () => answer,
			}).session;
		},
	};
}

const BUDGET_FIELDS = [
	["maxDurationMs", 10, 20, 30],
	["maxTokens", 11, 21, 31],
	["maxCost", 12.5, 22.5, 32.5],
	["warnAtPercent", 13.5, 23.5, 33.5],
] as const satisfies readonly [keyof WorkflowBudget, number, number, number][];

function budgetField(field: keyof WorkflowBudget, value: number): WorkflowBudget {
	return { [field]: value };
}

type IsAssignable<TSource, TTarget> = [TSource] extends [TTarget] ? true : false;
type UnresolvedBudget = {
	readonly maxDurationMs: number;
	readonly maxTokens: number;
	readonly maxCost: number;
	readonly warnAtPercent: number;
};

const effectiveBudgetRejectsUnresolvedDeclarations: IsAssignable<UnresolvedBudget, EffectiveBudget> extends false
	? true
	: never = true;

interface BudgetOutcome {
	readonly status?: string;
	readonly dimension?: string;
	readonly ceiling?: number;
	readonly reading?: number;
	readonly frontierStage?: string;
	readonly wrapUpSummary?: string;
	readonly wrapUpUsage?: WorkflowModelUsage;
}

function budgetOutcome(value: object | undefined): BudgetOutcome | undefined {
	return value as BudgetOutcome | undefined;
}

function assertBudgetBlockedSnapshot(snapshot: RunSnapshot | undefined): asserts snapshot is RunSnapshot {
	assert.ok(snapshot);
	assert.equal(effectiveRunStatus(snapshot), "blocked");
	assert.notEqual(snapshot.endedAt, undefined);
	assert.equal(summarizeRunSnapshot(snapshot).status, "blocked");
}

describe("workflow budget resolution", () => {
	test("budget later layers win per field for every layer-presence combination", () => {
		for (const [field, configValue, definitionValue, runValue] of BUDGET_FIELDS) {
			for (const configPresent of [false, true]) {
				for (const definitionPresent of [false, true]) {
					for (const runPresent of [false, true]) {
						const resolved = resolve_budget({
							...(configPresent ? { config: budgetField(field, configValue) } : {}),
							...(definitionPresent ? { definition: budgetField(field, definitionValue) } : {}),
							...(runPresent ? { run: budgetField(field, runValue) } : {}),
						});
						const expected = runPresent
							? runValue
							: definitionPresent
								? definitionValue
								: configPresent
									? configValue
									: field === "warnAtPercent"
										? 80
										: 0;

						assert.equal(
							resolved[field],
							expected,
							`${field}: ${configPresent}/${definitionPresent}/${runPresent}`,
						);
					}
				}
			}
		}
	});

	test("budget later partial layers retain earlier fields", () => {
		const config = { maxDurationMs: 10, maxTokens: 11, maxCost: 12.5, warnAtPercent: 13.5 };
		const runResolved = resolve_budget({ config, run: { maxTokens: 31 } });
		assert.equal(runResolved.maxDurationMs, 10);
		assert.equal(runResolved.maxTokens, 31);
		assert.equal(runResolved.maxCost, 12.5);
		assert.equal(runResolved.warnAtPercent, 13.5);

		const definitionResolved = resolve_budget({ config, definition: { maxCost: 5 } });
		assert.equal(definitionResolved.maxDurationMs, 10);
		assert.equal(definitionResolved.maxTokens, 11);
		assert.equal(definitionResolved.maxCost, 5);
		assert.equal(definitionResolved.warnAtPercent, 13.5);
	});

	test("budget later zero disables a field", () => {
		const resolved = resolve_budget({
			config: { maxDurationMs: 10, maxTokens: 20, maxCost: 30, warnAtPercent: 80 },
			definition: { maxDurationMs: 0, maxTokens: 0 },
			run: { maxCost: 0, warnAtPercent: 0 },
		});

		assert.equal(resolved.maxDurationMs, 0);
		assert.equal(resolved.maxTokens, 0);
		assert.equal(resolved.maxCost, 0);
		assert.equal(resolved.warnAtPercent, 0);
	});
});

describe("duration budget enforcement", () => {
	test("uses the default warning threshold and reports duration readings", () => {
		const budget = resolve_budget({ run: { maxDurationMs: 100 } });
		assert.equal(budget.warnAtPercent, 80);
		assert.deepEqual(enforceDurationBudget(80, budget), {
			kind: "continue",
			report: { dimension: "duration", reading: 80, ceiling: 100, percent: 80 },
			warning: true,
		});
		assert.deepEqual(enforceDurationBudget(80, budget, { warned: true }), {
			kind: "continue",
			report: { dimension: "duration", reading: 80, ceiling: 100, percent: 80 },
			warning: false,
		});
	});

	test("exhausts at the duration ceiling and leaves unbudgeted runs untouched", () => {
		const budget = resolve_budget({ run: { maxDurationMs: 1 } });
		assert.deepEqual(enforceDurationBudget(1, budget), {
			kind: "exhausted",
			report: { dimension: "duration", reading: 1, ceiling: 1, percent: 100 },
		});
		const unbudgeted = resolve_budget({});
		assert.deepEqual(enforceDurationBudget(10_000, unbudgeted), {
			kind: "continue",
			report: { dimension: "duration", reading: 10_000, ceiling: 0, percent: 0 },
			warning: false,
		});
	});
});

describe("budget duration controller", () => {
	test("warns once and excludes paused time from the meter", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const run = budgetRun({ pausedAt: 9_000, pausedDurationMs: 4_000 });
		const warnings: number[] = [];
		const controller = createRunBudgetController({
			run,
			budget: resolve_budget({ run: { maxDurationMs: 6_000 } }),
			onWarning: (report) => warnings.push(report.reading),
		});
		assert.equal(controller.checkpoint("work").kind, "warn");
		assert.equal(controller.checkpoint("work").kind, "continue");
		assert.deepEqual(warnings, [5_000]);
		run.pausedAt = undefined;
		vi.setSystemTime(11_000);
		assert.equal(controller.checkpoint("work").kind, "wrap_up");
		assert.equal(run.budgetState?.duration?.reading, 7_000);
	});

	test("soft landing records exact report fields and usage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(11);
		const run = budgetRun();
		const controller = createRunBudgetController({ run, budget: resolve_budget({ run: { maxDurationMs: 10 } }) });
		assert.equal(controller.checkpoint("frontier").kind, "wrap_up");
		controller.registerWrapUp("frontier", async () => {
			throw controller.finishWrapUp("frontier", "progress", { output: 3 });
		});
		await assert.rejects(controller.deliverWrapUp("frontier"), (error: unknown) => {
			assert.ok(error instanceof WorkflowBudgetExceededError);
			assert.equal(error.report.dimension, "duration");
			assert.equal(error.report.reading, 11);
			assert.equal(error.report.ceiling, 10);
			assert.ok(Math.abs(error.report.percent - 110) < 1e-9);
			assert.equal(error.report.frontierStage, "frontier");
			assert.equal(error.report.wrapUpSummary, "progress");
			assert.deepEqual(error.report.wrapUpUsage, { output: 3 });
			return true;
		});
		assert.equal(controller.checkpoint("frontier").kind, "exhausted");
	});

	test("budget executor records the wrap-up turn usage in the exhaustion report", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const messages: AgentSession["messages"] = [];
		let promptCount = 0;
		let lastAssistantText = "";
		const usage = { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 0.011 };
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({
					messages,
					async prompt() {
						const text = promptCount++ === 0 ? "progress" : "wrap summary";
						if (promptCount === 1) vi.advanceTimersByTime(2);
						lastAssistantText = text;
						messages.push(assistantMessageWithUsage(text, usage));
					},
					getLastAssistantText: () => lastAssistantText,
				}).session;
			},
		};
		const definition = workflow({
			name: "budget-wrap-up-usage",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("frontier", { model: "test/model" }).prompt("progress") }),
		});
		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				budget: { maxDurationMs: 1 },
				adapters: { agentSession },
			},
		);
		assert.equal(budgetOutcome(result.result)?.wrapUpSummary, "wrap summary");
		assert.deepEqual(budgetOutcome(result.result)?.wrapUpUsage, { ...usage, turns: 1 });
	});

	test("no budget leaves the run untouched and performs no meter work", () => {
		vi.useFakeTimers();
		vi.setSystemTime(99_999);
		const run = budgetRun();
		const controller = createRunBudgetController({ run, budget: resolve_budget({}) });
		assert.deepEqual(controller.checkpoint("work"), { kind: "continue" });
		assert.equal(run.budgetState, undefined);
		assert.equal(controller.enabled, false);
	});

	test("same-budget resume is exhausted immediately while a raised ceiling continues", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10);
		const prior = budgetRun({
			accumulatedDurationMs: 10,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
			budgetState: {
				duration: { dimension: "duration", reading: 10, ceiling: 10, percent: 100 },
				wrapUpDelivered: true,
				wrapUpCompleted: true,
				wrapUpSummary: "progress",
			},
		});
		const same = createRunBudgetController({ run: prior, budget: resolve_budget({ run: { maxDurationMs: 10 } }) });
		assert.equal(same.checkpoint("work").kind, "exhausted");
		const raised = budgetRun({ accumulatedDurationMs: 8 });
		const raisedController = createRunBudgetController({
			run: raised,
			budget: resolve_budget({ run: { maxDurationMs: 20 } }),
		});
		assert.notEqual(raisedController.checkpoint("work").kind, "exhausted");
	});
});

describe("token and cost budget metering", () => {
	test("budget meter preserves the exact RunMeters shape and aggregates nested retries", () => {
		const tree = {
			run: budgetRun({
				startedAt: 10,
				toolNodes: [],
				stages: [
					usageStage("root", [
						budgetAttempt("root-first", { input: 2, output: 3, cacheRead: 7, cacheWrite: 11, cost: 0.2 }),
						budgetAttempt("root-retry", { input: 5, output: 1, cacheRead: 13, cacheWrite: 17, cost: 0.3 }),
					]),
				],
			}),
			children: [
				{
					run: budgetRun({
						id: "budget-child",
						stages: [usageStage("child", [budgetAttempt("child-model", { input: 4, output: 6, cost: 0.4 })])],
					}),
				},
			],
		};
		const meters = meter_run(tree, 110);
		assert.deepEqual(Object.keys(meters).sort(), ["cost", "durationMs", "perCounter", "tokens"]);
		assert.deepEqual(Object.keys(meters.perCounter).sort(), ["cacheRead", "cacheWrite", "input", "output"]);
		assert.deepEqual(meters, {
			durationMs: 100,
			tokens: 21,
			cost: 0.9,
			perCounter: { input: 11, output: 10, cacheRead: 20, cacheWrite: 28 },
		});
	});

	test("budget usage deltas saturate under out-of-order completions and concurrent checkpoints", async () => {
		const run = budgetRun({
			stages: [usageStage("metered", [budgetAttempt("model", { input: 4, output: 2, cost: 0.2 })])],
		});
		const tree = { run };
		const controller = createRunBudgetController({
			run,
			budget: resolve_budget({ run: { maxTokens: 100, maxCost: 10 } }),
			usageTree: () => tree,
		});
		assert.equal(controller.checkpoint("work").kind, "continue");
		assert.equal(run.budgetState?.tokens?.reading, 6);
		run.stages[0]!.modelAttempts = [budgetAttempt("late", { input: 1, output: 1, cost: 0.1 })];
		await Promise.all([
			Promise.resolve(controller.checkpoint("work")),
			Promise.resolve(controller.checkpoint("work")),
		]);
		assert.equal(run.budgetState?.tokens?.reading, 6);
		assert.equal(run.budgetState?.cost?.reading, 0.2);
	});

	test("budget child scopes and concurrent top-level runs account independently", async () => {
		const childRun = budgetRun({
			id: "budget-child-scope",
			stages: [usageStage("child", [budgetAttempt("child", { input: 3 })])],
		});
		const rootRun = budgetRun({
			id: "budget-root-scope",
			stages: [usageStage("root", [budgetAttempt("root", { output: 2 })])],
		});
		const rootTree = { run: rootRun, children: [{ run: childRun }] };
		const rootController = createRunBudgetController({
			run: rootRun,
			budget: resolve_budget({ run: { maxTokens: 100 } }),
			usageTree: () => rootTree,
		});
		const childController = createRunBudgetController({
			run: childRun,
			budget: resolve_budget({ run: { maxTokens: 100 } }),
			usageTree: () => ({ run: childRun }),
		});
		assert.equal(rootController.checkpoint("root").kind, "continue");
		assert.equal(childController.checkpoint("child").kind, "continue");
		assert.equal(rootRun.budgetState?.tokens?.reading, 5);
		assert.equal(childRun.budgetState?.tokens?.reading, 3);

		const first = budgetRun({
			id: "budget-run-one",
			stages: [usageStage("one", [budgetAttempt("one", { input: 3 })])],
		});
		const second = budgetRun({
			id: "budget-run-two",
			stages: [usageStage("two", [budgetAttempt("two", { input: 3 })])],
		});
		const firstController = createRunBudgetController({
			run: first,
			budget: resolve_budget({ run: { maxTokens: 2 } }),
			usageTree: () => ({ run: first }),
		});
		const secondController = createRunBudgetController({
			run: second,
			budget: resolve_budget({ run: { maxTokens: 10 } }),
			usageTree: () => ({ run: second }),
		});
		const [firstCheck, secondCheck] = await Promise.all([
			Promise.resolve(firstController.checkpoint("one")),
			Promise.resolve(secondController.checkpoint("two")),
		]);
		assert.equal(firstCheck.kind, "wrap_up");
		assert.equal(secondCheck.kind, "continue");
	});

	test("budget resume carries token and cost baselines across a fresh continuation", () => {
		const source = budgetRun({
			id: "budget-source",
			stages: [usageStage("source", [budgetAttempt("source", { input: 5, output: 2, cost: 0.5 })])],
		});
		const sourceController = createRunBudgetController({
			run: source,
			budget: resolve_budget({ run: { maxTokens: 100, maxCost: 10 } }),
			usageTree: () => ({ run: source }),
		});
		sourceController.checkpoint("source");
		const resumed = budgetRun({
			id: "budget-resumed",
			resumedFromRunId: source.id,
			budgetState: source.budgetState,
		});
		const resumedController = createRunBudgetController({
			run: resumed,
			budget: resolve_budget({ run: { maxTokens: 100, maxCost: 10 } }),
			usageTree: () => ({ run: resumed }),
		});
		resumed.stages.push(usageStage("next", [budgetAttempt("next", { input: 3, output: 1, cost: 0.25 })]));
		assert.equal(resumedController.checkpoint("next").kind, "continue");
		assert.equal(resumed.budgetState?.tokens?.reading, 11);
		assert.equal(resumed.budgetState?.cost?.reading, 0.75);
	});

	test("budget resume excludes replayed stages from token and cost re-accounting", () => {
		const source = budgetRun({
			id: "budget-replayed-source",
			stages: [
				usageStage("source", [
					budgetAttempt("source", { input: 5, output: 2, cacheRead: 11, cacheWrite: 13, cost: 0.5 }),
				]),
			],
		});
		const sourceController = createRunBudgetController({
			run: source,
			budget: resolve_budget({ run: { maxTokens: 100, maxCost: 10 } }),
			usageTree: () => ({ run: source }),
		});
		assert.equal(sourceController.checkpoint("source").kind, "continue");

		const resumed = budgetRun({
			id: "budget-replayed-resumed",
			resumedFromRunId: source.id,
			budgetState: source.budgetState,
			stages: [{ ...usageStage("source", source.stages[0].modelAttempts ?? []), replayed: true }],
		});
		const resumedController = createRunBudgetController({
			run: resumed,
			budget: resolve_budget({ run: { maxTokens: 100, maxCost: 10 } }),
			usageTree: () => ({ run: resumed }),
		});
		resumed.stages.push(
			usageStage("next", [
				budgetAttempt("next", { input: 3, output: 1, cacheRead: 17, cacheWrite: 19, cost: 0.25 }),
			]),
		);

		assert.equal(resumedController.checkpoint("next").kind, "continue");
		assert.equal(resumed.budgetState?.tokens?.reading, 11);
		assert.equal(resumed.budgetState?.cost?.reading, 0.75);
		assert.deepEqual(resumed.budgetState?.accounting?.perCounter, {
			input: 8,
			output: 3,
			cacheRead: 28,
			cacheWrite: 32,
		});
	});

	test("budget cache counters are reported, cost charges cache-heavy spend, and tokens do not", () => {
		const run = budgetRun({
			stages: [
				usageStage("cache-heavy", [
					budgetAttempt("cached", { input: 4, output: 4, cacheRead: 1000, cacheWrite: 500, cost: 1.25 }),
				]),
			],
		});
		const tree = { run };
		const tokenOnly = createRunBudgetController({
			run,
			budget: resolve_budget({ run: { maxTokens: 10 } }),
			usageTree: () => tree,
		});
		assert.notEqual(tokenOnly.checkpoint("cache-heavy").kind, "wrap_up");
		assert.equal(run.budgetState?.tokens?.reading, 8);
		assert.deepEqual(run.budgetState?.accounting?.perCounter, {
			input: 4,
			output: 4,
			cacheRead: 1000,
			cacheWrite: 500,
		});

		const costRun = budgetRun({
			stages: [
				usageStage("cache-cost", [
					budgetAttempt("cached", { input: 4, output: 4, cacheRead: 1000, cacheWrite: 500, cost: 1.25 }),
				]),
			],
		});
		const costController = createRunBudgetController({
			run: costRun,
			budget: resolve_budget({ run: { maxTokens: 10, maxCost: 1 } }),
			usageTree: () => ({ run: costRun }),
		});
		const check = costController.checkpoint("cache-cost");
		assert.equal(check.kind, "wrap_up");
		if (check.kind === "wrap_up") assert.equal(check.report.dimension, "cost");
	});

	test("budget executor soft-lands on token exhaustion at a stage boundary", async () => {
		const messages: AgentSession["messages"] = [];
		let promptCount = 0;
		let lastAssistantText = "";
		const usage = { input: 2, output: 3, cacheRead: 8, cacheWrite: 9, cost: 0.25 };
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({
					messages,
					async prompt() {
						lastAssistantText = promptCount++ === 0 ? "progress" : "wrap summary";
						messages.push(assistantMessageWithUsage(lastAssistantText, usage));
					},
					getLastAssistantText: () => lastAssistantText,
				}).session;
			},
		};
		const definition = workflow({
			name: "budget-token-soft-land",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({
				result: await ctx.stage("token-frontier", { model: "test/model" }).prompt("progress"),
			}),
		});
		const result = await run(
			definition,
			{},
			{ store: createStore(), budget: { maxTokens: 1 }, adapters: { agentSession } },
		);
		const report = budgetOutcome(result.result);
		assert.equal(report?.status, "budget_exceeded");
		assert.equal(report?.dimension, "tokens");
		assert.equal(report?.reading, 5);
		assert.equal(report?.frontierStage, "token-frontier");
		assert.equal(report?.wrapUpSummary, "wrap summary");
	});

	test("budget executor enforces a definition token budget through default-model store usage", async () => {
		const messages: AgentSession["messages"] = [];
		let promptCount = 0;
		let lastAssistantText = "";
		const usage = { input: 2, output: 3, cacheRead: 8, cacheWrite: 9, cost: 0.25 };
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({
					model: { provider: "anthropic", id: "default-budget" } as AgentSession["model"],
					messages,
					async prompt() {
						lastAssistantText = promptCount++ === 0 ? "progress" : "wrap summary";
						messages.push(assistantMessageWithUsage(lastAssistantText, usage));
					},
					getLastAssistantText: () => lastAssistantText,
				}).session;
			},
		};
		const definition = workflow({
			name: "budget-definition-default-model",
			description: "",
			budget: { maxTokens: 1 },
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("default-frontier").prompt("progress") }),
		});
		const store = createStore();
		const result = await run(definition, {}, { store, adapters: { agentSession } });

		const report = budgetOutcome(result.result);
		assert.equal(report?.status, "budget_exceeded");
		assert.equal(report?.dimension, "tokens");
		assert.equal(report?.reading, 5);
		assert.equal(report?.frontierStage, "default-frontier");
		assert.equal(report?.wrapUpSummary, "wrap summary");
		assert.deepEqual(store.runs()[0]?.stages[0]?.modelAttempts?.[0]?.usage, { ...usage, turns: 1 });
	});

	test("budget same-id dispatch meters the store-resolved run snapshot", async () => {
		const runId = "budget-same-id-dispatch";
		const definition = workflow({
			name: "budget-same-id-dispatch",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				let result = "";
				for (let index = 0; index < 6; index++)
					result = await ctx.stage(`same-id-${index}`, { model: "test/model" }).prompt("work");
				return { result };
			},
		});
		const store = createStore();
		store.recordRunStart(
			budgetRun({
				id: runId,
				name: definition.name,
				budget: { maxDurationMs: 0, maxTokens: 12, warnAtPercent: 80 },
			}),
		);

		const result = await run(
			definition,
			{},
			{
				runId,
				store,
				budget: { maxTokens: 12 },
				adapters: { agentSession: budgetUsageSession({ input: 2, output: 3 }) },
			},
		);

		const report = budgetOutcome(result.result);
		const snapshots = store.runs().filter((candidate) => candidate.id === runId);
		// #3106: one identity owns one store snapshot, including metered usage.
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0]?.stages.length, 3);
		assert.equal(report?.status, "budget_exceeded");
		assert.equal(report?.dimension, "tokens");
		assert.equal(report?.reading, 15);
		assert.equal(report?.ceiling, 12);
	});

	test("budget same-id dispatch enforces duration with a token ceiling", async () => {
		vi.useFakeTimers();
		const startedAt = 10_000;
		const priorDurationMs = 5;
		const maxDurationMs = 1_000;
		const workDurationMs = maxDurationMs + 1;
		const maxTokens = 1_000_000;
		vi.setSystemTime(startedAt);
		const runId = "budget-same-id-duration-with-tokens";
		const messages: AgentSession["messages"] = [];
		let promptCount = 0;
		let lastAssistantText = "";
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({
					messages,
					async prompt() {
						lastAssistantText = promptCount++ === 0 ? "work complete" : "wrap summary";
						if (promptCount === 1) vi.advanceTimersByTime(workDurationMs);
						messages.push(
							assistantMessageWithUsage(lastAssistantText, {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
							}),
						);
					},
					getLastAssistantText: () => lastAssistantText,
				}).session;
			},
		};
		const definition = workflow({
			name: "budget-same-id-duration-with-tokens",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("duration-frontier", { model: "test/model" }).prompt("work") }),
		});
		const store = createStore();
		store.recordRunStart(
			budgetRun({
				id: runId,
				name: definition.name,
				status: "completed",
				startedAt: startedAt - priorDurationMs,
				endedAt: startedAt,
				durationMs: priorDurationMs,
				budget: { maxDurationMs, maxTokens, warnAtPercent: 80 },
			}),
		);

		const result = await run(
			definition,
			{},
			{ runId, store, budget: { maxDurationMs, maxTokens }, adapters: { agentSession } },
		);

		const report = budgetOutcome(result.result);
		assert.equal(report?.status, "budget_exceeded");
		assert.equal(report?.dimension, "duration");
		assert.equal(report?.reading, workDurationMs);
		assert.equal(report?.ceiling, maxDurationMs);
	});

	test("budget prior-run carry charges fresh store usage", async () => {
		const runId = "budget-prior-run-accounting";
		const definition = workflow({
			name: "budget-prior-run-accounting",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({
				result: await ctx.stage("fresh-spend", { model: "test/model" }).prompt("fresh work"),
			}),
		});
		const store = createStore();
		store.recordRunStart(
			budgetRun({
				id: runId,
				name: definition.name,
				budget: { maxDurationMs: 0, maxTokens: 250, warnAtPercent: 80 },
				budgetState: {
					accounting: {
						baseline: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0 },
						tokens: 200,
						cost: 0,
						perCounter: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);

		const result = await run(
			definition,
			{},
			{
				runId,
				store,
				budget: { maxTokens: 250 },
				adapters: { agentSession: budgetUsageSession({ input: 50, output: 30 }) },
			},
		);

		const report = budgetOutcome(result.result);
		const current = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(report?.status, "budget_exceeded");
		assert.equal(report?.dimension, "tokens");
		assert.equal(report?.reading, 280);
		assert.equal(current?.budgetState?.accounting?.tokens, 280);
	});

	test("budget prior-run carry with stages does not recharge persisted usage", async () => {
		const runId = "budget-prior-run-stages-accounting";
		const definition = workflow({
			name: "budget-prior-run-stages-accounting",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({
				result: await ctx.stage("fresh-spend", { model: "test/model" }).prompt("fresh work"),
			}),
		});
		const store = createStore();
		store.recordRunStart(
			budgetRun({
				id: runId,
				name: definition.name,
				budget: { maxDurationMs: 0, maxTokens: 250, warnAtPercent: 80 },
				stages: [usageStage("prior-spend", [budgetAttempt("test/model", { input: 120, output: 80 })])],
				budgetState: {
					accounting: {
						baseline: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0 },
						tokens: 200,
						cost: 0,
						perCounter: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);

		const result = await run(
			definition,
			{},
			{
				runId,
				store,
				budget: { maxTokens: 250 },
				adapters: { agentSession: budgetUsageSession({ input: 50, output: 30 }) },
			},
		);

		const report = budgetOutcome(result.result);
		const snapshots = store.runs().filter((candidate) => candidate.id === runId);
		assert.equal(report?.status, "budget_exceeded");
		assert.equal(report?.dimension, "tokens");
		assert.equal(report?.reading, 280);
		assert.equal(report?.ceiling, 250);
		assert.equal(snapshots.length, 1);
		assert.deepEqual(
			snapshots[0]?.stages.map((stage) => stage.name),
			["fresh-spend"],
		);
		assert.equal(snapshots[0]?.budgetState?.accounting?.tokens, 280);
	});

	test("budget durable resume carries token and cost accounting after the prior snapshot is removed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const runId = "budget-durable-accounting";
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-durable-accounting",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				let result = "";
				for (let index = 1; index <= 6; index++)
					result = await ctx.stage(`durable-spend-${index}`, { model: "test/model" }).prompt("work");
				return { result };
			},
		});
		const store = createStore();
		let promptCount = 0;
		const agentSession: AgentSessionAdapter = {
			async create() {
				const messages: AgentSession["messages"] = [];
				let answer = "";
				return makeMockSession({
					messages,
					async prompt() {
						promptCount++;
						answer = "durable budget answer";
						messages.push(
							assistantMessageWithUsage(answer, {
								input: 2,
								output: 3,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0.5,
							}),
						);
					},
					getLastAssistantText: () => answer,
				}).session;
			},
		};
		const opts = {
			runId,
			store,
			durableBackend: backend,
			budget: { maxTokens: 12, maxCost: 100 },
			adapters: { agentSession },
		};

		const first = await run(definition, {}, opts);
		assert.equal(budgetOutcome(first.result)?.reading, 15);
		assert.equal(store.runs()[0]?.budgetState?.accounting?.cost, 1.5);
		assert.equal(promptCount, 4);
		assert.equal(store.removeRun(runId), true);

		const resumed = await run(definition, {}, opts);
		assert.equal(budgetOutcome(resumed.result)?.status, "budget_exceeded");
		assert.equal(budgetOutcome(resumed.result)?.dimension, "tokens");
		assert.equal(budgetOutcome(resumed.result)?.reading, 15);
		assert.equal(store.runs()[0]?.budgetState?.accounting?.cost, 1.5);
		assert.equal(promptCount, 4, "durable resume must not grant a fresh usage allowance");
	});

	test("budget status reports token and cost dimensions alongside duration", () => {
		const run = budgetRun({
			budget: { maxDurationMs: 100, maxTokens: 10, maxCost: 1, warnAtPercent: 80 },
			stages: [usageStage("status", [budgetAttempt("model", { input: 3, output: 2, cost: 0.25 })])],
		});
		const controller = createRunBudgetController({
			run,
			budget: resolve_budget({ run: { maxDurationMs: 100, maxTokens: 10, maxCost: 1 } }),
			usageTree: () => ({ run }),
		});
		controller.checkpoint("status");
		const summary = summarizeRunSnapshot(run, 10);
		assert.equal(summary.budgetState?.duration?.dimension, "duration");
		assert.equal(summary.budgetState?.tokens?.reading, 5);
		assert.equal(summary.budgetState?.tokens?.ceiling, 10);
		assert.equal(summary.budgetState?.cost?.reading, 0.25);
		assert.equal(summary.budgetState?.cost?.ceiling, 1);
		const statusText = renderWorkflowToolContent(
			{ action: "status", filter: "all", runs: [summary], snapshots: [run] },
			{ action: "status" },
		);
		assert.match(statusText, /tokens: 5\/10 \(50\.0%\)/);
		assert.match(statusText, /cost: 0\.25\/1 \(25\.0%\)/);
	});
});
describe("workflow budget validation", () => {
	test("budget rejects negative, non-finite, and non-integer integer dimensions", () => {
		const invalid: readonly WorkflowBudget[] = [
			{ maxDurationMs: -1 },
			{ maxTokens: -1 },
			{ maxDurationMs: Number.NaN },
			{ maxTokens: Number.POSITIVE_INFINITY },
			{ maxDurationMs: 1.5 },
			{ maxTokens: 1.5 },
			{ maxCost: -0.01 },
			{ warnAtPercent: Number.NEGATIVE_INFINITY },
		];
		for (const budget of invalid) {
			assert.notEqual(validateWorkflowBudget(budget), null, JSON.stringify(budget));
		}
	});

	test("budget accepts zero and finite fractional cost and warning values", () => {
		const budget = { maxDurationMs: 0, maxTokens: 0, maxCost: 1.25, warnAtPercent: 80.5 };

		assert.equal(validateWorkflowBudget(budget), null);
		assert.throws(() => resolve_budget({ run: { maxTokens: 1.5 } }), TypeError);
	});

	test("budget config validation rejects an invalid declaration", async () => {
		const directory = makeTempDirectory("atomic-workflow-budget-");
		try {
			const filePath = join(directory, "config.json");
			await writeFileEnsuringDir(filePath, JSON.stringify({ budget: { maxTokens: -1 } }));
			const outcome = await loadConfigFile(filePath);

			assert.deepEqual(outcome.kind, "error");
			if (outcome.kind === "error") assert.match(outcome.diagnostic.message, /budget\.maxTokens/);
		} finally {
			removeTempDirectory(directory);
		}
	});
});

describe("workflow budget plumbing", () => {
	test("budget config defaults and authored declarations resolve without enforcement", () => {
		const effective = withWorkflowDefaults({ budget: { maxDurationMs: 100, maxCost: 2.5 } });
		assert.equal(effective.budget.maxDurationMs, 100);
		assert.equal(effective.budget.maxCost, 2.5);
		assert.equal(effective.budget.maxTokens, 0);

		const definition = workflow({
			name: "budget-child",
			description: "budget declaration test",
			budget: { maxTokens: 25 },
			outputs: { result: Type.String() },
			run: () => ({ result: "done" }),
		});
		assert.equal(definition.budget?.maxTokens, 25);
		assert.ok(Object.isFrozen(definition.budget));
		assert.throws(
			() =>
				workflow({
					name: "invalid-budget-child",
					description: "budget declaration test",
					budget: { maxDurationMs: -1 },
					outputs: {},
					run: () => ({}),
				}),
			TypeError,
		);
	});

	test("budget tool schema mirrors declared budget validation", () => {
		assert.equal(
			Value.Check(WorkflowParametersSchema, {
				action: "run",
				workflow: "budget-child",
				budget: { maxDurationMs: 0, maxTokens: 1, maxCost: 1.25, warnAtPercent: 80.5 },
			}),
			true,
		);
		assert.equal(
			Value.Check(WorkflowParametersSchema, { action: "run", workflow: "budget-child", budget: { maxTokens: 1.5 } }),
			false,
		);
		assert.equal(
			Value.Check(WorkflowParametersSchema, { action: "run", workflow: "budget-child", budget: { maxCost: -1 } }),
			false,
		);
	});
});
describe("budget executor boundaries", () => {
	test("child budget soft-lands its subtree while the parent continues", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const child = workflow({
			name: "budget-child-soft-land",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			budget: { maxDurationMs: 1 },
			run: async (ctx) => ({ value: await ctx.stage("child-frontier").complete("child work") }),
		});
		let parentContinued = false;
		const parent = workflow({
			name: "budget-parent-soft-land",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const childResult = await ctx.workflow(child, { stageName: "child-boundary" });
				assert.equal(childResult.exited, true);
				assert.equal(childResult.status, "blocked");
				parentContinued = true;
				await ctx.stage("parent-after-child").complete("parent continued");
				return { result: childResult.status };
			},
		});
		const store = createStore();
		const childPrompts: string[] = [];
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 100 },
				adapters: {
					complete: {
						complete: async (text) => {
							if (text === "child work") vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							childPrompts.push(text);
							return "child wrap-up";
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(result.result?.result, "blocked");
		assert.equal(parentContinued, true);
		assert.equal(childPrompts.length, 1);
		const childRun = store.runs().find((candidate) => candidate.name === child.name);
		assert.equal(childRun?.result?.status, "budget_exceeded");
		assert.equal(childRun?.budgetState?.wrapUpCompleted, true);
	});

	test("budget root scope stops an unbudgeted child at an internal boundary", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const childStages: string[] = [];
		const child = workflow({
			name: "budget-root-scope-child",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			run: async (ctx) => {
				let value = "";
				for (let index = 0; index < 4; index++) {
					value = await ctx.stage(`child-${index}`).complete(`child work ${index}`);
					childStages.push(value);
				}
				return { value };
			},
		});
		const parent = workflow({
			name: "budget-root-scope-parent",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const childResult = await ctx.workflow(child, { stageName: "child-boundary" });
				return { result: childResult.status };
			},
		});
		const store = createStore();
		const prompts: string[] = [];
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(4);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "root wrap-up";
						},
					},
				},
			},
		);
		const rootRun = store.runs().find((candidate) => candidate.name === parent.name);
		const childRun = store.runs().find((candidate) => candidate.name === child.name);
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.ceiling, 10);
		assert.equal(outcome?.frontierStage, "child-2");
		assert.equal(outcome?.wrapUpSummary, "root wrap-up");
		assert.equal(prompts.length, 1);
		assert.ok((outcome?.reading ?? 0) < 20);
		assert.ok(childStages.length < 4);
		assert.equal(rootRun?.budgetState?.systemOwnedStop, true);
		assert.equal(rootRun?.budgetState?.wrapUpCompleted, true);
		assert.equal(childRun?.budget, undefined);
		assert.equal(childRun?.budgetState?.wrapUpCompleted, true);
	});

	test("budget root wrap-up reaches a wider-budget child frontier", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const prompts: string[] = [];
		const child = workflow({
			name: "budget-wider-child",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			budget: { maxDurationMs: 1_000 },
			run: async (ctx) => ({ value: await ctx.stage("wider-frontier").complete("child work") }),
		});
		const parent = workflow({
			name: "budget-wider-parent",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const childResult = await ctx.workflow(child, { stageName: "wider-boundary" });
				return { result: childResult.status };
			},
		});
		const store = createStore();
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(20);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "wider child wrap-up";
						},
					},
				},
			},
		);
		const rootRun = store.runs().find((candidate) => candidate.name === parent.name);
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.frontierStage, "wider-frontier");
		assert.equal(outcome?.wrapUpSummary, "wider child wrap-up");
		assert.equal(prompts.length, 1);
		assert.equal(rootRun?.budgetState?.wrapUpCompleted, true);
	});

	test("root budget wins simultaneous child exhaustion and prevents parent continuation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const child = workflow({
			name: "budget-simultaneous-child",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			budget: { maxDurationMs: 1 },
			run: async (ctx) => ({ value: await ctx.stage("child-frontier").complete("child work") }),
		});
		let parentContinued = false;
		const parent = workflow({
			name: "budget-simultaneous-root",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.workflow(child, { stageName: "child-boundary" });
				parentContinued = true;
				await ctx.stage("must-not-run").complete("must not run");
				return { result: "continued" };
			},
		});
		const store = createStore();
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "root wrap-up" },
				},
			},
		);
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.dimension, "duration");
		assert.equal(parentContinued, false);
		assert.equal(store.runs().find((candidate) => candidate.name === parent.name)?.result?.status, "budget_exceeded");
		const rootRun = store.runs().find((candidate) => candidate.name === parent.name);
		assert.equal(rootRun?.budgetState?.wrapUpDelivered, true);
		assert.equal(rootRun?.budgetState?.wrapUpCompleted, true);
		const childRun = store.runs().find((candidate) => candidate.name === child.name);
		assert.equal(childRun?.result?.status, "budget_exceeded");
		assert.equal(childRun?.budgetState?.wrapUpCompleted, true);
		assert.equal(outcome?.frontierStage, "child-frontier");
		assert.equal(outcome?.wrapUpSummary, "root wrap-up");
		assert.equal(
			rootRun?.stages.some((stage) => stage.name === "must-not-run"),
			false,
		);
	});

	test("budget executor exhaustion wraps up the current turn without launching a new stage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const prompts: string[] = [];
		const completed: string[] = [];
		const definition = workflow({
			name: "budget-executor-exhaustion",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const progress = await ctx.stage("frontier").complete("progress");
				await ctx.stage("after-frontier").complete("must not run");
				return { result: progress };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							completed.push(text);
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "wrap-up summary";
						},
					},
				},
			},
		);
		assert.equal(result.status, "running");
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.dimension, "duration");
		assert.equal(outcome?.ceiling, 1);
		assert.equal(outcome?.frontierStage, "frontier");
		assert.equal(outcome?.wrapUpSummary, "wrap-up summary");
		assert.equal(completed.length, 1);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0] ?? "", /budget is exhausted/i);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.result?.status, "budget_exceeded");
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, true);
		assert.ok(snapshot);
		assert.equal(effectiveRunStatus(snapshot), "blocked");
		assert.equal(
			snapshot?.stages.some((stage) => stage.name === "after-frontier"),
			false,
		);
	});

	test("budget-free executor runs byte-identically without budget state or notices", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-free-executor",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("ordinary").complete("ordinary") }),
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(result.result?.result, "ordinary");
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.budget, undefined);
		assert.equal(snapshot?.budgetState, undefined);
		assert.deepEqual(store.notices(), []);
	});

	test("budget warning notice reaches the store once across repeated stage boundaries", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-warning-notice",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				let last = "";
				for (let index = 0; index < 6; index++) last = await ctx.stage(`step-${index}`).complete(`work ${index}`);
				return { result: last };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				config: withWorkflowDefaults({}),
				budget: { maxDurationMs: 200 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(30);
							return text;
						},
					},
					prompt: { prompt: async () => "wrap-up summary" },
				},
			},
		);

		// Six boundaries cross the 80% line repeatedly, but the shipped
		// store.recordNotice wiring must emit exactly one warning per dimension.
		const notices = store.notices();
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "warning");
		assert.equal(notices[0]?.id, `workflow-budget-warning:${result.runId}:duration`);
		assert.match(notices[0]?.message ?? "", /90\.0% of its duration budget \(180 \/ 200\)/);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.budgetState?.warned, true);
		// A warning must not stop the run: 180ms of 200ms never reaches the ceiling.
		assert.equal(result.status, "completed");
		assert.equal(result.result?.result, "work 5");
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
	});

	test("budget tool boundary does not consume an undeliverable wrap-up", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const prompts: string[] = [];
		const definition = workflow({
			name: "budget-tool-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("burn-budget", {}, async () => {
					vi.advanceTimersByTime(20);
					return "burned";
				});
				return { result: "must not complete" };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "must not prompt";
						},
					},
				},
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.wrapUpSummary, undefined);
		assert.equal(prompts.length, 0);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, undefined);
		assertBudgetBlockedSnapshot(snapshot);
	});

	test("budget child-workflow boundary does not consume an undeliverable wrap-up", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const child = workflow({
			name: "budget-tool-child",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("child-burn", {}, async () => {
					vi.advanceTimersByTime(20);
					return "burned";
				});
				return { result: "child done" };
			},
		});
		const prompts: string[] = [];
		const parent = workflow({
			name: "budget-child-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.workflow(child, { stageName: "child-frontier", budget: { maxDurationMs: 0 } });
				return { result: "must not complete" };
			},
		});
		const store = createStore();
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "must not prompt";
						},
					},
				},
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(budgetOutcome(result.result)?.wrapUpSummary, undefined);
		assert.equal(prompts.length, 0);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, undefined);
		assertBudgetBlockedSnapshot(snapshot);
	});

	test("budget before dispatch creates no new stage when no turn is live", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-before-dispatch",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				vi.advanceTimersByTime(20);
				return { result: await ctx.stage("must-not-exist").complete("must not run") };
			},
		});
		const store = createStore();
		const result = await run(definition, {}, { store, budget: { maxDurationMs: 10 } });
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.deepEqual(snapshot?.stages, []);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, undefined);
		assertBudgetBlockedSnapshot(snapshot);
	});

	test("budget caught stage error still stops on the system-owned blocked rail", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-caught-stage-error",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				try {
					await ctx.stage("caught-frontier").complete("progress");
				} catch {
					return { result: "swallowed" };
				}
				return { result: "completed" };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "caught-stage wrap-up" },
				},
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(effectiveRunStatus(snapshot!), "blocked");
		assert.equal(snapshot?.result?.status, "budget_exceeded");
	});

	test("budget live stage routes a boundary wrap-up and preserves its summary", async () => {
		const sleep = (milliseconds: number): Promise<void> =>
			new Promise((resolve) => setTimeout(resolve, milliseconds));
		const definition = workflow({
			name: "budget-live-stage-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const live = ctx.stage("live-frontier").complete("long substantive turn");
				live.catch(() => undefined);
				await sleep(160);
				await ctx.tool("burn", {}, async () => ({ ok: true }));
				return { result: await live };
			},
		});
		const prompts: string[] = [];
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 100 },
				adapters: {
					complete: {
						complete: async (text) => {
							await sleep(400);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "wrap-up from the live turn";
						},
					},
				},
			},
		);
		// The wrap-up settles asynchronously after the run resolves. Poll for the
		// observable end state instead of sleeping a fixed guess, so the test does
		// not depend on an idle machine.
		// Settling happens in two phases: the wrap-up completes, then the live
		// stage leaves "running". Wait for both.
		const WRAP_UP_SETTLE_DEADLINE_MS = 5_000;
		const settleDeadline = Date.now() + WRAP_UP_SETTLE_DEADLINE_MS;
		const settled = (candidate: RunSnapshot | undefined): boolean =>
			candidate?.budgetState?.wrapUpCompleted === true &&
			candidate.stages.find((stage) => stage.name === "live-frontier")?.status !== "running";
		let snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		while (!settled(snapshot) && Date.now() < settleDeadline) {
			await sleep(10);
			snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		}
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(budgetOutcome(result.result)?.wrapUpSummary, "wrap-up from the live turn");
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, true);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, true);
		assert.equal(prompts.length, 1);
		assert.equal(snapshot?.stages.find((stage) => stage.name === "live-frontier")?.status, "failed");
	});

	test("budget live child boundary preserves the frontier result on raised resume", async () => {
		const sleep = (milliseconds: number): Promise<void> =>
			new Promise((resolve) => setTimeout(resolve, milliseconds));
		const backend = new InMemoryDurableBackend();
		const child = workflow({
			name: "budget-live-child",
			description: "",
			inputs: {},
			outputs: { done: Type.String() },
			run: async (ctx) => ({ done: await ctx.stage("child-work").complete("child work") }),
		});
		let completeCalls = 0;
		const definition = workflow({
			name: "budget-live-child-boundary",
			description: "",
			inputs: {},
			outputs: { first: Type.String(), second: Type.String() },
			run: async (ctx) => {
				const live = ctx.stage("live-frontier").complete("do the real work");
				live.catch(() => undefined);
				await sleep(160);
				await ctx.workflow(child, { stageName: "child-boundary" });
				const first = await live;
				const second = await ctx.stage("downstream").complete(`downstream saw: ${first}`);
				return { first, second };
			},
		});
		const adapters = {
			complete: {
				complete: async (text: string) => {
					completeCalls += 1;
					await sleep(300);
					return `real-answer(${completeCalls}) for ${JSON.stringify(text)}`;
				},
			},
			prompt: { prompt: async () => "WRAP-UP BOILERPLATE" },
		};
		const firstStore = createStore();
		const first = await run(
			definition,
			{},
			{ store: firstStore, durableBackend: backend, budget: { maxDurationMs: 100 }, adapters },
		);
		let source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		const settleDeadline = Date.now() + 5_000;
		while (
			(source.budgetState?.wrapUpCompleted !== true ||
				source.stages.find((stage) => stage.name === "live-frontier")?.status === "running") &&
			Date.now() < settleDeadline
		) {
			await sleep(10);
			source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		}
		assert.equal(budgetOutcome(first.result)?.status, "budget_exceeded");
		assert.equal(
			source.stages.find((stage) => stage.name === "live-frontier")?.result,
			'real-answer(1) for "do the real work"',
		);
		const resumedStore = createStore();
		const resumed = await run(
			definition,
			{},
			{
				store: resumedStore,
				durableBackend: backend,
				budget: { maxDurationMs: 60_000 },
				continuation: {
					source,
					...(source.failedStageId !== undefined ? { resumeFromStageId: source.failedStageId } : {}),
				},
				adapters,
			},
		);
		assert.equal(resumed.status, "completed");
		assert.equal(String(resumed.result?.first).includes("WRAP-UP BOILERPLATE"), false);
		assert.equal(String(resumed.result?.second).includes("real-answer(1)"), true);
	});

	test("budget live stage before-dispatch boundary spends no discarded wrap-up", async () => {
		const sleep = (milliseconds: number): Promise<void> =>
			new Promise((resolve) => setTimeout(resolve, milliseconds));
		const definition = workflow({
			name: "budget-live-before-dispatch",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const live = ctx.stage("live-frontier").complete("long substantive turn");
				live.catch(() => undefined);
				await sleep(160);
				await ctx.stage("must-not-exist").complete("must not run");
				return { result: await live };
			},
		});
		const prompts: string[] = [];
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 100 },
				adapters: {
					complete: {
						complete: async (text) => {
							await sleep(400);
							return text;
						},
					},
					prompt: {
						prompt: async () => {
							prompts.push("wrap-up");
							return "wrap-up from before dispatch";
						},
					},
				},
			},
		);
		let snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		const settleDeadline = Date.now() + 5_000;
		while (
			snapshot?.stages.find((stage) => stage.name === "live-frontier")?.status === "running" &&
			Date.now() < settleDeadline
		) {
			await sleep(10);
			snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		}
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.frontierStage, "live-frontier");
		assert.equal(outcome?.wrapUpSummary, "wrap-up from before dispatch");
		assert.equal(prompts.length, 1);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, true);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, true);
		assert.equal(
			snapshot?.stages.some((stage) => stage.name === "must-not-exist"),
			false,
		);
	});

	test("budget resume carries elapsed time, repeats no wrap-up at the same ceiling, and continues when raised", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-resume",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("resume-frontier").complete("progress") }),
		});
		const firstStore = createStore();
		const prompts: string[] = [];
		const first = await run(
			definition,
			{},
			{
				runId: "budget-resume-source",
				store: firstStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "first wrap-up";
						},
					},
				},
			},
		);
		const source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.equal(budgetOutcome(first.result)?.status, "budget_exceeded");
		assert.equal(source.failedStageId !== undefined, true);

		const sourceElapsed = source.budgetState?.duration?.reading ?? 0;
		const sameStore = createStore();
		const same = await run(
			definition,
			{},
			{
				store: sameStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId! },
				adapters: {
					complete: { complete: async (text) => text },
					prompt: { prompt: async () => "must not wrap again" },
				},
			},
		);
		assert.equal(budgetOutcome(same.result)?.status, "budget_exceeded");
		assert.equal(prompts.length, 1);
		const sameSnapshot = sameStore.runs().find((candidate) => candidate.id === same.runId);
		assert.equal(sameSnapshot?.accumulatedDurationMs, sourceElapsed);
		assert.equal(budgetOutcome(same.result)?.frontierStage, "resume-frontier");
		const raisedStore = createStore();
		const raised = await run(
			definition,
			{},
			{
				store: raisedStore,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				continuation: { source, resumeFromStageId: source.failedStageId! },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(raised.status, "completed");
		const raisedSnapshot = raisedStore.runs().find((candidate) => candidate.id === raised.runId);
		assert.equal(raisedSnapshot?.accumulatedDurationMs, sourceElapsed);
		assert.ok((raisedSnapshot?.durationMs ?? 0) >= sourceElapsed);
	});

	test("budget wrap-up never replaces the frontier result during raised resume", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		let completeCalls = 0;
		const definition = workflow({
			name: "budget-frontier-result",
			description: "",
			inputs: {},
			outputs: { first: Type.String(), second: Type.String() },
			run: async (ctx) => {
				const first = await ctx.stage("frontier").complete("do the real work");
				const second = await ctx.stage("downstream").complete(`downstream saw: ${first}`);
				return { first, second };
			},
		});
		const sourceStore = createStore();
		const sourceResult = await run(
			definition,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							completeCalls += 1;
							vi.advanceTimersByTime(2);
							return completeCalls === 1 ? "frontier-product" : `downstream-product: ${text}`;
						},
					},
					prompt: { prompt: async () => "WRAP-UP BOILERPLATE" },
				},
			},
		);
		const source = sourceStore.runs().find((candidate) => candidate.id === sourceResult.runId)!;
		assert.equal(budgetOutcome(sourceResult.result)?.status, "budget_exceeded");
		assert.equal(source.stages.find((stage) => stage.name === "frontier")?.result, "frontier-product");
		assert.equal(source.stages.find((stage) => stage.name === "frontier")?.status, "completed");

		const resumedStore = createStore();
		const resumed = await run(
			definition,
			{},
			{
				store: resumedStore,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				continuation: { source, resumeFromStageId: source.failedStageId! },
				adapters: { complete: { complete: async (text) => `downstream-product: ${text}` } },
			},
		);
		assert.equal(resumed.status, "completed");
		assert.deepEqual(resumed.result, {
			first: "frontier-product",
			second: "downstream-product: downstream saw: frontier-product",
		});
	});

	test("budget successful body preserves outputs after non-stage work past the ceiling", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-success-after-body-work",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const result = await ctx.stage("only-stage").complete("real work product");
				vi.advanceTimersByTime(300);
				return { result };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 200 },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { result: "real work product" });
		assert.equal(store.runs()[0]?.budgetState?.systemOwnedStop, undefined);
	});

	test("budget resumed startup exhaustion lands on the blocked rail with no stage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-resumed-startup-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("resume-frontier").complete("progress") }),
		});
		const sourceStore = createStore();
		const first = await run(
			definition,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "startup-boundary wrap-up" },
				},
			},
		);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.ok(source.failedStageId);

		const resumedStore = createStore();
		const resumed = await run(
			definition,
			{},
			{
				store: resumedStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: {
					complete: { complete: async (text) => text },
					prompt: { prompt: async () => "must not wrap again" },
				},
			},
		);
		const snapshot = resumedStore.runs().find((candidate) => candidate.id === resumed.runId);
		assert.equal(budgetOutcome(resumed.result)?.status, "budget_exceeded");
		assert.deepEqual(snapshot?.stages, []);
		assertBudgetBlockedSnapshot(snapshot);
		assert.equal(snapshot.failedStageId, undefined);
	});

	test("budget exhausted generation can resume again from its boundary with a raised ceiling", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-resume-boundary-chain",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("frontier").complete("progress") }),
		});
		const firstStore = createStore();
		const first = await run(
			definition,
			{},
			{
				store: firstStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "first chain wrap-up" },
				},
			},
		);
		const source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.ok(source.failedStageId);

		const secondStore = createStore();
		const second = await run(
			definition,
			{},
			{
				store: secondStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		const secondSnapshot = secondStore.runs().find((candidate) => candidate.id === second.runId);
		assert.equal(budgetOutcome(second.result)?.status, "budget_exceeded");
		assertBudgetBlockedSnapshot(secondSnapshot);
		assert.deepEqual(secondSnapshot.stages, []);

		const raisedStore = createStore();
		// The boundary-only generation has no stage id; resume must still be legal.
		const raised = await run(
			definition,
			{},
			{
				store: raisedStore,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				continuation: { source: secondSnapshot, resumeFromStageId: secondSnapshot.failedStageId! },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(raised.status, "completed");
		assert.deepEqual(raised.result, { result: "progress" });
	});

	test("budget failedStageId is a real stage id or absent, never a display name", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-failed-stage-id-shape",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("named-frontier").complete("progress") }),
		});
		const firstStore = createStore();
		const first = await run(
			definition,
			{},
			{
				store: firstStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "id-shape wrap-up" },
				},
			},
		);
		const source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.ok(source.failedStageId);
		assert.ok(source.stages.some((stage) => stage.id === source.failedStageId));
		assert.notEqual(source.failedStageId, "named-frontier");

		const secondStore = createStore();
		const second = await run(
			definition,
			{},
			{
				store: secondStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		const resumed = secondStore.runs().find((candidate) => candidate.id === second.runId);
		assert.deepEqual(resumed?.stages, []);
		assert.equal(resumed?.failedStageId, undefined);
	});
	test("budget_exceeded returned by stage output cannot forge a system exhaustion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-forged-status",
			description: "",
			inputs: {},
			outputs: { status: Type.String() },
			run: async (ctx) => {
				await ctx.stage("forged-stage").complete("model output");
				return { status: "budget_exceeded" };
			},
		});
		const store = createStore();
		const result = await run(definition, {}, { store, adapters: { complete: { complete: async (text) => text } } });
		assert.equal(result.status, "completed");
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.budgetState, undefined);
		assert.equal(snapshot?.failureDisposition, undefined);
	});

	test("budget status output includes duration reading, ceiling, and percent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-status-surface",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("status-stage").complete("status") }),
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(5);
							return text;
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed");
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId)!;
		const summary = summarizeRunSnapshot(snapshot, 5);
		assert.equal(summary.budget?.maxDurationMs, 10);
		assert.equal(summary.budgetState?.duration?.reading, 5);
		assert.equal(summary.budgetState?.duration?.ceiling, 10);
		assert.equal(summary.budgetState?.duration?.percent, 50);
	});
	test("budget live status recomputes duration instead of freezing the last checkpoint", () => {
		const snapshot = budgetRun({
			budget: { maxDurationMs: 100_000, warnAtPercent: 80 },
			budgetState: { duration: { dimension: "duration", reading: 0, ceiling: 100_000, percent: 0 } },
		});
		const summary = summarizeRunSnapshot(snapshot, 301);
		assert.equal(summary.budgetState?.duration?.reading, 301);
		assert.equal(summary.budgetState?.duration?.percent, 0.301);
	});
});
test("budget_exceeded is a resumable returned blocked status", () => {
	assert.equal(isReturnedBlockedWorkflowStatus("budget_exceeded"), true);
	assert.equal(isReturnedResumableBlockedWorkflowStatus("budget_exceeded"), true);

	assert.equal(effectiveBudgetRejectsUnresolvedDeclarations, true);
});
