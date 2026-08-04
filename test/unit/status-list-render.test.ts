/**
 * Unit tests for the canonical status-list renderer (`src/tui/status-list.ts`).
 *
 * Visual contract from ui/mockups.html §2:
 *   - one rounded `BACKGROUND` panel
 *   - one two-row card per run (replaces the indented per-stage rows)
 *   - per-card row 1: status glyph + full run id
 *   - per-card row 2: workflow name + state badge, followed by meta rows
 *   - trailing hint pointing at `/workflow status <id>`
 *
 * Plain mode preserves rounded panel/card shape without ANSI escapes.
 *
 * cross-ref: src/tui/status-list.ts · src/tui/chat-surface.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { chatWidth } from "../../packages/workflows/src/tui/chat-surface.js";
import { hexToAnsi, RESET } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { statusColor, statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function makeStage(
	id: string,
	name: string,
	status: StageSnapshot["status"],
	extras: Partial<StageSnapshot> = {},
): StageSnapshot {
	return {
		id,
		name,
		status,
		parentIds: [],
		toolEvents: [],
		...extras,
	};
}

function makeRun(over: Partial<RunSnapshot>): RunSnapshot {
	return {
		id: over.id ?? "abc123uuid",
		name: over.name ?? "refactor-auth",
		inputs: over.inputs ?? {},
		status: over.status ?? "running",
		stages: over.stages ?? [],
		startedAt: over.startedAt ?? Date.now() - 5000,
		endedAt: over.endedAt,
		durationMs: over.durationMs,
		pausedDurationMs: over.pausedDurationMs,
		pausedAt: over.pausedAt,
		resumedAt: over.resumedAt,
		result: over.result,
		error: over.error,
		exited: over.exited,
		exitReason: over.exitReason,
		resumable: over.resumable,
		failureKind: over.failureKind,
		failureCode: over.failureCode,
		failureRecoverability: over.failureRecoverability,
		failureDisposition: over.failureDisposition,
		failureMessage: over.failureMessage,
		failedStageId: over.failedStageId,
	};
}

describe("renderStatusList — empty", () => {
	test("emits the rounded panel header + empty-state copy when no runs", () => {
		const out = renderStatusList([], { theme: deriveGraphTheme({}), width: 120 });
		const plain = stripAnsi(out);
		assert.match(plain, /╭ BACKGROUND {2}0 runs /);
		assert.match(plain, /0 runs/);
		assert.match(plain, /no workflow runs in current session/);
	});
});

describe("renderStatusList — populated", () => {
	test("multi-run snapshot renders header counts, cards, and a drill-down hint — without listing every stage", () => {
		const now = 1_000_000;
		const runs: RunSnapshot[] = [
			makeRun({
				id: "abc123uuid",
				name: "refactor-auth",
				status: "running",
				startedAt: now - 117_000,
				stages: [
					makeStage("s1", "scout", "completed", {
						startedAt: now - 117_000,
						endedAt: now - 72_000,
						durationMs: 45_000,
					}),
					makeStage("s2", "planner", "running", { startedAt: now - 72_000 }),
					makeStage("s3", "worker", "pending"),
				],
			}),
			makeRun({
				id: "def456uuid",
				name: "doc-update",
				status: "running",
				startedAt: now - 42_000,
				stages: [makeStage("w1", "writer", "running", { startedAt: now - 42_000 })],
			}),
			makeRun({
				id: "ghi789uuid",
				name: "scan-deps",
				status: "completed",
				startedAt: now - 16_000,
				endedAt: now - 8_000,
				durationMs: 8_000,
				stages: [makeStage("z1", "primer", "completed", { durationMs: 8_000 })],
			}),
		];
		const out = renderStatusList(runs, { theme: deriveGraphTheme({}), now, width: 120 });
		const plain = stripAnsi(out);

		// Panel header — chrome + subtitle + count badges.
		assert.match(plain, /╭ BACKGROUND {2}3 runs /);
		assert.match(plain, /3 runs/);
		assert.match(plain, /● 2/, "two active runs");
		assert.match(plain, /✓ 1/, "one completed run");

		// Each identity row carries the complete run id; the workflow identity is
		// deliberately on the following row so the UUID is never shortened.
		assert.ok(plain.includes("abc123uuid"));
		assert.ok(plain.includes("def456uuid"));
		assert.ok(plain.includes("ghi789uuid"));
		assert.match(plain, new RegExp(`refactor-auth\\s+${statusIcon("running")} running`));
		assert.match(plain, new RegExp(`doc-update\\s+${statusIcon("running")} running`));
		assert.match(plain, new RegExp(`scan-deps\\s+${statusIcon("completed")} completed`));

		// Row 3 — mode + progress strip + meta.
		assert.match(plain, /chain\s+\[✓\]\[●\]\[○\]/);
		assert.match(plain, /1\/3/, "chain progress fraction renders in meta");
		assert.match(plain, /single\s+\[●\]/);
		assert.match(plain, /single\s+\[✓\]/);

		const idRows = ["abc123uuid", "def456uuid", "ghi789uuid"].filter((id) => plain.includes(id));
		assert.equal(idRows.length, 3, "3 runs × 1 complete identity row");

		// Trailing hint references the most-recently-active run (def456, 42s ago).
		assert.match(plain, /▸ \/workflow status def456uuid/);
		assert.match(plain, /drill into a run/);
	});

	test("blocked terminal runs are not counted as successful completions", () => {
		const now = 1_000_000;
		const out = renderStatusList(
			[
				makeRun({
					id: "blk123uuid",
					name: "auth-blocked",
					status: "blocked",
					startedAt: now - 10_000,
					endedAt: now - 1_000,
				}),
			],
			{ now, width: 100 },
		);
		assert.match(out, /↑ 1 blocked/);

		assert.match(out, new RegExp(`${statusIcon("blocked")}\\s+blk123uuid`));
		assert.match(out, new RegExp(`auth-blocked\\s+${statusIcon("blocked")} blocked`));
		assert.doesNotMatch(out, /✓ 1/);
		assert.doesNotMatch(out, /✓ completed/);
	});

	test("awaiting input changes only the run indicator glyph/colour and attributes nested prompts to the root", () => {
		const theme = deriveGraphTheme({});
		const root = makeRun({ id: "root-awaiting", name: "root-awaiting", status: "running" });
		const child = makeRun({
			id: "child-awaiting",
			name: "hidden-child",
			status: "running",
			stages: [makeStage("ask", "ask", "awaiting_input")],
		});
		child.parentRunId = root.id;
		const out = renderStatusList([root], { theme, width: 100, allRuns: [root, child], showDetailHint: false });
		const plain = stripAnsi(out);
		const idLine = plain.split("\n").find((line) => line.includes(root.id));
		assert.ok(idLine?.includes(statusIcon("awaiting_input")));
		assert.ok(out.includes(hexToAnsi(statusColor("awaiting_input", theme))));
		assert.ok(plain.includes("root-awaiting"));
		assert.match(plain, /single\s+\[●\]/);
	});

	test("precomputed indicatorStatuses drive the indicator without the full run collection (restored payloads)", () => {
		const theme = deriveGraphTheme({});
		const root = makeRun({ id: "root-restored", name: "root-restored", status: "running" });
		const out = renderStatusList([root], {
			theme,
			width: 100,
			indicatorStatuses: { [root.id]: "awaiting_input" },
			showDetailHint: false,
		});
		const plain = stripAnsi(out);
		const idLine = plain.split("\n").find((line) => line.includes(root.id));
		assert.ok(idLine?.includes(statusIcon("awaiting_input")));
		assert.ok(out.includes(hexToAnsi(statusColor("awaiting_input", theme))));
	});

	test("legacy completed snapshots with incomplete returned status render blocked", () => {
		const now = 1_000_000;
		const out = renderStatusList(
			[
				makeRun({
					id: "old123uuid",
					name: "adversarial-verification",
					status: "completed",
					startedAt: now - 10_000,
					endedAt: now - 1_000,
					result: {
						status: "needs_human",
						remaining_work: "No API key for provider: github-copilot",
					},
				}),
			],
			{ now, width: 100 },
		);
		assert.match(out, /↑ 1 blocked/);

		assert.match(out, new RegExp(`${statusIcon("blocked")}\\s+old123uuid`));
		assert.match(out, new RegExp(`adversarial-verification\\s+${statusIcon("blocked")} blocked`));
		assert.doesNotMatch(out, /✓ 1/);
		assert.doesNotMatch(out, /✓ completed/);
	});

	test("legacy completed snapshots with structured recoverable stage failures render blocked without status output", () => {
		const now = 1_000_000;
		const out = renderStatusList(
			[
				makeRun({
					id: "auth00uuid",
					name: "adversarial-verification",
					status: "completed",
					startedAt: now - 10_000,
					endedAt: now - 1_000,
					failedStageId: "reviewer-a",
					stages: [
						makeStage("reviewer-a", "reviewer-a", "failed", {
							error: "A required model provider API key is missing. Configure the provider credentials and resume the workflow.",
							failureKind: "auth",
							failureCode: "missing_api_key",
							failureRecoverability: "recoverable",
							failureDisposition: "active_blocked",
							failureMessage: "No API key for provider: github-copilot",
						}),
					],
					result: {
						remaining_work: "Reviewer execution failed",
					},
				}),
			],
			{ now, width: 100 },
		);
		assert.match(out, /↑ 1 blocked/);

		assert.match(out, new RegExp(`${statusIcon("blocked")}\\s+auth00uuid`));
		assert.match(out, new RegExp(`adversarial-verification\\s+${statusIcon("blocked")} blocked`));
		assert.doesNotMatch(out, /✓ 1/);
		assert.doesNotMatch(out, /✓ completed/);
	});

	test("completed snapshots with tolerated recoverable stage failures stay completed", () => {
		const now = 1_000_000;
		const out = renderStatusList(
			[
				makeRun({
					id: "okauthuuid",
					name: "tournament",
					status: "completed",
					startedAt: now - 10_000,
					endedAt: now - 1_000,
					stages: [
						makeStage("reviewer-a", "reviewer-a", "failed", {
							error: "A required model provider API key is missing. Configure the provider credentials and resume the workflow.",
							failureKind: "auth",
							failureCode: "missing_api_key",
							failureRecoverability: "recoverable",
							failureDisposition: "active_blocked",
							failureMessage: "No API key for provider: github-copilot",
						}),
						makeStage("reviewer-b", "reviewer-b", "completed", { result: "approved" }),
					],
					result: { result: "approved" },
				}),
			],
			{ now, width: 100 },
		);

		assert.match(out, /✓ 1/);
		assert.match(out, /okauthuuid/);
		assert.match(out, new RegExp(`tournament\\s+${statusIcon("completed")} completed`));
		assert.doesNotMatch(out, /↑ 1 blocked/);
		assert.doesNotMatch(out, /↑ blocked/);
	});

	test("quit run renders as resumable instead of failed", () => {
		const out = renderStatusList(
			[
				makeRun({
					id: "quit123uuid",
					name: "resume-me",
					status: "paused",
					exitReason: "quit",
					resumable: true,
				}),
			],
			{ width: 120 },
		);
		const plain = stripAnsi(out);
		assert.match(plain, /BACKGROUND {2}1 run {2}1 quit/);
		assert.match(plain, /resume-me/);
		assert.match(plain, /resumable via \/workflow resume/);
		assert.doesNotMatch(plain, /failed/);
	});
	test("quit run with a pending prompt keeps the prompt-free resumable card byte-identical", () => {
		const now = 10_000;
		const theme = deriveGraphTheme({});
		const promptFree: RunSnapshot = makeRun({
			id: "quit-prompt-list",
			name: "resume-me",
			status: "paused",
			startedAt: now - 1_000,
			exitReason: "quit",
			resumable: true,
		});
		const prompted: RunSnapshot = {
			...promptFree,
			pendingPrompt: {
				id: "quit-prompt",
				kind: "confirm",
				message: "Continue?",
				createdAt: now - 100,
			},
		};
		const opts = { theme, now, width: 120 };
		const promptFreeOutput = renderStatusList([promptFree], opts);
		const promptedOutput = renderStatusList([prompted], opts);
		assert.equal(promptedOutput, promptFreeOutput);
		const plain = stripAnsi(promptedOutput);
		assert.match(plain, new RegExp(`${statusIcon("pending")}\\s+quit-prompt-list`));
		assert.match(plain, new RegExp(`resume-me.*${statusIcon("pending")}\\s+quit`));
		assert.match(plain, /resumable via \/workflow resume/);
	});

	test("mixed running and paused snapshot keeps paused runs out of running counts and labels their rows", () => {
		const now = 1_000_000;
		const runs: RunSnapshot[] = [
			makeRun({
				id: "run111uuid",
				name: "active-wf",
				status: "running",
				startedAt: now - 4_000,
				stages: [makeStage("r1", "worker", "running", { startedAt: now - 4_000 })],
			}),
			makeRun({
				id: "pause222uuid",
				name: "paused-wf",
				status: "paused",
				startedAt: now - 10_000,
				pausedAt: now - 6_000,
				stages: [makeStage("p1", "review", "paused", { startedAt: now - 10_000, pausedAt: now - 6_000 })],
			}),
		];

		const out = renderStatusList(runs, { theme: deriveGraphTheme({}), now, width: 120, showDetailHint: false });
		const plain = stripAnsi(out);

		assert.match(plain, /╭ BACKGROUND {2}2 runs /);
		assert.match(plain, /● 1/, "only the running run contributes to the running count");
		assert.doesNotMatch(plain, /● 2/, "paused run must not be counted as running");
		assert.match(plain, /❚❚ 1 paused/, "paused count is rendered separately");

		const runningRow = plain.split("\n").find((line) => line.includes("active-wf"));
		assert.ok(runningRow, "running run row is present");
		assert.match(runningRow, new RegExp(`active-wf\\s+${statusIcon("running")} running`));

		const pausedRow = plain.split("\n").find((line) => line.includes("paused-wf"));
		assert.ok(pausedRow, "paused run row is present");
		assert.match(plain, /pause222uuid/);
		assert.match(pausedRow, new RegExp(`paused-wf\\s+${statusIcon("paused")} paused`));
		assert.doesNotMatch(pausedRow, /○ pending/);
		assert.doesNotMatch(pausedRow, /● running/);
	});

	test("plain paused status output is ANSI-free and uses paused glyph and label", () => {
		const now = 1_000_000;
		const run = makeRun({
			id: "pause333uuid",
			name: "paused-plain",
			status: "paused",
			startedAt: now - 10_000,
			pausedAt: now - 6_000,
			stages: [makeStage("p1", "worker", "paused", { startedAt: now - 10_000, pausedAt: now - 6_000 })],
		});

		const out = renderStatusList([run], { width: 100, now, showDetailHint: false });

		assert.doesNotMatch(out, /\x1b\[/);
		assert.match(out, /^╭ BACKGROUND {2}1 run /);
		assert.match(out, /❚❚ 1 paused/);
		assert.match(out, /pause333uuid/);
		assert.match(out, new RegExp(`paused-plain\\s+${statusIcon("paused")} paused`));
		assert.match(out, /single\s+\[❚❚\]/, "paused progress cell uses the paused glyph, not the pending cell");
		assert.doesNotMatch(out, /○ pending/);
		assert.doesNotMatch(out, /● 1(?:\s+running)?/);
	});

	test("active runs sort ahead of ended runs", () => {
		const now = 1_000_000;
		const ended = makeRun({
			id: "endedrun",
			name: "old-run",
			status: "completed",
			startedAt: now - 60_000,
			endedAt: now - 10_000,
		});
		const active = makeRun({
			id: "activerun",
			name: "fresh-run",
			status: "running",
			startedAt: now - 30_000,
		});
		const out = renderStatusList([ended, active], { theme: deriveGraphTheme({}), now, width: 120 });
		const plain = stripAnsi(out);
		const activeIdx = plain.indexOf("fresh-run");
		const endedIdx = plain.indexOf("old-run");
		assert.ok(activeIdx >= 0 && endedIdx >= 0);
		assert.ok(activeIdx < endedIdx, "active runs render above ended runs");
	});

	test("plain mode (no theme) preserves the band + card shape and emits no ANSI escapes", () => {
		const run = makeRun({
			id: "xyz000aaaa",
			name: "scratch",
			status: "running",
			startedAt: Date.now() - 1000,
			stages: [makeStage("x", "worker", "running")],
		});
		const out = renderStatusList([run], { width: 80 });
		assert.doesNotMatch(out, /\x1b\[/);
		assert.match(out, /^╭ BACKGROUND {2}1 run /, "plain panel is rounded");
		assert.doesNotMatch(out, /\u258e/);
		assert.match(out, /●\s+xyz000/, "plain entry has status glyph and run id");
		assert.match(out, /scratch/);
		assert.match(out, /single\s+\[●\]/);
		assert.match(out, /▸ \/workflow status xyz000/);
	});

	test("failed run carries the killed/failed-at-stage meta", () => {
		const now = 1_000_000;
		const run = makeRun({
			id: "kill0aaa",
			name: "fan-out-and-synthesize",
			status: "killed",
			startedAt: now - 4_000,
			endedAt: now - 1_000,
			stages: [
				makeStage("s1", "scout", "completed", { durationMs: 22_000 }),
				makeStage("s2", "partition", "failed", { durationMs: 0 }),
			],
		});
		const out = renderStatusList([run], { theme: deriveGraphTheme({}), now, width: 120 });
		const plain = stripAnsi(out);
		assert.match(plain, /⊘ killed/);
		assert.match(plain, /failed at partition/);
	});

	test("terminal ctx.exit rows include the author reason in list meta", () => {
		const now = 1_000_000;
		const runs: RunSnapshot[] = [
			makeRun({
				id: "exitcmpl",
				name: "exit-completed",
				status: "completed",
				exited: true,
				exitReason: "guard completed early",
				startedAt: now - 12_000,
				endedAt: now - 2_000,
				stages: [makeStage("c1", "guard", "completed", { durationMs: 10_000 })],
			}),
			makeRun({
				id: "exitskip",
				name: "exit-skipped",
				status: "skipped",
				exited: true,
				exitReason: "nothing to process",
				startedAt: now - 8_000,
				endedAt: now - 1_000,
				stages: [makeStage("s1", "scan", "skipped", { durationMs: 7_000 })],
			}),
		];

		const out = renderStatusList(runs, { width: 120, now, showDetailHint: false });

		assert.match(out, /guard completed early/);
		assert.match(out, /nothing to process/);
		assert.match(out, /✓ completed/);
		assert.match(out, /⊘ skipped/);
	});

	test("narrow width truncates progress strip with …", () => {
		const now = 1_000_000;
		const stages = Array.from({ length: 12 }, (_, i) =>
			makeStage(`s${i}`, `stage-${i}`, i < 3 ? "completed" : i === 3 ? "running" : "pending"),
		);
		const run = makeRun({
			id: "7c4a91xx",
			name: "ent-deep-research",
			status: "running",
			startedAt: now - 60_000,
			stages,
		});
		const out = renderStatusList([run], { theme: deriveGraphTheme({}), now, width: 60 });
		const plain = stripAnsi(out);
		// Strip must truncate to fit the 60-column width.
		assert.match(plain, /\[…\]|\]…|…/, "ellipsis present on narrow strip");
	});

	test("long and wide run/stage names stay within the requested line width", () => {
		const now = 1_000_000;
		const width = 64;
		const run = makeRun({
			id: "wide99uuid",
			name: `${"研究".repeat(18)}-status-list-overflow`,
			status: "running",
			startedAt: now - 60_000,
			stages: [
				makeStage("s1", "scout", "completed", { durationMs: 10_000 }),
				makeStage("s2", "正在运行".repeat(12), "running", { startedAt: now - 30_000 }),
			],
		});
		const out = renderStatusList([run], { theme: deriveGraphTheme({}), now, width });
		for (const line of out.split("\n")) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
		}
		assert.match(stripAnsi(out), /…/);
	});
	test("wraps complete ids and preserves borders at every narrow width", () => {
		const runId = "d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f";
		const run = makeRun({ id: runId, name: "narrow-status", status: "running" });
		for (const width of [80, 79, 60, 40, 30, 20]) {
			const plain = stripAnsi(renderStatusList([run], { theme: deriveGraphTheme({}), width }));
			const lines = plain.split("\n");
			const expectedWidth = chatWidth(width);
			for (const line of lines) assert.equal(visibleWidth(line), expectedWidth);
			const idStart = lines.findIndex((line) => line.includes(runId.slice(0, 8)));
			const nameRow = lines.findIndex((line, index) => index > idStart && line.includes("narrow-status"));
			const renderedId = lines
				.slice(idStart, nameRow)
				.join("")
				.replace(/[^0-9a-f-]/gi, "");
			assert.equal(renderedId, runId, `full id is retained at width ${width}`);
			assert.doesNotMatch(plain, /d4e5f6a1-.*…/);
			assert.ok(lines[0]?.startsWith("╭"));
			assert.ok(lines.at(-1)?.startsWith("╰"));
		}
	});

	test("themes every wrapped run-id row in the workflow status hint", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const run = makeRun({ id: runId, name: "narrow-hint", status: "running" });
		const theme = deriveGraphTheme({});
		const lines = renderStatusList([run], { width: 44, theme }).split("\n");
		const hintLines = lines.filter((line) => {
			const plain = stripAnsi(line);
			return plain.includes("/workflow status") || plain.includes("76-d1a348f582ae");
		});

		assert.equal(hintLines.length, 2, "the full hint id wraps across two rows");
		for (const line of hintLines) {
			assert.ok(
				line.includes(hexToAnsi(theme.accent)),
				`wrapped id row is not accent-coloured: ${JSON.stringify(line)}`,
			);
			assert.ok(line.includes(RESET), `wrapped id row has no colour reset: ${JSON.stringify(line)}`);
		}
	});
});
