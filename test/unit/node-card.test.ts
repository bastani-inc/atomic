/**
 * Unit tests for the rounded node-card renderer.
 *
 * Pinned behaviours (DESIGN.md §5):
 *  - Fixed geometry: width × height regardless of focus or status.
 *  - Status border colour: completed = success, failed = error,
 *    running = warning (locked at peak when focused), pending =
 *    borderDim (lifted to borderActive when focused).
 *  - Focus signal: the centred title turns into an accent-coloured
 *    tab painted with `theme.accent` bg + `theme.surface` fg + bold.
 *    The non-focused title is bold-on-card-bg.
 *
 * cross-ref:
 *   - src/tui/node-card.ts
 *   - src/tui/graph-theme.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { StageSnapshot, StageStatus } from "../../packages/workflows/src/shared/store-types.js";
import { hexBg, hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { NODE_H, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

const theme = deriveGraphTheme({});

function makeStage(opts: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id: opts.id ?? "alpha",
		name: opts.name ?? "alpha",
		status: opts.status ?? ("pending" as StageStatus),
		parentIds: opts.parentIds ?? [],
		topologyState: opts.topologyState,
		nodeKind: opts.nodeKind,
		toolStatus: opts.toolStatus,
		toolEvents: opts.toolEvents ?? [],
		durationMs: opts.durationMs,
		pausedDurationMs: opts.pausedDurationMs,
		startedAt: opts.startedAt,
		endedAt: opts.endedAt,
		pausedAt: opts.pausedAt,
		resumedAt: opts.resumedAt,
		blockedByStageId: opts.blockedByStageId,
		model: opts.model,
		workflowChild: opts.workflowChild,
		workflowChildRun: opts.workflowChildRun,
		fastMode: opts.fastMode,
	};
}

describe("renderNodeCard — geometry", () => {
	test("emits exactly NODE_H lines at NODE_W cells wide", () => {
		const lines = renderNodeCard(makeStage(), { theme });
		assert.equal(lines.length, NODE_H);
		for (const line of lines) {
			// Visible width is `NODE_W` for every row.
			assert.equal(stripAnsi(line).length, NODE_W);
		}
	});

	test("focus does not change card dimensions", () => {
		const unfocused = renderNodeCard(makeStage({ name: "deploy" }), {
			theme,
			focused: false,
		});
		const focused = renderNodeCard(makeStage({ name: "deploy" }), {
			theme,
			focused: true,
		});
		assert.equal(focused.length, unfocused.length);
		for (let i = 0; i < focused.length; i++) {
			assert.equal(
				stripAnsi(focused[i]!).length,
				stripAnsi(unfocused[i]!).length,
				`row ${i} width must stay constant between focused/unfocused`,
			);
		}
	});
});

describe("renderNodeCard — queued-message badge", () => {
	test("claims the dim metadata row on an ordinary card, keeping status and duration", () => {
		const stage = makeStage({ status: "running", startedAt: 1, parentIds: ["upstream"] });
		const plain = stripAnsi(renderNodeCard(stage, { theme }).join("\n"));
		assert.match(plain, /1 dep/);
		const lines = renderNodeCard(stage, { theme, queuedMessageCount: 2 });
		assert.equal(lines.length, NODE_H);
		for (const line of lines) assert.equal(stripAnsi(line).length, NODE_W);
		const badged = stripAnsi(lines.join("\n"));
		assert.match(badged, /2 queued/);
		assert.match(badged, /running/);
		assert.doesNotMatch(badged, /1 dep/);
	});

	test("keeps child identity, status, full UUID, and queued badge at the real card geometry", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const lines = renderNodeCard(
			makeStage({
				status: "running",
				workflowChildRun: { alias: "child", workflow: "publish-child", runId },
			}),
			{ theme, queuedMessageCount: 2 },
		);
		const plainLines = lines.map(stripAnsi);
		const rendered = plainLines.join("\n");
		const renderedRunId = plainLines
			.slice(1, -1)
			.map((line) => line.slice(1, -1).trim())
			.filter((line) => /^(?:run )?[0-9a-f-]+$/.test(line))
			.join("")
			.replace(/^run /, "");

		assert.equal(lines.length, NODE_H);
		for (const line of plainLines) assert.equal(line.length, NODE_W);
		assert.match(rendered, /publish-child/);
		assert.match(rendered, new RegExp(`${statusIcon("running")} running`));
		assert.match(rendered, /✉ 2 queued/);
		assert.equal(renderedRunId, runId);
		assert.doesNotMatch(rendered, /…/);
	});

	test("renders a single queued message count verbatim", () => {
		const lines = renderNodeCard(makeStage({ status: "running", startedAt: 1 }), {
			theme,
			queuedMessageCount: 1,
		});
		assert.match(stripAnsi(lines.join("\n")), /1 queued/);
	});

	test("keeps the awaiting-input action hint and replaces the redundant row", () => {
		const stage = makeStage({ status: "awaiting_input", startedAt: 1 });
		const plain = renderNodeCard(stage, { theme });
		assert.match(stripAnsi(plain.join("\n")), /waiting for response/);
		const badged = renderNodeCard(stage, { theme, queuedMessageCount: 3 });
		assert.equal(badged.length, NODE_H);
		assert.equal(badged.length, plain.length);
		for (let i = 0; i < badged.length; i++) {
			assert.equal(stripAnsi(badged[i]!).length, stripAnsi(plain[i]!).length, `row ${i} width must not shift`);
		}
		const rendered = stripAnsi(badged.join("\n"));
		assert.match(rendered, /3 queued/);
		assert.match(rendered, /↵ enter to respond/);
		assert.match(rendered, /awaiting input/);
		assert.doesNotMatch(rendered, /waiting for response/);
	});

	test("keeps queued badges on awaiting-input child boundaries at the real card geometry", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const childBoundaries: Array<{ label: string; stage: Partial<StageSnapshot> }> = [
			{
				label: "live child",
				stage: { workflowChildRun: { alias: "child", workflow: "publish-child", runId } },
			},
			{
				label: "completed child",
				stage: {
					workflowChild: {
						alias: "child",
						workflow: "publish-child",
						runId,
						status: "completed",
						outputs: {},
					},
				},
			},
		];

		for (const { label, stage } of childBoundaries) {
			for (const queuedMessageCount of [1, 2, 12, 100]) {
				const lines = renderNodeCard(makeStage({ ...stage, status: "awaiting_input" }), {
					theme,
					width: 24,
					height: 5,
					queuedMessageCount,
				});
				const plainLines = lines.map(stripAnsi);
				const rendered = plainLines.join("\n");
				const context = `${label} queuedMessageCount=${queuedMessageCount}`;
				const badgeLine = plainLines.find((line) => line.includes(`${queuedMessageCount} queued`));
				const badgeText = badgeLine?.slice(1, -1).trim();

				assert.equal(lines.length, 5, context);
				for (const line of plainLines) assert.equal(visibleWidth(line), 24, context);
				assert.notEqual(badgeText, undefined, context);
				assert.match(badgeText!, new RegExp(`^\\S ${queuedMessageCount} queued$`), context);
				assert.doesNotMatch(badgeText!, /…/, context);
				assert.match(rendered, new RegExp(`${statusIcon("awaiting_input")} awaiting input`), context);
				assert.match(rendered, /↵ enter to respond/, context);
			}
		}
	});

	test("omits the badge for zero, negative, and absent counts", () => {
		for (const queuedMessageCount of [undefined, 0, -1, Number.NaN]) {
			const lines = renderNodeCard(makeStage({ status: "running", startedAt: 1 }), {
				theme,
				queuedMessageCount,
			});
			assert.doesNotMatch(stripAnsi(lines.join("\n")), /queued/, `count ${String(queuedMessageCount)}`);
			assert.equal(lines.length, NODE_H);
			for (const line of lines) assert.equal(stripAnsi(line).length, NODE_W);
		}
	});
	test("keeps every child-run queued badge whole for long status labels at the real geometry", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const statuses: Array<{
			label: string;
			stage: Partial<StageSnapshot>;
			expectedStatusText: string;
		}> = [
			{
				label: "cancelled",
				stage: { status: "skipped", nodeKind: "tool", toolStatus: "cancelled" },
				expectedStatusText: `${statusIcon("cancelled")} cancelled`,
			},
			{
				label: "complete",
				stage: {
					status: "completed",
					durationMs: 1,
					workflowChild: {
						alias: "child",
						workflow: "publish-child",
						runId,
						status: "completed",
						outputs: { artifact: "ready" },
					},
				},
				expectedStatusText: `${statusIcon("completed")} complete`,
			},
			{
				label: "running",
				stage: { status: "running", startedAt: 1 },
				expectedStatusText: `${statusIcon("running")} running`,
			},
		];

		for (const { label, stage, expectedStatusText } of statuses) {
			for (const queuedMessageCount of [1, 12, 100]) {
				const lines = renderNodeCard(
					makeStage({
						...stage,
						workflowChildRun: { alias: "child", workflow: "publish-child", runId },
					}),
					{ theme, width: 24, height: 5, queuedMessageCount },
				);
				const plainLines = lines.map(stripAnsi);
				const rendered = plainLines.join("\n");
				const context = `${label} queuedMessageCount=${queuedMessageCount}`;

				assert.equal(lines.length, 5, context);
				for (const line of plainLines) assert.equal(line.length, 24, context);
				assert.match(rendered, new RegExp(`${queuedMessageCount} queued`), context);
				assert.doesNotMatch(rendered, /…/, context);
				if (queuedMessageCount === 1) assert.match(rendered, new RegExp(expectedStatusText), context);
			}
		}
	});
});

describe("renderNodeCard — focused tab marker", () => {
	test("focused card uses an accent title slot without a caret glyph", () => {
		const lines = renderNodeCard(makeStage({ name: "deploy" }), {
			theme,
			focused: true,
		});
		const top = stripAnsi(lines[0]!);
		assert.doesNotMatch(top, /▸/);
		assert.match(top, /deploy/);
	});

	test("unfocused card omits the focus glyph", () => {
		const lines = renderNodeCard(makeStage({ name: "deploy" }), {
			theme,
			focused: false,
		});
		const top = stripAnsi(lines[0]!);
		assert.doesNotMatch(top, /▸/);
		// Stage name still appears in the title slot.
		assert.match(top, /deploy/);
	});

	test("focused tab paints the accent background on the title slot", () => {
		const lines = renderNodeCard(makeStage({ name: "ship" }), {
			theme,
			focused: true,
		});
		// The accent bg SGR sequence sourced from `theme.accent` must
		// appear somewhere on the top border — that's the tab.
		const accentBg = hexBg(theme.accent);
		assert.ok(lines[0]!.includes(accentBg), `focused top row must include accent bg SGR ${JSON.stringify(accentBg)}`);
	});

	test("unfocused card never paints the accent background", () => {
		const lines = renderNodeCard(makeStage({ name: "ship" }), {
			theme,
			focused: false,
		});
		const accentBg = hexBg(theme.accent);
		for (const line of lines) {
			assert.ok(!line.includes(accentBg), "unfocused card must not include accent bg SGR anywhere");
		}
	});
});

describe("renderNodeCard — status border colours", () => {
	function topRowAnsiSequences(line: string): string[] {
		return line.match(ANSI_RE) ?? [];
	}

	test("completed status uses the success border colour", () => {
		const lines = renderNodeCard(makeStage({ status: "completed", durationMs: 1200 }), { theme });
		const successFg = hexToAnsi(theme.success);
		assert.ok(lines[0]!.includes(successFg), "top border must include success fg SGR for completed status");
	});

	test("failed status uses the error border colour", () => {
		const lines = renderNodeCard(makeStage({ status: "failed", durationMs: 800 }), { theme });
		const errorFg = hexToAnsi(theme.error);
		assert.ok(lines[0]!.includes(errorFg), "top border must include error fg SGR for failed status");
	});

	test("skipped status uses dim, not success or error", () => {
		const lines = renderNodeCard(makeStage({ status: "skipped", durationMs: 800 }), { theme });
		assert.ok(lines[0]!.includes(hexToAnsi(theme.dim)));
		assert.equal(lines[0]!.includes(hexToAnsi(theme.success)), false);
		assert.equal(lines[0]!.includes(hexToAnsi(theme.error)), false);
	});

	test("focused running stage locks the border to warning (not pulsing lerp)", () => {
		const lines = renderNodeCard(makeStage({ status: "running", startedAt: Date.now() - 500 }), {
			theme,
			focused: true,
			pulsePhase: 0 /* trough of the lerp */,
		});
		const warningFg = hexToAnsi(theme.warning);
		assert.ok(lines[0]!.includes(warningFg), "focused running border must lock at warning regardless of pulse phase");
	});

	test("awaiting_input status uses info border and response hint copy", () => {
		const lines = renderNodeCard(makeStage({ status: "awaiting_input", startedAt: Date.now() - 1000 }), {
			theme,
			focused: true,
		});
		const infoFg = hexToAnsi(theme.info);
		assert.ok(lines[0]!.includes(infoFg), "awaiting input border must use info token");
		const rendered = stripAnsi(lines.join("\n"));
		assert.match(rendered, /waiting for response/);
		assert.match(rendered, /↵ enter to respond/);
	});

	test("focused pending stage lifts to borderActive (not text)", () => {
		const lines = renderNodeCard(makeStage({ status: "pending" }), {
			theme,
			focused: true,
		});
		const borderActiveFg = hexToAnsi(theme.borderActive);
		assert.ok(lines[0]!.includes(borderActiveFg), "focused pending border must use borderActive token");
		// The previous behaviour used `theme.text` as the border colour;
		// make sure we didn't regress to that even though the tab still
		// uses bold + accent bg.
		const sequencesOnTop = topRowAnsiSequences(lines[0]!);
		const textFg = hexToAnsi(theme.text);
		// text may legitimately appear if accent bg is missing, so this
		// assertion only fires when neither accent bg nor borderActive
		// is doing the focus work — should never happen.
		if (!lines[0]!.includes(hexBg(theme.accent))) {
			assert.ok(!sequencesOnTop.includes(textFg), "fallback path must not use theme.text as border colour");
		}
	});

	test("blocked status uses dim border and renders cascade badge", () => {
		const lines = renderNodeCard(makeStage({ status: "blocked", blockedByStageId: "review-a" }), {
			theme,
			stages: [makeStage({ id: "review-a", name: "review-a" })],
		});
		const dimFg = hexToAnsi(theme.dim);
		assert.ok(lines[0]!.includes(dimFg), "blocked border must use dim warning tint");
		assert.match(stripAnsi(lines[1]!), /↑ blocked by review-a/);
	});

	test("blocked badge drops upstream first when the card is narrow", () => {
		const lines = renderNodeCard(
			makeStage({
				status: "blocked",
				blockedByStageId: "very-long-upstream-stage",
			}),
			{
				theme,
				width: 12,
				stages: [
					makeStage({
						id: "very-long-upstream-stage",
						name: "very-long-upstream-stage",
					}),
				],
			},
		);
		const row = stripAnsi(lines[1]!);
		assert.match(row, /↑ blocked/);
		assert.doesNotMatch(row, /very-long-upstream-stage/);
	});

	test("paused status renders a single pause icon", () => {
		const lines = renderNodeCard(makeStage({ status: "paused" }), { theme });
		const rendered = stripAnsi(lines.join("\n"));
		const pauseIconCount = rendered.match(/❚❚/g)?.length ?? 0;

		assert.equal(pauseIconCount, 1);
		assert.match(rendered, /❚❚ paused/);
	});
});

