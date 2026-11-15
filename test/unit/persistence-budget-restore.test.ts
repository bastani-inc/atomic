import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { isWorkflowRunResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

afterEach(() => vi.useRealTimers());

test("budget boundary-only exhaustion survives durable session restore without a failed stage id", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const entries: Array<{ readonly id: string; readonly type: string; readonly payload: Record<string, unknown> }> = [];
	const persistence = {
		appendEntry(type: string, payload: Record<string, unknown>): string {
			const id = `budget-entry-${entries.length + 1}`;
			entries.push({ id, type, payload });
			return id;
		},
	};
	const definition = workflow({
		name: "budget-restore-boundary",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		budget: { maxDurationMs: 1 },
		run: async (ctx) => {
			vi.advanceTimersByTime(2);
			await ctx.stage("never-dispatched").complete("must not run");
			return { result: "completed" };
		},
	});
	const sourceStore = createStore();
	const source = await run(
		definition,
		{},
		{
			store: sourceStore,
			persistence,
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				complete: { complete: async (text) => text },
				prompt: { prompt: async () => "must not wrap without a live turn" },
			},
		},
	);
	const sourceSnapshot = sourceStore.runs().find((candidate) => candidate.id === source.runId);
	assert.equal((source.result as { readonly status?: string } | undefined)?.status, "budget_exceeded");
	assert.deepEqual(sourceSnapshot?.stages, []);
	assert.equal(sourceSnapshot?.failedStageId, undefined);
	const blockedEntry = entries.find((entry) => entry.type === "workflow.run.blocked");
	assert.notEqual(blockedEntry, undefined);
	assert.equal(blockedEntry?.payload.failedStageId, undefined);

	const restoredStore = createStore();
	restoreOnSessionStart(
		{ getEntries: () => entries as unknown as SessionEntry[] },
		{ resumeInFlight: "never", persistRuns: true },
		restoredStore,
	);
	const restored = restoredStore.runs().find((candidate) => candidate.id === source.runId);
	assert.notEqual(restored, undefined);
	assert.deepEqual(restored?.stages, []);
	assert.deepEqual(restored?.budget, { maxDurationMs: 1, warnAtPercent: 80 });
	assert.deepEqual(blockedEntry?.payload.budgetState, sourceSnapshot?.budgetState);
	assert.deepEqual(restored?.budgetState, sourceSnapshot?.budgetState);
	assert.deepEqual(restored?.result, source.result);
	assert.equal(restored?.endedAt, sourceSnapshot?.endedAt);
	assert.equal(effectiveRunStatus(restored as RunSnapshot), "blocked");
	assert.equal(
		isWorkflowRunResumable({
			...(restored as RunSnapshot),
			budgetSystemOwnedStop: true,
		}),
		true,
	);
});

test("token and cost baselines survive durable budget-stop restore", async () => {
	const entries: Array<{ readonly id: string; readonly type: string; readonly payload: Record<string, unknown> }> = [];
	const persistence = {
		appendEntry(type: string, payload: Record<string, unknown>): string {
			const id = `usage-budget-entry-${entries.length + 1}`;
			entries.push({ id, type, payload });
			return id;
		},
	};
	const messages: AgentSession["messages"] = [];
	let promptCount = 0;
	const agentSession: AgentSessionAdapter = {
		async create() {
			return makeMockSession({
				messages,
				async prompt() {
					messages.push(
						assistantMessageWithUsage(promptCount++ === 0 ? "progress" : "wrap summary", {
							input: 2,
							output: 3,
							cacheRead: 7,
							cacheWrite: 11,
							cost: 0.25,
						}),
					);
				},
			}).session;
		},
	};
	const definition = workflow({
		name: "usage-budget-restore",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		budget: { maxTokens: 1, maxCost: 1 },
		run: async (ctx) => ({
			result: await ctx.stage("usage-frontier", { model: "test/model" }).prompt("progress"),
		}),
	});
	const sourceStore = createStore();
	const source = await run(definition, {}, { store: sourceStore, persistence, adapters: { agentSession } });
	const sourceSnapshot = sourceStore.runs().find((candidate) => candidate.id === source.runId);
	const blockedEntry = entries.find((entry) => entry.type === "workflow.run.blocked");
	assert.equal((source.result as { readonly status?: string } | undefined)?.status, "budget_exceeded");
	assert.equal(sourceSnapshot?.budgetState?.accounting?.tokens, 5);
	assert.equal(sourceSnapshot?.budgetState?.accounting?.cost, 0.25);
	assert.deepEqual(blockedEntry?.payload.budgetState, sourceSnapshot?.budgetState);

	const restoredStore = createStore();
	restoreOnSessionStart(
		{ getEntries: () => entries as unknown as SessionEntry[] },
		{ resumeInFlight: "never", persistRuns: true },
		restoredStore,
	);
	const restored = restoredStore.runs().find((candidate) => candidate.id === source.runId);
	assert.equal(restored?.budget?.maxTokens, 1);
	assert.equal(restored?.budget?.maxCost, 1);
	assert.equal(restored?.budgetState?.accounting?.tokens, 5);
	assert.equal(restored?.budgetState?.accounting?.cost, 0.25);
});

