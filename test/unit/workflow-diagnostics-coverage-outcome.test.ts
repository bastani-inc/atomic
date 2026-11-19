import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	buildRunOutcome,
	renderRunOutcomeLines,
	runOutcomeLogLines,
	summarizeFailureText,
	withoutStackFrames,
} from "../../packages/workflows/src/tui/run-outcome.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
import { defaultTheme, makeStage } from "./overlay-graph-helpers.js";

function stage(
	id: string,
	status: StageSnapshot["status"],
	extra: Partial<StageSnapshot> = {},
	parents: string[] = [],
): StageSnapshot {
	return { ...makeStage(id, parents), status, ...extra };
}

function makeTool(
	id: string,
	name: string,
	status: ToolNodeSnapshot["status"],
	extra: Partial<ToolNodeSnapshot> = {},
): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name,
		args: {},
		argsHash: id,
		ordinal: 1,
		parentIds: [],
		status,
		attachable: false,
		...extra,
	};
}

function makeRun(
	status: RunSnapshot["status"],
	stages: StageSnapshot[] = [],
	extra: Partial<RunSnapshot> = {},
): RunSnapshot {
	return {
		id: "run-1",
		name: "ralph",
		inputs: {},
		status,
		stages,
		toolNodes: [],
		startedAt: 1_000,
		...extra,
	};
}

function plainText(lines: readonly string[]): string {
	return lines.map((line) => stripAnsi(line)).join("\n");
}