describe("renderNodeCard — metadata line", () => {
	test("stages hide model metadata and keep fallback geometry", () => {
		const lines = renderNodeCard(makeStage({ status: "completed", durationMs: 1200, model: "gpt-5-mini" }), {
			theme,
		});
		const rendered = stripAnsi(lines.join("\n"));

		assert.doesNotMatch(rendered, /gpt-5-mini/);
		assert.match(stripAnsi(lines[3]!), /root/);
		assert.equal(lines.length, NODE_H);
		for (const line of lines) {
			assert.equal(stripAnsi(line).length, NODE_W);
		}
	});

	test("labels legacy reconstructed topology as unavailable rather than root", () => {
		const lines = renderNodeCard(makeStage({ status: "completed", topologyState: "unavailable", fastMode: true }), {
			theme,
		});
		const metadata = stripAnsi(lines[3]!).slice(1, -1).trim();
		assert.equal(metadata, "topology unavailable");
	});

	test("running stages use dependency metadata instead of model metadata", () => {
		const lines = renderNodeCard(
			makeStage({
				status: "running",
				parentIds: ["build"],
				startedAt: Date.now() - 1000,
				model: "gpt-5-mini",
			}),
			{ theme },
		);

		const rendered = stripAnsi(lines.join("\n"));
		assert.doesNotMatch(rendered, /gpt-5-mini/);
		assert.match(stripAnsi(lines[3]!), /1 dep/);
	});

	test("child workflow boundaries show child workflow and run summary", () => {
		const lines = renderNodeCard(
			makeStage({
				name: "run-child-by-path-select-summary",
				status: "completed",
				durationMs: 0,
				workflowChild: {
					alias: "childByPath",
					workflow: "pr1135-import-child",
					runId: "run_1234567890abcdef",
					status: "completed",
					outputs: { summary: "child:workflow:path:3" },
				},
			}),
			{ theme },
		);

		const rendered = stripAnsi(lines.join("\n"));
		assert.match(rendered, /↳ pr1135-import-child/);
		assert.match(rendered, /✓ complete/);
		// The child run id is never shortened: at node width it wraps across rows,
		// so reassemble the identity rows before asserting the complete value.
		const interior = lines.slice(1, -1).map((line) => stripAnsi(line).replaceAll("│", "").trim());
		assert.ok(interior.slice(0, 2).join("").includes("run run_1234567890abcdef"));
		assert.match(rendered, /· 1 out/);
		assert.doesNotMatch(stripAnsi(lines[1]!), /0ms|—/);
	});

	test("keeps full child-run UUIDs and intact suffix tokens within fixed geometry", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const cases: Array<{ label: string; stage: StageSnapshot; suffix: string }> = [
			{
				label: "live",
				stage: makeStage({
					status: "running",
					workflowChildRun: { alias: "child", workflow: "publish-child", runId },
				}),
				suffix: "· live",
			},
			{
				label: "one output",
				stage: makeStage({
					status: "completed",
					workflowChild: {
						alias: "child",
						workflow: "publish-child",
						runId,
						status: "completed",
						outputs: { artifact: "ready" },
					},
				}),
				suffix: "· 1 out",
			},
			{
				label: "three outputs",
				stage: makeStage({
					status: "completed",
					workflowChild: {
						alias: "child",
						workflow: "publish-child",
						runId,
						status: "completed",
						outputs: { artifact: "ready", checksum: "ok", notes: "done" },
					},
				}),
				suffix: "· 3 outs",
			},
		];

		for (const { label, stage, suffix } of cases) {
			const lines = renderNodeCard(stage, { theme });
			const interior = lines
				.slice(1, -1)
				.map((line) => stripAnsi(line).replaceAll("│", "").trim())
				.join("");
			const rendered = stripAnsi(lines.join("\n"));
			assert.equal(lines.length, NODE_H, label);
			assert.ok(interior.includes(runId), `${label}: ${interior}`);
			assert.ok(interior.endsWith(suffix), `${label}: ${interior}`);
			assert.match(rendered, /publish-child/, label);
			assert.match(
				rendered,
				new RegExp(
					stage.status === "running" ? `${statusIcon("running")} running` : `${statusIcon("completed")} complete`,
				),
				label,
			);
			assert.doesNotMatch(rendered, /…/, label);
		}
	});

	test("stages show a visible fast marker without mutating model metadata", () => {
		const lines = renderNodeCard(makeStage({ status: "completed", model: "openai/gpt-5.1-codex", fastMode: true }), {
			theme,
		});
		const rendered = stripAnsi(lines.join("\n"));

		assert.doesNotMatch(rendered, /openai\/gpt-5\.1-codex fast/);
		assert.match(stripAnsi(lines[3]!), /root · fast/);
	});
});

