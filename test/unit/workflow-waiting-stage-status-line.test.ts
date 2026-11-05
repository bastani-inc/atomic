import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { stageStatusWithWait, stageWaitLabel } from "../../packages/workflows/src/shared/stage-display-status.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { stageSessionUnavailableDecision } from "../../packages/workflows/src/shared/workflow-failures-decisions.js";

const NOW = Date.now();

function waitingStage(name: string, wait: StageWaitSnapshot | undefined): StageSnapshot {
	return {
		id: `id-${name}`,
		name,
		status: "waiting",
		parentIds: [],
		toolEvents: [],
		startedAt: NOW - 10_000,
		...(wait === undefined ? {} : { wait }),
	};
}

function runSnapshot(stages: StageSnapshot[], patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "run-1",
		name: "status-line",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages,
		startedAt: NOW - 20_000,
		...patch,
	};
}

function summaryLine(snapshot: RunSnapshot): string {
	const text = renderWorkflowToolContent(
		{ action: "status", filter: "all", runs: [summarizeRunSnapshot(snapshot, NOW)], snapshots: [snapshot] },
		{ action: "status" },
	);
	const line = text.split("\n").find((candidate) => candidate.startsWith("[1]"));
	assert.ok(line !== undefined, text);
	return line;
}

describe("what a status line says about a run's waiting stages (#4309)", () => {
	test("each waiting stage is named with what it waits on, and a run of ten or fewer lists them with no overflow marker (#4309)", () => {
		const line = summaryLine(
			runSnapshot([
				waitingStage("build", {
					kind: "tool",
					since: NOW,
					toolCalls: [{ toolCallId: "c1", toolName: "wait_for_ci" }],
				}),
				waitingStage("idle-one", { kind: "idle", since: NOW }),
				waitingStage("held", { kind: "release", since: NOW }),
				waitingStage("no-wait", undefined),
			]),
		);
		assert.ok(
			line.endsWith("waiting (4): build (tool: wait_for_ci), idle-one (idle), held (released), no-wait"),
			line,
		);
	});

	test("the waiting stages come after the stage that awaits input and before the run's tools, joined by a middle dot (#4309)", () => {
		const line = summaryLine(
			runSnapshot(
				[
					waitingStage("held", { kind: "release", since: NOW }),
					{ id: "id-ask", name: "ask", status: "awaiting_input", parentIds: [], toolEvents: [], startedAt: NOW },
				],
				{
					toolNodes: [
						{
							kind: "tool",
							id: "tool-1",
							name: "lint",
							argsHash: "hash",
							ordinal: 0,
							status: "running",
							parentIds: [],
							startedAt: NOW,
							attachable: false,
						},
					],
				},
			),
		);
		const parts = line.split("  ").at(-1)?.split(" · ");
		assert.equal(parts?.[0]?.startsWith("awaiting input (1)"), true, line);
		assert.equal(parts?.[1], "waiting (1): held (released)");
		assert.equal(parts?.[2], "tools: lint (running)");
		assert.equal(parts?.length, 3);
	});

	test("a run with nothing to hint at shows its error, else its exit reason, else nothing (#4309)", () => {
		const failed = summaryLine(runSnapshot([], { status: "failed", error: "the   run\nfailed", endedAt: NOW }));
		assert.ok(failed.endsWith("the run failed"), failed);
		const quit = summaryLine(runSnapshot([], { status: "killed", exitReason: "quit", endedAt: NOW }));
		assert.ok(quit.endsWith("quit"), quit);
		const bare = summaryLine(runSnapshot([]));
		assert.equal(bare.includes(" · "), false);
		assert.equal(bare.endsWith("running  0ms") || /running {2}\S+$/.test(bare), true, bare);
	});

	test("a stage listing shows a released stage with what it waits on, and a stage summary carries a copy of its wait (#4309)", () => {
		const wait: StageWaitSnapshot = {
			kind: "tool",
			since: NOW,
			toolCalls: [
				{ toolCallId: "c1", toolName: "wait_for_ci" },
				{ toolCallId: "c2", toolName: "wait_for_ci" },
				{ toolCallId: "c3", toolName: "deploy" },
			],
		};
		const stage = waitingStage("build", wait);
		const text = renderWorkflowToolContent(
			{
				action: "stages",
				runId: "run-1",
				filter: "all",
				stages: [summarizeStage(stage), summarizeStage(waitingStage("plain", undefined))],
			},
			{ action: "stages" },
		);
		assert.ok(text.includes("[1] build (id-build) waiting (tool: wait_for_ci, deploy)"), text);
		assert.ok(text.includes("[2] plain (id-plain) waiting\n") || text.endsWith("[2] plain (id-plain) waiting"), text);

		const summary = summarizeStage(stage);
		assert.deepEqual(summary.wait, wait);
		assert.notEqual(summary.wait, wait);
		assert.equal(Object.hasOwn(summarizeStage(waitingStage("plain", undefined)), "wait"), false);
	});
});

describe("what a stage waits on, as status text (#4309)", () => {
	test("a tool wait names its distinct tools in call order, and every other wait has one fixed label (#4309)", () => {
		assert.equal(stageWaitLabel({ kind: "tool", since: 1 }), "tool");
		assert.equal(stageWaitLabel({ kind: "tool", since: 1, toolCalls: [] }), "tool");
		assert.equal(
			stageWaitLabel({
				kind: "tool",
				since: 1,
				toolCalls: [
					{ toolCallId: "a", toolName: "b_tool" },
					{ toolCallId: "b", toolName: "a_tool" },
					{ toolCallId: "c", toolName: "b_tool" },
				],
			}),
			"tool: b_tool, a_tool",
		);
		assert.equal(stageWaitLabel({ kind: "idle", since: 1 }), "idle");
		assert.equal(stageWaitLabel({ kind: "release", since: 1 }), "released");
		assert.equal(stageWaitLabel({ kind: "prompt", since: 1 }), "released");
		assert.equal(stageStatusWithWait("waiting", undefined), "waiting");
		assert.equal(stageStatusWithWait("awaiting_input", { kind: "prompt", since: 1 }), "awaiting_input (released)");
	});
});

describe("a stage whose session store stayed unreachable (#4309)", () => {
	test("blocks the run resumably, as a provider outage does, rather than failing it (#4309)", () => {
		assert.deepEqual(stageSessionUnavailableDecision(), {
			kind: "unknown",
			code: "unknown",
			retryable: true,
			resumable: true,
			recoverability: "recoverable",
			disposition: "active_blocked",
		});
	});
});