describe("workflow run outcome model, sections, and failure summaries (#5224)", () => {
	it("skips leading stack frames in failure summaries and preserves a bare Error: line (#5224)", () => {
		assert.deepEqual(summarizeFailureText("   at foo (/x.ts:1:1)\nreal reason"), {
			reason: "real reason",
			frames: 1,
		});
		assert.deepEqual(summarizeFailureText("Uncaught Error:   spaced reason  "), {
			reason: "spaced reason",
			frames: 0,
		});
		assert.deepEqual(summarizeFailureText("Error:"), {
			reason: "Error:",
			frames: 0,
		});
		assert.deepEqual(withoutStackFrames("first line\n    at step (/repo/wf.ts:10:2)\nsecond line"), {
			kept: ["first line", "second line"],
			frames: 1,
		});
	});

	it("includes distinct failed and blocked stage and tool sections in the run log and omits stages that only repeat the run message (#5224)", () => {
		const diffStageRun = makeRun(
			"failed",
			[
				stage("prepare", "completed"),
				stage("verify", "failed", { error: "stage said no" }),
				stage("gate", "blocked", { failureMessage: "waiting on quota" }),
			],
			{
				error: "the run failed",
				toolNodes: [
					makeTool("tool:ok", "ok-tool", "completed"),
					makeTool("tool:dup", "dup-tool", "failed", { error: "the run failed" }),
					makeTool("tool:bad", "bad-tool", "failed", { error: "tool line 1\ntool line 2" }),
				],
			},
		);
		const log = runOutcomeLogLines(diffStageRun);
		assert.deepEqual(log, [
			"the run failed",
			"",
			"verify:",
			"  stage said no",
			"",
			"gate:",
			"  waiting on quota",
			"",
			"bad-tool:",
			"  tool line 1",
			"  tool line 2",
		]);

		const structuredRepeatRun = makeRun(
			"failed",
			[
				stage("verify", "failed", {
					error: "same error",
					failureDetail: {
						name: "TypeError",
						code: "E_SCHEMA",
						message: "invalid schema",
						fields: {},
					},
				}),
			],
			{ error: "same error" },
		);
		const structuredLog = runOutcomeLogLines(structuredRepeatRun).join("\n");
		assert.match(structuredLog, /verify:/);
		assert.match(structuredLog, /E_SCHEMA/);

		const emptyLogRun = makeRun("completed", [stage("prepare", "completed")]);
		assert.deepEqual(runOutcomeLogLines(emptyLogRun), ["No log was recorded for this run."]);
	});

	it("draws the selection marker and action line only under the selected blocker (#5224)", () => {
		const outcome = buildRunOutcome(
			makeRun(
				"failed",
				[
					stage("a", "failed", { error: "ea" }),
					stage("b", "failed", { error: "eb" }),
					stage("c", "failed", { error: "ec" }),
				],
				{ error: "run failed" },
			),
			5_000,
		);
		const rendered = plainText(
			renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: false, selected: 1 }),
		);
		assert.equal(rendered.match(/enter retry, fork, transcript or logs/g)?.length, 1);
		assert.equal(rendered.match(/❯/g)?.length, 1);
		assert.match(rendered, /❯ ✗ b\s+eb\n\s+enter retry, fork, transcript or logs/);
	});

	it("shows empty-outputs notice only for completed runs and omits empty Blockers, Artifacts, Events, Reason, and Exit sections (#5224)", () => {
		const completedEmpty = buildRunOutcome(
			makeRun("completed", [], { startedAt: 1_000, endedAt: 3_000, result: {} }),
			3_000,
		);
		const completedText = plainText(
			renderRunOutcomeLines(completedEmpty, { theme: defaultTheme, width: 100, logs: false, selected: 0 }),
		);
		assert.match(completedText, /Outputs/);
		assert.match(completedText, /This workflow declared no outputs\./);
		assert.doesNotMatch(completedText, /Blockers/);
		assert.doesNotMatch(completedText, /Artifacts/);
		assert.doesNotMatch(completedText, /Reason/);
		assert.doesNotMatch(completedText, /Exit/);

		const runningWithExit = buildRunOutcome(
			makeRun("running", [], {
				startedAt: undefined,
				exitReason: "budget limit reached",
				error: "ignored while running",
			}),
			3_000,
		);
		assert.equal(runningWithExit.reason, undefined);
		assert.equal(runningWithExit.exitReason, "budget limit reached");
		assert.deepEqual(runningWithExit.events, []);
		const runningText = plainText(
			renderRunOutcomeLines(runningWithExit, { theme: defaultTheme, width: 100, logs: false, selected: 0 }),
		);
		assert.match(runningText, /∀ ralph · running/);
		assert.match(runningText, /Exit\s+budget limit reached/);
		assert.doesNotMatch(runningText, /Reason/);
		assert.doesNotMatch(runningText, /Outputs/);
		assert.doesNotMatch(runningText, /This workflow declared no outputs\./);
		assert.doesNotMatch(runningText, /Blockers/);
		assert.doesNotMatch(runningText, /Artifacts/);
		assert.doesNotMatch(runningText, /Events/);
	});

	it("caps rendered events to the latest 12 entries and shows how many earlier events were omitted (#5224)", () => {
		const stages = Array.from({ length: 7 }, (_, index) =>
			stage(`s${index}`, "completed", {
				startedAt: 1_000 + index * 200,
				endedAt: 1_100 + index * 200,
			}),
		);
		const outcome = buildRunOutcome(makeRun("completed", stages, { startedAt: 500, endedAt: 3_000 }), 3_000);
		assert.equal(outcome.events.length, 16);
		const rendered = plainText(
			renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: false, selected: 0 }),
		);
		assert.match(rendered, /… 4 earlier/);
		assert.doesNotMatch(rendered, /ralph started/);
		assert.doesNotMatch(rendered, /s0 started/);
		assert.match(rendered, /s6 completed/);
		assert.match(rendered, /ralph completed/);
	});

	it("classifies skipped, cancelled, paused, waiting, and running states and suppresses blockers for completed or stopped runs (#5224)", () => {
		const skipped = buildRunOutcome(
			makeRun("skipped", [stage("s1", "failed", { error: "ignored" })], {
				endedAt: 2_000,
				error: "ignored",
				toolNodes: [makeTool("tool:1", "lint", "failed", { error: "ignored" })],
			}),
			2_000,
		);
		assert.equal(skipped.state, "completed");
		assert.equal(skipped.reason, undefined);
		assert.deepEqual(skipped.blockers, []);

		const cancelled = buildRunOutcome(
			makeRun("cancelled", [stage("s1", "failed", { error: "ignored" })], { endedAt: 2_000, error: "ignored" }),
			2_000,
		);
		assert.equal(cancelled.state, "stopped");
		assert.equal(cancelled.reason, undefined);
		assert.deepEqual(cancelled.blockers, []);

		const paused = buildRunOutcome(makeRun("paused", [], { pausedAt: 2_000 }), 3_000);
		assert.equal(paused.state, "paused");
		const pausedText = plainText(
			renderRunOutcomeLines(paused, { theme: defaultTheme, width: 80, logs: false, selected: 0 }),
		);
		assert.match(pausedText, /❚❚ ralph · paused at/);

		const waitingViaInputRequest = buildRunOutcome(
			makeRun("running", [
				stage("ask", "running", {
					inputRequest: {
						id: "req-1",
						kind: "ask_user_question",
						createdAt: 1_000,
						questions: [{ header: "Env", question: "Which target?\nsecond line", options: [] }],
					},
				}),
				stage("waitNoQuestion", "awaiting_input"),
			]),
			3_000,
		);
		assert.equal(waitingViaInputRequest.state, "waiting");
		assert.deepEqual(
			waitingViaInputRequest.blockers.map((blocker) => [blocker.name, blocker.reason]),
			[
				["ask", "Which target?"],
				["waitNoQuestion", "Waiting for your answer."],
			],
		);
		const waitingText = plainText(
			renderRunOutcomeLines(waitingViaInputRequest, { theme: defaultTheme, width: 80, logs: false, selected: 0 }),
		);
		assert.match(waitingText, /◆ ralph · needs input ·/);
	});

	it("formats artifact details for capture errors, singular and plural file counts, insertions/deletions, and diffStat fallbacks (#5224)", () => {
		const outcome = buildRunOutcome(
			makeRun("completed", [
				stage("collect", "completed", {
					artifacts: [
						{ kind: "diff", path: "/repo/a.patch", captureError: "Error: worktree missing" },
						{ kind: "diff", path: "/repo/b.patch", filesChanged: 1 },
						{ kind: "diff", path: "/repo/c.patch", filesChanged: 2, insertions: 5 },
						{ kind: "diff", path: "/repo/d.patch", deletions: 3 },
						{ kind: "diff", path: "/repo/e.patch", diffStat: "1 file changed, 2 insertions(+)\nextra" },
						{ kind: "output", path: "/repo/plain.txt" },
					],
				}),
			]),
			2_000,
		);
		assert.deepEqual(
			outcome.artifacts.map((artifact) => [artifact.path, artifact.detail]),
			[
				["/repo/a.patch", "not captured: worktree missing"],
				["/repo/b.patch", "1 file"],
				["/repo/c.patch", "2 files · +5 −0"],
				["/repo/d.patch", "+0 −3"],
				["/repo/e.patch", "1 file changed, 2 insertions(+)"],
				["/repo/plain.txt", undefined],
			],
		);
		const rendered = plainText(
			renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: false, selected: 0 }),
		);
		assert.match(rendered, /output\s+\/repo\/plain\.txt$/m);
	});

	it("records stage, tool, pause, resume, quit, and blocked events with their tones and chronological ordering (#5224)", () => {
		const pausedAndResumed = buildRunOutcome(
			makeRun(
				"blocked",
				[
					stage("s-skip", "skipped", { startedAt: 600, endedAt: 700 }),
					stage("s-block", "blocked", {
						startedAt: 800,
						endedAt: 900,
						failureMessage: "Error: approval needed",
					}),
					stage("s-run", "running", { startedAt: 950 }),
				],
				{
					startedAt: 500,
					pausedAt: 1_000,
					resumedAt: 1_200,
					endedAt: 1_500,
					toolNodes: [
						makeTool("tool:c", "cancel-tool", "cancelled", { startedAt: 1_250, endedAt: 1_300 }),
						makeTool("tool:r", "running-tool", "running", { startedAt: 1_350 }),
					],
				},
			),
			1_500,
		);
		assert.deepEqual(
			pausedAndResumed.events.map((event) => [event.at, event.tone, event.text]),
			[
				[500, "info", "ralph started"],
				[600, "info", "s-skip started"],
				[700, "muted", "s-skip skipped"],
				[800, "info", "s-block started"],
				[900, "warning", "s-block blocked: approval needed"],
				[950, "info", "s-run started"],
				[1_000, "warning", "ralph paused"],
				[1_200, "info", "ralph resumed"],
				[1_250, "info", "cancel-tool started"],
				[1_300, "muted", "cancel-tool stopped"],
				[1_350, "info", "running-tool started"],
				[1_500, "muted", "ralph ended blocked"],
			],
		);

		const quitRun = buildRunOutcome(
			makeRun("paused", [], {
				startedAt: 500,
				pausedAt: 1_000,
				resumedAt: 900,
				quitAt: 1_000,
				endedAt: 1_000,
			}),
			1_000,
		);
		assert.deepEqual(
			quitRun.events.map((event) => [event.at, event.tone, event.text]),
			[
				[500, "info", "ralph started"],
				[1_000, "warning", "ralph stopped"],
			],
		);

		const byFailedStageId = buildRunOutcome(
			makeRun(
				"failed",
				[
					stage("first-failed", "failed", { error: "first stage error" }),
					stage("target-failed", "failed", { error: "target stage error" }),
				],
				{ failedStageId: "target-failed" },
			),
			2_000,
		);
		assert.equal(byFailedStageId.reason, "target stage error");

		const byFailedStageFailureMessage = buildRunOutcome(
			makeRun(
				"failed",
				[
					stage("gate", "blocked", { error: "earlier blocked stage reason" }),
					stage("verify", "failed", { failureMessage: "Error: target stage failureMessage" }),
				],
				{ failedStageId: "verify" },
			),
			2_000,
		);
		assert.equal(byFailedStageFailureMessage.reason, "target stage failureMessage");
	});
});