describe("renderNodeCard — duration line", () => {
	test("emits an em-dash when the stage has no timing data", () => {
		const lines = renderNodeCard(makeStage({ status: "pending" }), { theme });
		const body = stripAnsi(lines[1]!);
		assert.match(body, /—/);
	});

	test("renders fmtDuration output when durationMs is present", () => {
		const lines = renderNodeCard(makeStage({ status: "completed", durationMs: 65_000 }), { theme });
		const body = stripAnsi(lines[1]!);
		// fmtDuration(65000) → "1m 5s" (per status-helpers.ts).
		assert.match(body, /1m 5s/);
	});

	test("freezes terminal duration using endedAt when durationMs is missing", () => {
		const originalNow = Date.now;
		try {
			Date.now = () => 71_000;
			const lines = renderNodeCard(makeStage({ status: "completed", startedAt: 1_000, endedAt: 11_000 }), { theme });
			const body = stripAnsi(lines[1]!);
			assert.match(body, /10s/);
			assert.doesNotMatch(body, /1m/);
		} finally {
			Date.now = originalNow;
		}
	});

	test("freezes the duration line while paused and resumes active elapsed time", () => {
		const originalNow = Date.now;
		try {
			Date.now = () => 71_000;
			const paused = renderNodeCard(makeStage({ status: "paused", startedAt: 1_000, pausedAt: 11_000 }), { theme });
			assert.match(stripAnsi(paused[1]!), /10s/);
			assert.doesNotMatch(stripAnsi(paused[1]!), /1m/);

			Date.now = () => 76_000;
			const resumed = renderNodeCard(
				makeStage({
					status: "running",
					startedAt: 1_000,
					pausedDurationMs: 60_000,
					resumedAt: 71_000,
				}),
				{ theme },
			);
			assert.match(stripAnsi(resumed[1]!), /15s/);
		} finally {
			Date.now = originalNow;
		}
	});
});
