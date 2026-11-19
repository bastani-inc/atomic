import assert from "node:assert/strict";
import { stripTerminalSequences as stripAnsi } from "@bastani/atomic-tui";
import { describe, it, vi } from "vitest";
import { refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	TOOL_PAYLOAD_MAX_KEYS,
	TOOL_PAYLOAD_TRUNCATION_MARKER,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../../packages/workflows/src/shared/tool-payload-bounds.js";
import {
	buildRunOutcome,
	renderRunOutcomeLines,
	runOutcomeLogLines,
	summarizeFailureText,
	withoutStackFrames,
} from "../../packages/workflows/src/tui/run-outcome.js";
import * as textHelpers from "../../packages/workflows/src/tui/text-helpers.js";
import { defaultTheme, makeStage } from "./overlay-graph-helpers.js";

const { visibleWidth } = textHelpers;

const STACK = [
	"Error: verify gate failed: 2 jobs",
	"    at verifyStage (/repo/.atomic/workflows/ralph.ts:41:11)",
	"    at async runStage (/repo/node_modules/x/run.js:10:3)",
].join("\n");

function stage(id: string, status: StageSnapshot["status"], extra: Partial<StageSnapshot> = {}): StageSnapshot {
	return { ...makeStage(id), status, ...extra };
}

function tool(
	id: string,
	name: string,
	status: ToolNodeSnapshot["status"],
	extra: Partial<ToolNodeSnapshot> = {},
): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name,
		argsHash: "h",
		ordinal: 1,
		parentIds: [],
		status,
		attachable: false,
		...extra,
	};
}

