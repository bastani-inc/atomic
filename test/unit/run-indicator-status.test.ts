import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	hasPendingInput,
	resolveRunIndicatorStatuses,
	runIndicatorStatus,
	visibleRunTreeMembers,
} from "../../packages/workflows/src/shared/run-indicator-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

function makeRun(id: string, status: RunSnapshot["status"], stages: StageSnapshot[] = []): RunSnapshot {
	return {
		id,
		name: id,
		inputs: {},
		status,
		stages,
		startedAt: 1,
	};
}

function awaitingStage(id = "ask"): StageSnapshot {
	return {
		id,
		name: id,
		status: "awaiting_input",
		parentIds: [],
		toolEvents: [],
		pendingPrompt: {
			id: `${id}-prompt`,
			kind: "confirm",
			message: "Continue?",
			createdAt: 1,
		},
	};
}

function workflowBoundary(id: string, childRunId: string): StageSnapshot {
	return {
		id,
		name: id,
		status: "running",
		parentIds: [],
		toolEvents: [],
		workflowChildRun: { alias: childRunId, workflow: childRunId, runId: childRunId },
	};
}

const DUPLICATE_CYCLE_PROBE_TIMEOUT_MS = 5_000;

function childRun(
	id: string,
	parentRunId: string,
	parentStageId: string,
	rootRunId: string,
	stages: StageSnapshot[] = [],
): RunSnapshot {
	return {
		...makeRun(id, "running", stages),
		parentRunId,
		parentStageId,
		rootRunId,
	};
}

