// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, it } from "vitest";
import {
	buildRunOutcome,
	renderRunOutcomeLines,
	runOutcomeLogLines,
	summarizeFailureText,
} from "../../packages/workflows/src/tui/run-outcome.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { defaultTheme, makeStage } from "./overlay-graph-helpers.js";

const STACK = [
	"Error: verify gate failed: 2 jobs",
	"    at verifyStage (/repo/.atomic/workflows/ralph.ts:41:11)",
	"    at async runStage (/repo/node_modules/x/run.js:10:3)",
].join("\n");

function stage(id, status, extra = {}) {
	return { ...makeStage(id), status, ...extra };
}

function run(status, stages, extra = {}) {
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

function text(lines) {
	return lines.map((line) => stripAnsi(line)).join("\n");
}

describe("workflow run outcome and diagnostics (#5224)", () => {
	it("summarizes a failure to its first message line and never shows a stack frame", () => {
		const summary = summarizeFailureText(STACK);
		assert.equal(summary.reason, "verify gate failed: 2 jobs");
		assert.equal(summary.frames, 2);
		assert.equal(summarizeFailureText(undefined).reason, "No reason was recorded.");
		assert.equal(summarizeFailureText("\n\n  boom  \n").reason, "boom");
	});

	it("a completed run shows its declared outputs and the artifacts its stages collected", () => {
		const outcome = buildRunOutcome(
			run(
				"completed",
				[
					stage("plan", "completed", { startedAt: 1_000, endedAt: 2_000 }),
					stage("implement", "completed", {
						startedAt: 2_000,
						endedAt: 9_000,
						artifacts: [
							{
								kind: "diff",
								path: "/repo/.atomic/artifacts/impl.patch",
								filesChanged: 3,
								insertions: 40,
								deletions: 2,
							},
							{ kind: "output", path: "/repo/out/report.md" },
						],
					}),
				],
				{
					endedAt: 9_000,
					result: { summary: "Fixed the shipping benchmark", prNumber: 5236, files: ["a.ts", "b.ts"] },
				},
			),
			9_000,
		);
		assert.equal(outcome.state, "completed");
		assert.deepEqual(
			outcome.outputs.map((output) => output.key),
			["summary", "prNumber", "files"],
		);
		assert.equal(outcome.outputs[0].value, "Fixed the shipping benchmark");
		assert.equal(outcome.outputs[1].value, "5236");
		assert.equal(outcome.outputs[2].value, '["a.ts","b.ts"]');
		assert.deepEqual(
			outcome.artifacts.map((artifact) => [artifact.kind, artifact.path, artifact.stage]),
			[
				["diff", "/repo/.atomic/artifacts/impl.patch", "implement"],
				["output", "/repo/out/report.md", "implement"],
			],
		);
		assert.match(outcome.artifacts[0].detail, /3 files · \+40 −2/);
		assert.deepEqual(outcome.blockers, []);

		const lines = text(renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: false, selected: 0 }));
		assert.match(lines, /✓ ralph · completed in 8s/);
		assert.match(lines, /Outputs/);
		assert.match(lines, /summary\s+Fixed the shipping benchmark/);
		assert.match(lines, /Artifacts/);
		assert.match(lines, /diff\s+\/repo\/\.atomic\/artifacts\/impl\.patch · 3 files · \+40 −2/);
	});

	it("a failed run names the failed stage with a short reason and the next actions, never a stack trace", () => {
		const r = run(
			"failed",
			[stage("plan", "completed"), stage("verify", "failed", { error: STACK, endedAt: 5_000 })],
			{
				error: STACK,
				failedStageId: "verify",
				endedAt: 5_000,
			},
		);
		const outcome = buildRunOutcome(r, 5_000);
		assert.equal(outcome.state, "failed");
		assert.equal(outcome.reason, "verify gate failed: 2 jobs");
		assert.deepEqual(
			outcome.blockers.map((blocker) => [blocker.kind, blocker.name, blocker.reason]),
			[["failed", "verify", "verify gate failed: 2 jobs"]],
		);
		const summary = text(
			renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: false, selected: 0 }),
		);
		assert.match(summary, /✗ ralph · failed after 4s/);
		assert.match(summary, /Reason\s+verify gate failed: 2 jobs/);
		assert.match(summary, /❯ ✗ verify\s+verify gate failed: 2 jobs/);
		assert.match(summary, /enter retry, fork, transcript or logs/);
		assert.doesNotMatch(summary, /\bat verifyStage\b/, "the summary never shows a stack frame");

		const logs = text(renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: true, selected: 0 }));
		assert.match(logs, /at verifyStage \(\/repo\/\.atomic\/workflows\/ralph\.ts:41:11\)/, "the full log keeps it");
		assert.ok(runOutcomeLogLines(r).some((line) => line.includes("at async runStage")));
	});

	it("failed and stopped runs read differently: ✗ red failed, ◼ muted stopped", () => {
		const failed = renderRunOutcomeLines(buildRunOutcome(run("failed", [], { error: "boom" }), 2_000), {
			theme: defaultTheme,
			width: 80,
			logs: false,
			selected: 0,
		});
		const stopped = renderRunOutcomeLines(buildRunOutcome(run("killed", [], { endedAt: 2_000 }), 2_000), {
			theme: defaultTheme,
			width: 80,
			logs: false,
			selected: 0,
		});
		const quit = buildRunOutcome(run("paused", [], { quitAt: 2_000 }), 2_000);
		assert.match(stripAnsi(failed[0]), /✗ ralph · failed/);
		assert.match(stripAnsi(stopped[0]), /◼ ralph · stopped/);
		assert.equal(quit.state, "stopped");
		assert.notEqual(failed[0].match(/\x1b\[[0-9;]*m/)?.[0], stopped[0].match(/\x1b\[[0-9;]*m/)?.[0]);
	});

	it("lists every blocker: a question waiting, a blocked stage and a failed tool, each with its next action", () => {
		const r = run(
			"running",
			[
				stage("approve", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "select", message: "Approve this plan?", choices: ["Yes", "No"] },
				}),
				stage("deploy", "blocked", { error: "Provider rate limit: retry after 60s\n    at x (y:1:1)" }),
			],
			{ toolNodes: [{ id: "t1", name: "lint", status: "failed", error: "eslint exited 1", parentIds: [] }] },
		);
		const outcome = buildRunOutcome(r, 3_000);
		assert.equal(outcome.state, "waiting");
		assert.deepEqual(
			outcome.blockers.map((blocker) => [blocker.kind, blocker.node, blocker.name, blocker.reason]),
			[
				["awaiting_input", "stage", "approve", "Approve this plan?"],
				["blocked", "stage", "deploy", "Provider rate limit: retry after 60s"],
				["failed", "tool", "lint", "eslint exited 1"],
			],
		);
		const lines = text(renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 120, logs: false, selected: 1 }));
		assert.match(lines, /Blockers · 3/);
		assert.match(lines, /❯ ↑ deploy\s+Provider rate limit: retry after 60s/);
		assert.match(lines, /enter open the stage chat to resume it/, "the selected blocker names its next action");
		const first = text(renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 120, logs: false, selected: 0 }));
		assert.match(first, /❯ ◆ approve\s+Approve this plan\?/);
		assert.match(first, /enter answer in the stage chat/);
	});

	it("records events in order: run start, each stage's start and end, pause and resume", () => {
		const r = run(
			"completed",
			[
				stage("plan", "completed", { startedAt: 1_000, endedAt: 2_000 }),
				stage("review", "completed", { startedAt: 3_000, endedAt: 4_000 }),
			],
			{ startedAt: 500, endedAt: 4_000 },
		);
		const events = buildRunOutcome(r, 4_000).events.map((event) => event.text);
		assert.deepEqual(events, [
			"ralph started",
			"plan started",
			"plan completed",
			"review started",
			"review completed",
			"ralph completed",
		]);
	});

	it("fits every row to the width at 80 and 160 columns, and degrades to plain text without a theme", () => {
		const r = run("failed", [stage("verify", "failed", { error: "x".repeat(400) })], {
			error: "x".repeat(400),
			result: { note: "y".repeat(300) },
		});
		for (const width of [40, 80, 160]) {
			for (const line of renderRunOutcomeLines(buildRunOutcome(r, 2_000), {
				theme: defaultTheme,
				width,
				logs: false,
				selected: 0,
			}))
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${stripAnsi(line)}`);
		}
		const plain = renderRunOutcomeLines(buildRunOutcome(r, 2_000), { width: 80, logs: false, selected: 0 });
		assert.ok(
			plain.every((line) => line === stripAnsi(line)),
			"no theme, no escape codes",
		);
	});
});