function run(status: RunSnapshot["status"], stages: StageSnapshot[], extra: Partial<RunSnapshot> = {}): RunSnapshot {
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

function text(lines: readonly string[]): string {
	return lines.map((line) => stripAnsi(line)).join("\n");
}

describe("workflow run outcome and diagnostics (#5224)", () => {
	it("summarizes a failure to its first message line and never shows a stack frame", () => {
		const summary = summarizeFailureText(STACK);
		assert.equal(summary.reason, "verify gate failed: 2 jobs");
		assert.equal(summary.frames, 2);
		assert.equal(summarizeFailureText(undefined).reason, "No reason was recorded.");
		assert.equal(summarizeFailureText("\n\n  boom  \n").reason, "boom");
		assert.deepEqual(summarizeFailureText("   at foo (/x.ts:1:1)\nreal reason"), {
			reason: "real reason",
			frames: 1,
		});
		assert.deepEqual(summarizeFailureText("\x1b[31m    at handler (/code/main.ts:10:2)\x1b[0m\nError: refused"), {
			reason: "refused",
			frames: 1,
		});
		assert.deepEqual(summarizeFailureText("at least one approval is required"), {
			reason: "at least one approval is required",
			frames: 0,
		});
		assert.equal(summarizeFailureText(`at ${" ".repeat(10_000)}(native)x`).frames, 0);
		assert.equal(
			summarizeFailureText(`Error: ${"x".repeat(100_000)}`).reason.length,
			TOOL_PAYLOAD_VALUE_LIMIT - "Error: ".length,
		);
		assert.deepEqual(
			withoutStackFrames(
				[
					"Deploy failed",
					"at stage 3 the health check timed out",
					"at startup: service unavailable",
					"at midnight (UTC) try again",
					"    at verifyStage (/repo/.atomic/workflows/ralph.ts:41:11)",
					"    at Object.named [as alias] (/repo/a.ts:1:2)",
					"    at file:\x2f\x2f/repo/a b.ts:1:2",
					"    at Object.fn (/repo/a b.ts:1:2)",
					"    at async Promise.all (index 0)",
					"    at eval (eval at run (/repo/a.ts:1:2), <anonymous>:1:2)",
					"    at fn (native)",
					"    at <anonymous>",
					"\x1b[31m    at handler (/code/main.ts:10:2)\x1b[0m",
				].join("\n"),
			),
			{
				kept: [
					"Deploy failed",
					"at stage 3 the health check timed out",
					"at startup: service unavailable",
					"at midnight (UTC) try again",
				],
				frames: 9,
			},
		);
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
		assert.equal(outcome.outputs[0]?.value, "Fixed the shipping benchmark");
		assert.equal(outcome.outputs[1]?.value, "5236");
		assert.equal(outcome.outputs[2]?.value, '["a.ts","b.ts"]');
		assert.deepEqual(
			outcome.artifacts.map((artifact) => [artifact.kind, artifact.path, artifact.stage]),
			[
				["diff", "/repo/.atomic/artifacts/impl.patch", "implement"],
				["output", "/repo/out/report.md", "implement"],
			],
		);
		assert.match(outcome.artifacts[0]?.detail ?? "", /3 files · \+40 −2/);
		assert.deepEqual(outcome.blockers, []);

		const lines = text(renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: false, selected: 0 }));
		assert.match(lines, /✓ ralph · completed in 8s/);
		assert.match(lines, /Outputs/);
		assert.match(lines, /summary\s+Fixed the shipping benchmark/);
		assert.match(lines, /Artifacts/);
		assert.match(lines, /diff\s+\/repo\/\.atomic\/artifacts\/impl\.patch · 3 files · \+40 −2/);
	});

	it("bounds nested output inspection by the run-details display budget (#5255)", () => {
		const chunk = "x".repeat(1_024);
		for (const wrap of [(rows: string[]) => rows, (rows: string[]) => ({ rows })]) {
			let inspected = 0;
			const rows = new Proxy(new Array<string>(100_000).fill(chunk), {
				get(target, property, receiver) {
					if (typeof property === "string" && /^\d+$/.test(property)) inspected++;
					return Reflect.get(target, property, receiver);
				},
			});
			const outcome = buildRunOutcome(run("completed", [], { result: { data: wrap(rows) } }), 2_000);
			assert.equal(outcome.outputs[0]?.key, "data");
			assert.match(outcome.outputs[0]?.value ?? "", /x{100}/);
			assert.ok((outcome.outputs[0]?.value.length ?? 0) <= TOOL_PAYLOAD_VALUE_LIMIT);
			assert.ok(
				inspected <= Math.ceil(TOOL_PAYLOAD_VALUE_LIMIT / chunk.length) + 1,
				`${inspected} entries inspected`,
			);
		}
	});

	it("bounds wide output entry inspection and reports omitted run details (#5255)", () => {
		let descriptors = 0;
		let reads = 0;
		const original = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`output_${index}`, "value"]));
		const result = new Proxy(original, {
			getOwnPropertyDescriptor(target, key) {
				descriptors++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get(target, key, receiver) {
				if (typeof key === "string" && key.startsWith("output_")) reads++;
				return Reflect.get(target, key, receiver);
			},
		});
		const outcome = buildRunOutcome(run("completed", [], { result }), 2_000);
		assert.ok(descriptors <= TOOL_PAYLOAD_MAX_KEYS, `${descriptors} descriptors inspected`);
		assert.ok(reads <= TOOL_PAYLOAD_MAX_KEYS, `${reads} output values inspected`);
		assert.ok(outcome.outputs.some((output) => output.value.includes(TOOL_PAYLOAD_TRUNCATION_MARKER)));
		assert.equal(Object.keys(original).length, 10_000);
	});

	it("uses a stage's recorded failure message when the run has no error text (#5224)", () => {
		for (const failedStageId of [undefined, "verify"]) {
			const outcome = buildRunOutcome(
				run("failed", [stage("verify", "failed", { failureMessage: STACK })], { failedStageId }),
			);
			assert.equal(outcome.reason, "verify gate failed: 2 jobs");
			assert.equal(outcome.reason, outcome.blockers[0]?.reason);
		}
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

	it("renders run summaries and logs without ANSI when NO_COLOR is set even with a theme (#5255)", () => {
		vi.stubEnv("NO_COLOR", "1");
		refreshColorEnvironment();
		try {
			const outcome = buildRunOutcome(
				run("failed", [stage("verify", "failed", { error: "boom" })], {
					error: "boom",
					result: { summary: "retained output" },
					endedAt: 2_000,
				}),
				2_000,
			);
			for (const logs of [false, true]) {
				const lines = renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs, selected: 0 });
				assert.doesNotMatch(lines.join("\n"), /\x1b/);
				assert.match(lines.join("\n"), logs ? /Log/ : /Outputs/);
				assert.match(lines.join("\n"), /boom/);
			}
		} finally {
			vi.unstubAllEnvs();
			refreshColorEnvironment();
		}
	});

	it("failed and stopped runs read differently: ✗ red failed, ◼ muted stopped", () => {
		vi.stubEnv("NO_COLOR", undefined);
		refreshColorEnvironment();
		try {
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
			assert.match(stripAnsi(failed[0] ?? ""), /✗ ralph · failed/);
			assert.match(stripAnsi(stopped[0] ?? ""), /◼ ralph · stopped/);
			assert.equal(quit.state, "stopped");
			assert.notEqual(failed[0]?.match(/\x1b\[[0-9;]*m/)?.[0], stopped[0]?.match(/\x1b\[[0-9;]*m/)?.[0]);
		} finally {
			vi.unstubAllEnvs();
			refreshColorEnvironment();
		}
	});

	it("lists every blocker: a question waiting, a blocked stage and a failed tool, each with its next action", () => {
		const r = run(
			"running",
			[
				stage("approve", "awaiting_input", {
					pendingPrompt: {
						id: "p1",
						kind: "select",
						message: "\r\n  Approve this plan?",
						choices: ["Yes", "No"],
						createdAt: 1,
					},
				}),
				stage("deploy", "blocked", { error: "Provider rate limit: retry after 60s\n    at x (y:1:1)" }),
			],
			{ toolNodes: [tool("t1", "lint", "failed", { error: "eslint exited 1" })] },
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

	it("lists tool nodes in the events, and the run's end event leaves the reason to the Reason line", () => {
		const r = run("failed", [], {
			startedAt: 500,
			endedAt: 3_000,
			error: "verify gate failed",
			toolNodes: [
				tool("t1", "prepare", "completed", { startedAt: 600, endedAt: 900 }),
				tool("t2", "verify", "failed", {
					startedAt: 1_000,
					endedAt: 2_000,
					error: "verify gate failed",
				}),
			],
		});
		assert.deepEqual(
			buildRunOutcome(r, 3_000).events.map((event) => event.text),
			[
				"ralph started",
				"prepare started",
				"prepare completed",
				"verify started",
				"verify failed: verify gate failed",
				"ralph failed",
			],
		);
	});

	it("the log shows a failure once when a stage or tool repeats the run's own message", () => {
		const r = run("failed", [], {
			error: "verify gate failed",
			toolNodes: [tool("t2", "verify", "failed", { error: "verify gate failed" })],
		});
		assert.deepEqual(runOutcomeLogLines(r), ["verify gate failed"]);
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
	it("every string in the outcome is inert: escape sequences removed, controls and bidi overrides shown (#5224)", () => {
		const evil = "a\x1b]52;c;aGk=\x07b\x1b[2Jc\u202ed\x07e";
		const outcome = buildRunOutcome(
			run(
				"failed",
				[
					stage(`s${evil}`, "failed", {
						error: `boom ${evil}`,
						artifacts: [{ kind: "output", path: `/repo/${evil}.md`, captureError: `no ${evil}` }],
						pendingPrompt: undefined,
					}),
				],
				{
					name: `wf ${evil}`,
					error: `boom ${evil}`,
					exitReason: `exit ${evil}`,
					result: { [`k${evil}`]: `v ${evil}` },
				},
			),
		);
		const strings = JSON.stringify(outcome, (key, value) => (key === "id" || key === "runId" ? undefined : value));
		assert.doesNotMatch(strings, /\\u001b/, "no escape character survives anywhere the outcome shows");
		assert.doesNotMatch(strings, /\u202e/, "no bidi override survives");
		assert.match(outcome.name, /<U\+202E>/);
	});

	it("a value longer than three wrapped lines ends with an ellipsis instead of being cut silently (#5224)", () => {
		const outcome = buildRunOutcome(run("completed", [], { endedAt: 5_000, result: { notes: "word ".repeat(200) } }));
		const lines = renderRunOutcomeLines(outcome, { width: 60, logs: false, selected: 0 });
		const notes = lines.filter((line) => /notes|word/.test(line));
		assert.equal(notes.length, 3);
		assert.match(notes.at(-1) ?? "", /…$/);
	});

	it("aligns blocker reasons and output values by display width for wide and combining names (#5224)", () => {
		const outcome = buildRunOutcome(
			run(
				"running",
				[
					stage("a", "failed", { name: "部署チェック", error: "boom" }),
					stage("b", "failed", { name: "deploy-check", error: "boom" }),
					stage("c", "failed", { name: "cafe\u0301-check", error: "boom" }),
				],
				{
					result: {
						部署キー: "val-marker",
						"ascii-key": "val-marker",
						"cafe\u0301-key": "val-marker",
					},
				},
			),
		);
		const rendered = renderRunOutcomeLines(outcome, {
			theme: defaultTheme,
			width: 120,
			logs: false,
			selected: 0,
		}).map((line) => stripAnsi(line));
		const blockerCols = rendered
			.filter((line) => line.includes("boom") && line.includes("✗"))
			.map((line) => visibleWidth(line.slice(0, line.indexOf("boom"))));
		assert.deepEqual(blockerCols, [blockerCols[0], blockerCols[0], blockerCols[0]]);
		const outputCols = rendered
			.filter((line) => line.includes("val-marker"))
			.map((line) => visibleWidth(line.slice(0, line.indexOf("val-marker"))));
		assert.deepEqual(outputCols, [outputCols[0], outputCols[0], outputCols[0]]);
	});

	it("recurses into nested child workflows for waiting questions and failed tools (#5224)", () => {
		const rootRun = run("running", [
			stage("plan", "completed", { startedAt: 1_000, endedAt: 2_000 }),
			stage("deploy", "running", {
				startedAt: 2_000,
				workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-1" },
			}),
		]);
		const childRun: RunSnapshot = {
			id: "child-1",
			name: "child-wf",
			inputs: {},
			status: "running",
			startedAt: 2_000,
			parentRunId: "run-1",
			parentStageId: "deploy",
			rootRunId: "run-1",
			stages: [
				stage("ask", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "confirm", message: "Ship it?", createdAt: 2_500 },
				}),
			],
			toolNodes: [
				{
					kind: "tool",
					id: "t-child",
					name: "child-lint",
					argsHash: "h1",
					ordinal: 1,
					parentIds: [],
					status: "failed",
					error: "child tool failed",
					attachable: false,
				},
			],
		};
		const outcome = buildRunOutcome(rootRun, 3_000, [rootRun, childRun]);
		assert.equal(outcome.state, "waiting");
		assert.deepEqual(
			outcome.blockers.map((blocker) => [blocker.kind, blocker.node, blocker.id, blocker.name, blocker.reason]),
			[
				["awaiting_input", "stage", "child-1:ask", "ask", "Ship it?"],
				["failed", "tool", "child-1:t-child", "child-lint", "child tool failed"],
			],
		);
		assert.ok(outcome.log.some((line) => line.includes("child-lint:")));
		assert.ok(outcome.log.some((line) => line.includes("child tool failed")));
		const rootPromptOutcome = buildRunOutcome(
			run("running", [stage("work", "completed", { startedAt: 1_000, endedAt: 2_000 })], {
				pendingPrompt: { id: "approval", kind: "confirm", message: "\n  Deploy this release?", createdAt: 2_000 },
			}),
			3_000,
		);
		assert.equal(rootPromptOutcome.state, "waiting");
		assert.equal(rootPromptOutcome.reason, "Deploy this release?");
		assert.deepEqual(rootPromptOutcome.blockers, []);

		const completedParent = run("running", [
			stage("compose", "completed", {
				startedAt: 1_000,
				endedAt: 2_000,
				workflowChild: {
					alias: "child",
					workflow: "child-wf",
					runId: "child-current",
					status: "completed",
					outputs: {},
				},
				workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-old" },
			}),
		]);
		const staleChild: RunSnapshot = {
			id: "child-old",
			name: "old child",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			parentRunId: "run-1",
			parentStageId: "compose",
			rootRunId: "run-1",
			stages: [
				stage("ask", "awaiting_input", {
					pendingPrompt: { id: "old-q", kind: "confirm", message: "STALE prompt", createdAt: 1_100 },
				}),
			],
			toolNodes: [tool("t-stale", "stale-lint", "failed", { error: "stale tool failure" })],
		};
		const currentChild: RunSnapshot = {
			id: "child-current",
			name: "current child",
			inputs: {},
			status: "completed",
			startedAt: 1_200,
			endedAt: 2_000,
			parentRunId: "run-1",
			parentStageId: "compose",
			rootRunId: "run-1",
			stages: [stage("done", "completed", { startedAt: 1_200, endedAt: 2_000 })],
			toolNodes: [],
		};
		const supersededOutcome = buildRunOutcome(completedParent, 3_000, [completedParent, currentChild, staleChild]);
		assert.equal(supersededOutcome.state, "running");
		assert.deepEqual(supersededOutcome.blockers, []);
		assert.deepEqual(supersededOutcome.log, ["No log was recorded for this run."]);
	});

	it("prefers a run's returned failed status summary over a caught stage's error (#5224)", () => {
		const caught = run(
			"completed",
			[stage("tests", "failed", { error: "Error: process exited with code 1", endedAt: 2_000 })],
			{
				endedAt: 3_000,
				result: { status: "failed", summary: "Tests failed in 2 packages" },
			},
		);
		const outcome = buildRunOutcome(caught, 3_000);
		assert.equal(outcome.state, "failed");
		assert.equal(outcome.reason, "Tests failed in 2 packages");
	});

	it("keeps recorded failures ahead of a successful returned summary (#5224)", () => {
		for (const error of ["Error: admitted tool failure", undefined]) {
			const outcome = buildRunOutcome(
				run("failed", [stage("verify", "failed", { error: "Error: stage failed" })], {
					error,
					result: { status: "completed", summary: "all clear" },
				}),
			);
			assert.equal(outcome.reason, error === undefined ? "stage failed" : "admitted tool failure");
			assert.notEqual(outcome.reason, "all clear");
		}
	});

	it("preserves stage, cause and stack-frame indentation and normalizes CRLF in the run details log (#5224)", () => {
		const failedStage = stage("deploy", "failed", {
			error: "Deploy failed",
			failureMessage: "Deploy failed: 2 checks\r\n    at deploy (/repo/wf.ts:12:3)",
			failureDetail: {
				name: "Error",
				message: "Deploy failed: 2 checks",
				code: "E_DEPLOY",
				fields: {},
				cause: { name: "TypeError", message: "fetch failed", fields: {} },
			},
		});
		const failedRun = run("failed", [failedStage], {
			error: "ship failed\r\nsecond line",
			toolNodes: [
				{
					kind: "tool",
					id: "t1",
					name: "verify",
					argsHash: "h1",
					ordinal: 1,
					parentIds: [],
					status: "failed",
					error: "refused\r\nby server",
					attachable: false,
				},
			],
		});
		const outcome = buildRunOutcome(failedRun, 5_000);
		assert.equal(
			outcome.log.some((line) => line.includes("\\x0d")),
			false,
		);
		const rendered = renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 100, logs: true, selected: 0 }).map(
			(line) => stripAnsi(line),
		);
		assert.ok(rendered.some((line) => /^ {2}deploy:$/.test(line)));
		assert.ok(rendered.some((line) => /^ {4}Deploy failed: 2 checks$/.test(line)));
		assert.ok(rendered.some((line) => /^ {8}at deploy \(\/repo\/wf\.ts:12:3\)$/.test(line)));
		assert.ok(rendered.some((line) => /^ {6}TypeError: fetch failed$/.test(line)));
	});

	it("renders large output and reason values without wrapping the whole payload (#5224)", () => {
		const huge = "x".repeat(1_000_000);
		const outcome = buildRunOutcome(
			run("failed", [stage("verify", "failed", { error: "boom" })], {
				error: `Error: ${huge}`,
				result: { blob: huge },
			}),
			2_000,
		);
		assert.equal(outcome.reason?.length, TOOL_PAYLOAD_VALUE_LIMIT - "Error: ".length);
		assert.equal(outcome.outputs[0]?.value.length, TOOL_PAYLOAD_VALUE_LIMIT);
		const wrapped = vi.spyOn(textHelpers, "wrapPlainText");
		try {
			const summaryRows = renderRunOutcomeLines(outcome, {
				theme: defaultTheme,
				width: 120,
				logs: false,
				selected: 0,
			});
			assert.ok(summaryRows.length < 30);
			assert.ok(wrapped.mock.calls.length > 0);
			assert.ok(
				wrapped.mock.calls.every(([input]) => input.length <= 600),
				"summary slices each value before wrapping",
			);

			wrapped.mockClear();
			const logRows = renderRunOutcomeLines(outcome, { theme: defaultTheme, width: 120, logs: true, selected: 0 });
			assert.ok(logRows.length <= 260);
			assert.ok(wrapped.mock.calls.length > 0);
			assert.ok(
				wrapped.mock.calls.every(([input]) => input.length <= TOOL_PAYLOAD_VALUE_LIMIT),
				"log view bounds each line before wrapping",
			);
		} finally {
			wrapped.mockRestore();
		}
	});
});