describe("runIndicatorStatus", () => {
	test("returns awaiting_input for a live run-level or stage prompt", () => {
		const runPrompt = makeRun("run-prompt", "running");
		runPrompt.pendingPrompt = { id: "run-prompt-id", kind: "confirm", message: "Continue?", createdAt: 1 };
		assert.equal(runIndicatorStatus(runPrompt), "awaiting_input");
		assert.equal(runIndicatorStatus(makeRun("stage-prompt", "running", [awaitingStage()])), "awaiting_input");
	});

	test("attributes a live nested prompt only through reciprocal workflow boundaries", () => {
		const child = {
			...makeRun("child", "running", [awaitingStage()]),
			parentRunId: "parent",
			parentStageId: "to-child",
			rootRunId: "root",
		};
		const parent = {
			...makeRun("parent", "running", [workflowBoundary("to-child", child.id)]),
			parentRunId: "root",
			parentStageId: "to-parent",
			rootRunId: "root",
		};
		const root = makeRun("root", "running", [workflowBoundary("to-parent", parent.id)]);
		const unrelated = makeRun("unrelated", "running");
		const allRuns = [root, parent, child, unrelated];

		assert.equal(runIndicatorStatus(root, allRuns), "awaiting_input");
		assert.equal(runIndicatorStatus(unrelated, allRuns), "running");
		assert.equal(runIndicatorStatus(makeRun("clean", "running"), allRuns), "running");
	});

	test("rejects a one-sided nested claimant whose parent boundary does not own it", () => {
		const root = makeRun("root", "running");
		const claimant = {
			...makeRun("claimant", "running", [awaitingStage()]),
			rootRunId: root.id,
			parentRunId: root.id,
			parentStageId: "missing-boundary",
		};

		assert.equal(runIndicatorStatus(root, [root, claimant]), "running");
	});

	test("rejects an active grandchild prompt behind a terminal or blocked intermediate run", () => {
		for (const status of ["completed", "blocked"] as const) {
			const child = {
				...makeRun(`${status}-child`, "running", [awaitingStage()]),
				parentRunId: `${status}-parent`,
				parentStageId: "to-child",
				rootRunId: `${status}-root`,
			};
			const parent = {
				...makeRun(`${status}-parent`, status, [workflowBoundary("to-child", child.id)]),
				parentRunId: `${status}-root`,
				parentStageId: "to-parent",
				rootRunId: `${status}-root`,
			};
			const root = makeRun(`${status}-root`, "running", [workflowBoundary("to-parent", parent.id)]);

			assert.equal(runIndicatorStatus(root, [root, parent, child]), "running", status);
		}
	});

	test("rejects a stale prompt behind a completed intermediate workflow boundary", () => {
		const child = childRun("stale-child", "parent", "to-child", "root", [awaitingStage("stale-ask")]);
		const parent = {
			...childRun("parent", "root", "to-parent", "root"),
			stages: [
				{
					...workflowBoundary("to-child", child.id),
					status: "completed" as const,
					workflowChildRun: undefined,
					workflowChild: {
						alias: "child",
						workflow: child.name,
						runId: child.id,
						status: "completed" as const,
						outputs: {},
					},
				},
			],
		};
		const root = makeRun("root", "running", [workflowBoundary("to-parent", parent.id)]);
		const runs = [root, parent, child];

		assert.deepEqual(visibleRunTreeMembers(root, runs), [root, parent]);
		assert.equal(runIndicatorStatus(root, runs), "running");
	});

	test("fails closed without changing public-store duplicate run snapshots", () => {
		const store = createStore();
		const root = makeRun("duplicate-root", "running", [workflowBoundary("to-child", "duplicate-child")]);
		const divergent = {
			...childRun("duplicate-child", root.id, "missing-boundary", root.id, [awaitingStage("divergent-ask")]),
			name: "divergent-duplicate",
		};
		const canonical = {
			...childRun("duplicate-child", root.id, "to-child", root.id),
			name: "canonical-duplicate",
		};

		store.recordRunStart(root);
		store.recordRunStart(divergent);
		store.recordRunStart(canonical);
		const acceptedRuns = store.runs();
		assert.deepEqual(
			acceptedRuns.map((run) => [run.id, run.name]),
			[
				[root.id, root.name],
				[divergent.id, divergent.name],
				[canonical.id, canonical.name],
			],
			"the public store accepts and preserves duplicate ids in insertion order",
		);

		assert.deepEqual(visibleRunTreeMembers(root, acceptedRuns), [root]);
		assert.equal(runIndicatorStatus(root, acceptedRuns), "running");
		assert.deepEqual(
			store.runs().map((run) => [run.id, run.name]),
			acceptedRuns.map((run) => [run.id, run.name]),
			"projection must not normalize, reorder, or mutate the store collection",
		);
	});

	test("terminates within a bound for a divergent duplicate whose ancestry cycles", () => {
		const moduleUrl = new URL("../../packages/workflows/src/shared/run-indicator-status.ts", import.meta.url).href;
		const probe = `
			const { visibleRunTreeMembers } = await import(${JSON.stringify(moduleUrl)});
			const stage = (id, child) => ({
				id, name: id, status: "running", parentIds: [], toolEvents: [],
				workflowChildRun: child ? { alias: child, workflow: child, runId: child } : undefined,
			});
			const run = (id, stages = []) => ({ id, name: id, inputs: {}, status: "running", stages, startedAt: 1 });
			const root = run("root", [stage("to-child", "child")]);
			const divergent = { ...run("child"), parentRunId: "cycle-a", parentStageId: "from-a", rootRunId: "root" };
			const cycleA = { ...run("cycle-a"), parentRunId: "cycle-b", parentStageId: "from-b", rootRunId: "root" };
			const cycleB = { ...run("cycle-b"), parentRunId: "cycle-a", parentStageId: "from-a", rootRunId: "root" };
			const canonical = { ...run("child"), parentRunId: "root", parentStageId: "to-child", rootRunId: "root" };
			console.log(JSON.stringify(visibleRunTreeMembers(root, [root, divergent, cycleA, cycleB, canonical]).map((item) => item.id)));
		`;

		const result = spawnSyncCollect([bunExecutable(), "-e", probe], {
			timeout: DUPLICATE_CYCLE_PROBE_TIMEOUT_MS,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString().trim(), '["root"]');
	});

	test("ignores stale pending-input residue on every terminal stage status", () => {
		for (const status of ["completed", "failed", "skipped"] as const) {
			const marker: StageSnapshot = {
				...awaitingStage(`${status}-marker`),
				status,
				awaitingInputSince: 2,
				pendingPrompt: undefined,
			};
			const prompt = { ...awaitingStage(`${status}-prompt`), status };
			const request = {
				...awaitingStage(`${status}-request`),
				status,
				pendingPrompt: undefined,
				inputRequest: {
					id: `${status}-input-request`,
					kind: "ask_user_question" as const,
					questions: [{ question: "Stale question", options: [] }],
					createdAt: 1,
				},
			};

			assert.equal(
				runIndicatorStatus(makeRun(`${status}-residue`, "running", [marker, prompt, request])),
				"running",
			);
		}
	});

	test("keeps a live prompt awaiting when terminal stage residue is present", () => {
		const stale = { ...awaitingStage("completed-stale"), status: "completed" as const, awaitingInputSince: 2 };
		const live = awaitingStage("live");
		assert.equal(runIndicatorStatus(makeRun("live-with-residue", "running", [stale, live])), "awaiting_input");
	});

	test("reverts immediately when a prompt is answered or cancelled", () => {
		const answered = makeRun("answered", "running", [awaitingStage()]);
		assert.equal(runIndicatorStatus(answered), "awaiting_input");
		answered.stages[0]!.status = "running";
		answered.stages[0]!.pendingPrompt = undefined;
		assert.equal(runIndicatorStatus(answered), "running");

		const cancelled = makeRun("cancelled", "running");
		cancelled.pendingPrompt = { id: "cancel-prompt", kind: "input", message: "Continue?", createdAt: 1 };
		assert.equal(runIndicatorStatus(cancelled), "awaiting_input");
		cancelled.pendingPrompt = undefined;
		assert.equal(runIndicatorStatus(cancelled), "running");
	});

	test("terminal and blocked statuses beat stale pending prompts", () => {
		for (const status of ["completed", "failed", "killed", "cancelled", "skipped", "blocked"] as const) {
			const run = makeRun(status, status, [awaitingStage()]);
			run.pendingPrompt = { id: `${status}-prompt`, kind: "confirm", message: "Continue?", createdAt: 1 };
			assert.equal(runIndicatorStatus(run), status);
		}
	});
});

describe("hasPendingInput", () => {
	test("ignores terminal-stage residue when ignoreTerminalStages is true and counts it when false", () => {
		for (const status of ["completed", "failed", "skipped"] as const) {
			const residue: StageSnapshot = {
				...awaitingStage(`${status}-residue`),
				status,
			};
			const run = makeRun(`${status}-residue-run`, "running", [residue]);
			assert.equal(hasPendingInput(run, { ignoreTerminalStages: true }), false);
			assert.equal(hasPendingInput(run, { ignoreTerminalStages: false }), true);
		}
	});

	test("counts a run-level prompt under both ignoreTerminalStages settings", () => {
		const run = makeRun("run-prompt", "running");
		run.pendingPrompt = { id: "run-prompt-id", kind: "confirm", message: "Continue?", createdAt: 1 };
		assert.equal(hasPendingInput(run, { ignoreTerminalStages: true }), true);
		assert.equal(hasPendingInput(run, { ignoreTerminalStages: false }), true);
	});
});

describe("resolveRunIndicatorStatuses", () => {
	test("resolves each listed run against a reciprocal child boundary into serializable data", () => {
		const child = {
			...makeRun("child", "running", [awaitingStage()]),
			parentRunId: "root",
			parentStageId: "to-child",
		};
		const root = makeRun("root", "running", [workflowBoundary("to-child", child.id)]);
		const unrelated = makeRun("unrelated", "running");
		const statuses = resolveRunIndicatorStatuses([root, unrelated], [root, child, unrelated]);
		assert.deepEqual(statuses, { root: "awaiting_input", unrelated: "running" });
		// The record must survive a JSON round-trip: it is persisted with the
		// /workflow status chat payload and consumed after a session restore.
		assert.deepEqual(JSON.parse(JSON.stringify(statuses)), statuses);
	});

	test("keeps terminal precedence and covers only the listed runs", () => {
		const done = makeRun("done", "completed", [awaitingStage()]);
		const hidden = makeRun("hidden", "running", [awaitingStage()]);
		const statuses = resolveRunIndicatorStatuses([done], [done, hidden]);
		assert.deepEqual(statuses, { done: "completed" });
	});
});