test("budget restore rejects malformed accounting and model attempts", async () => {
	const entries: Array<{ readonly id: string; readonly type: string; readonly payload: Record<string, unknown> }> = [];
	const persistence = {
		appendEntry(type: string, payload: Record<string, unknown>): string {
			const id = `corrupt-budget-entry-${entries.length + 1}`;
			entries.push({ id, type, payload });
			return id;
		},
	};
	const messages: AgentSession["messages"] = [];
	const agentSession: AgentSessionAdapter = {
		async create() {
			return makeMockSession({
				messages,
				async prompt() {
					messages.push(
						assistantMessageWithUsage("usage", {
							input: 2,
							output: 3,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.25,
						}),
					);
				},
			}).session;
		},
	};
	const definition = workflow({
		name: "corrupt-budget-restore",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		budget: { maxTokens: 1 },
		run: async (ctx) => ({ result: await ctx.stage("usage", { model: "test/model" }).prompt("work") }),
	});
	const sourceStore = createStore();
	const source = await run(definition, {}, { store: sourceStore, persistence, adapters: { agentSession } });
	const blocked = entries.find((entry) => entry.type === "workflow.run.blocked");
	const stageEnd = entries.find((entry) => entry.type === "workflow.stage.end");
	assert.ok(blocked, JSON.stringify({ result: source, entries }, null, 2));
	assert.ok(stageEnd);
	blocked.payload.budgetState = {
		...(blocked.payload.budgetState as Record<string, unknown>),
		accounting: {
			baseline: { input: "x", output: null, cacheRead: 0, cacheWrite: 0, cost: 0 },
			tokens: "50",
			cost: "oops",
			perCounter: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
		},
	};
	stageEnd.payload.modelAttempts = [{ model: "corrupt", success: true, usage: { input: "bad", output: 3 } }];

	const restoredStore = createStore();
	restoreOnSessionStart(
		{ getEntries: () => entries as unknown as SessionEntry[] },
		{ resumeInFlight: "never", persistRuns: true },
		restoredStore,
	);
	const restored = restoredStore.runs().find((candidate) => candidate.id === source.runId);
	assert.deepEqual(
		{
			accountingRejected: restored?.budgetState?.accounting === undefined,
			modelAttemptsRejected: restored?.stages[0]?.modelAttempts === undefined,
		},
		{ accountingRejected: true, modelAttemptsRejected: true },
	);
});

test("budget resume eligibility admits ended system stops but rejects ended non-budget stops", () => {
	const endedBudgetStop = {
		status: "running" as const,
		endedAt: 10,
		resumable: true,
		failureRecoverability: "recoverable" as const,
		budgetSystemOwnedStop: true,
	};
	assert.equal(isWorkflowRunResumable(endedBudgetStop), true);
	assert.equal(isWorkflowRunResumable({ ...endedBudgetStop, budgetSystemOwnedStop: false }), false);
});
