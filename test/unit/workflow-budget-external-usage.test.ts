import assert from "node:assert/strict";
import { test } from "vitest";
import { createRunBudgetController } from "../../packages/workflows/src/engine/run-budget.js";
import { resolve_budget } from "../../packages/workflows/src/shared/budget.js";
import { restoreBudgetState } from "../../packages/workflows/src/shared/persistence-restore-helpers.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowModelUsage } from "../../packages/workflows/src/shared/types.js";
import { collectWorkerUsage } from "../../packages/workflows/src/workers/usage-accounting.js";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const usage = (input: number, output = 0, cost = 0) => ({ ...zero, input, output, cost });

function budgetRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "root",
		name: "root",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: Date.now(),
		...overrides,
	};
}
function stage(name: string, modelUsage: WorkflowModelUsage, replayed = false): RunSnapshot["stages"][number] {
	return {
		id: name,
		name,
		status: "completed",
		parentIds: [],
		toolEvents: [],
		...(replayed ? { replayed } : {}),
		modelAttempts: [{ model: "m", success: true, usage: modelUsage }],
	};
}

test("worker usage reports count each run once and skip replayed stages (#3869)", () => {
	const child = budgetRun({
		id: "child",
		stages: [stage("a", { input: 10, output: 5, cost: 0.5 }), stage("cached", { input: 999 }, true)],
	});
	const nested = budgetRun({ id: "nested", stages: [stage("b", { input: 3, cacheRead: 2 })] });
	assert.deepEqual(collectWorkerUsage([child, nested]), [
		{ key: "child", usage: usage(10, 5, 0.5) },
		{ key: "nested", usage: { ...usage(3), cacheRead: 2 } },
	]);
});

test("external worker usage counts toward the root token ceiling once per reported amount (#3869)", () => {
	const run = budgetRun();
	let external = usage(0);
	const controller = createRunBudgetController({
		run,
		budget: resolve_budget({ run: { maxTokens: 100 } }),
		externalUsage: () => external,
	});
	external = usage(60, 10);
	assert.equal(controller.checkpoint().kind, "continue");
	assert.equal(run.budgetState?.accounting?.tokens, 70);
	external = usage(60, 10);
	controller.checkpoint();
	assert.equal(run.budgetState?.accounting?.tokens, 70);
	external = usage(75, 10);
	assert.equal(controller.checkpoint().kind, "warn");
	external = usage(95, 10);
	assert.equal(controller.checkpoint().kind, "wrap_up");
	assert.equal(run.budgetState?.accounting?.tokens, 105);
});

test("a recovered root charges only unaccounted worker usage and never resets spending (#3869)", () => {
	const first = budgetRun();
	let external = usage(40, 10, 0.4);
	const budget = resolve_budget({ run: { maxTokens: 500, maxCost: 5 } });
	const original = createRunBudgetController({ run: first, budget, externalUsage: () => external });
	original.checkpoint();
	assert.equal(first.budgetState?.accounting?.tokens, 50);
	const recovered = budgetRun({ budgetState: structuredClone(first.budgetState) });
	external = usage(70, 10, 0.7);
	const controller = createRunBudgetController({ run: recovered, budget, externalUsage: () => external });
	controller.checkpoint();
	assert.equal(recovered.budgetState?.accounting?.tokens, 80);
	assert.equal(recovered.budgetState?.accounting?.cost, 0.7);
	controller.checkpoint();
	assert.equal(recovered.budgetState?.accounting?.tokens, 80);
});

test("worker usage that loads after a recovered controller starts is not double charged (#3869)", () => {
	const first = budgetRun();
	const external = usage(40);
	const budget = resolve_budget({ run: { maxTokens: 500 } });
	createRunBudgetController({ run: first, budget, externalUsage: () => external }).checkpoint();
	const recovered = budgetRun({ budgetState: structuredClone(first.budgetState) });
	let loaded = usage(0);
	const controller = createRunBudgetController({ run: recovered, budget, externalUsage: () => loaded });
	controller.checkpoint();
	assert.equal(recovered.budgetState?.accounting?.tokens, 40);
	loaded = external;
	controller.checkpoint();
	assert.equal(recovered.budgetState?.accounting?.tokens, 40);
});

test("persisted accounting round-trips the charged worker baseline and drops a malformed one (#3869)", () => {
	const run = budgetRun();
	const budget = resolve_budget({ run: { maxTokens: 500 } });
	createRunBudgetController({ run, budget, externalUsage: () => usage(40, 2, 0.1) }).checkpoint();
	const restored = restoreBudgetState(JSON.parse(JSON.stringify(run.budgetState)));
	assert.deepEqual(restored?.accounting?.externalBaseline, usage(40, 2, 0.1));
	const malformed = restoreBudgetState({
		accounting: { ...run.budgetState?.accounting, externalBaseline: { input: "many" } },
	});
	assert.equal(malformed?.accounting?.externalBaseline, undefined);
	assert.equal(malformed?.accounting?.tokens, 42);
});
