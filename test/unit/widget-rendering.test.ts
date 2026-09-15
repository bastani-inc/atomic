/**
 * Unit tests for the background-workflow widget.
 *
 * Visual contract:
 *   - One transparent rounded `BACKGROUND` panel with `N runs` subtitle and
 *     status-icon count badges in the title.
 *   - Two-line ordinary entry per run (status glyph + full id on line 1;
 *     workflow name and dim mode · progress · duration on line 2).
 *   - Four-line awaiting-input entry adds a quoted prompt and exact connect
 *     action after the ordinary identity rows.
 *   - Hides entirely (returns []) when no active or recently-ended runs.
 *
 * cross-ref: src/tui/widget.ts · orchestrator-panel-ui.png · DESIGN.md §5
 */

import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import { runIndicatorStatus, visibleRunTreeMembers } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import {
	pendingInputAffordance,
	sanitizePromptDisplay,
} from "../../packages/workflows/src/tui/pending-input-affordance.js";
import { statusColor, statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import {
	buildThemedWidgetLines,
	formatDuration,
	nextWidgetRefreshDelayMs,
	RECENT_ENDED_WINDOW_MS,
	renderWidgetLines,
} from "../../packages/workflows/src/tui/widget.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
	id: string,
	name: string,
	status: StageSnapshot["status"],
	extras: Partial<StageSnapshot> = {},
): StageSnapshot {
	return { id, name, status, parentIds: [], toolEvents: [], ...extras };
}

function makeRun(
	id: string,
	name: string,
	status: RunSnapshot["status"],
	stages: StageSnapshot[] = [],
	startedAt = Date.now() - 5000,
	endedAt?: number,
): RunSnapshot {
	return {
		id,
		name,
		inputs: {},
		status,
		stages,
		startedAt,
		endedAt,
		durationMs: endedAt !== undefined ? endedAt - startedAt : undefined,
	};
}

function makeSnap(runs: RunSnapshot[]): StoreSnapshot {
	return { runs, notices: [], version: 1 };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

const NULL_PI_THEME = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
	test("< 60 s → just seconds", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(5000), "5s");
		assert.equal(formatDuration(59_000), "59s");
	});

	test(">= 60 s → minutes + seconds (no trailing 0s)", () => {
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(84_000), "1m 24s");
		assert.equal(formatDuration(3540_000), "59m");
	});

	test(">= 1 hour → hours + minutes (no trailing 0m)", () => {
		assert.equal(formatDuration(3600_000), "1h");
		assert.equal(formatDuration(3720_000), "1h 2m");
	});

	test("negative ms is clamped to zero", () => {
		assert.equal(formatDuration(-100), "0s");
	});
});

// ---------------------------------------------------------------------------
// renderWidgetLines — empty + hidden states
// ---------------------------------------------------------------------------

describe("renderWidgetLines — hidden states", () => {
	test("no runs → empty array (widget hides)", () => {
		assert.deepEqual(renderWidgetLines(makeSnap([])), []);
	});

	test("all runs ended over 30s ago → empty array", () => {
		const now = Date.now();
		const snap = makeSnap([makeRun("r1", "wf", "completed", [], now - 90_000, now - 60_000)]);
		assert.deepEqual(renderWidgetLines(snap), []);
	});
});

// ---------------------------------------------------------------------------
// renderWidgetLines — standard form (≥ 80 cols)
// ---------------------------------------------------------------------------

describe("renderWidgetLines — standard form", () => {
	test("single active run → rounded panel + 2-line entry (4 lines total)", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const snap = makeSnap([makeRun(runId, "my-wf", "running")]);
		const lines = renderWidgetLines(snap, 120).map(stripAnsi);
		// top border + 2 content rows + bottom border = 4 total
		assert.equal(lines.length, 4);
		assert.ok(lines[0]!.includes("BACKGROUND"), "header should include BACKGROUND label");
		assert.ok(lines[0]!.includes("1 run"), "header should include 1 run subtitle");
		assert.ok(lines[1]!.includes(runId), "line 1 should include the complete run id");
		assert.ok(!lines[1]!.includes("my-wf"), "line 1 should contain only status and id");
		assert.ok(lines[2]!.includes("my-wf · single"), "line 2 should join the workflow name and meta");
	});

	test("zero-stage tool-only run renders its live durable ctx.tool node in the BACKGROUND panel", () => {
		const run: RunSnapshot = {
			...makeRun("tool-only-run", "publish-release", "running"),
			toolNodes: [
				{
					kind: "tool",
					id: "tool:publish-watcher",
					name: "publish-watcher",
					argsHash: "watcher-hash",
					ordinal: 0,
					parentIds: [],
					status: "running",
					startedAt: Date.now() - 1_000,
					attachable: false,
				},
			],
		};

		const normalLines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
		const normal = normalLines.join("\n");
		assert.match(normal, /BACKGROUND/);
		assert.match(normal, /publish-watcher · running/);
		assert.doesNotMatch(normal, /0\/0/);
		assert.ok(normalLines.every((line) => visibleWidth(line) <= 120));

		const narrow = renderWidgetLines(makeSnap([run]), 60).map(stripAnsi);
		assert.deepEqual(narrow, [" ▾  1 background · 1 ● · 1 tool"]);
	});

	test("width-80 tool-only card keeps the live-tool total visible when node details clip", () => {
		const run: RunSnapshot = {
			...makeRun("tool-only-run", "global-publish-watch", "running"),
			toolNodes: [
				{
					kind: "tool",
					id: "tool:publish-watcher",
					name: "publish-watcher",
					argsHash: "watcher-hash",
					ordinal: 0,
					parentIds: [],
					status: "running",
					startedAt: Date.now() - 1_000,
					attachable: false,
				},
				{
					kind: "tool",
					id: "tool:release-verification",
					name: "release-verification",
					argsHash: "verification-hash",
					ordinal: 1,
					parentIds: [],
					status: "pending",
					startedAt: Date.now() - 500,
					attachable: false,
				},
			],
		};

		const lines = renderWidgetLines(makeSnap([run]), 80).map(stripAnsi);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
		assert.match(lines.join("\n"), /2 tools/);
	});

	test("retained killed and quit cards remain visible but contribute no live tools", () => {
		const now = Date.now();
		for (const status of ["pending", "running"] as const) {
			const retainedTool: NonNullable<RunSnapshot["toolNodes"]>[number] = {
				kind: "tool",
				id: `tool:retained-${status}`,
				name: `retained-${status}`,
				argsHash: `retained-${status}-hash`,
				ordinal: 0,
				parentIds: [],
				status,
				startedAt: now - 2_000,
				attachable: false,
			};
			const killed: RunSnapshot = {
				...makeRun(`killed-${status}`, `killed-${status}-publish`, "killed", [], now - 4_000, now - 500),
				toolNodes: [retainedTool],
			};
			const quit: RunSnapshot = {
				...makeRun(`quit-${status}`, `quit-${status}-publish`, "paused", [], now - 5_000),
				exitReason: "quit",
				quitAt: now - 400,
				resumable: true,
				toolNodes: [{ ...retainedTool, id: `tool:quit-${status}` }],
			};

			const killedWide = renderWidgetLines(makeSnap([killed]), 120)
				.map(stripAnsi)
				.join("\n");
			assert.match(killedWide, new RegExp(`killed-${status}-publish`));
			assert.doesNotMatch(killedWide, new RegExp(`retained-${status} · ${status}`));
			const killedNarrow = renderWidgetLines(makeSnap([killed]), 60).map(stripAnsi);
			assert.deepEqual(killedNarrow, [" ▾  1 background · 0 ●"]);
			assert.notEqual(killedNarrow[0], " ▾  1 background · 0 ● · 1 tool");

			const quitWide = renderWidgetLines(makeSnap([quit]), 120)
				.map(stripAnsi)
				.join("\n");
			assert.match(quitWide, new RegExp(`quit-${status}-publish`));
			assert.doesNotMatch(quitWide, new RegExp(`retained-${status} · ${status}`));
			assert.deepEqual(renderWidgetLines(makeSnap([quit]), 60).map(stripAnsi), [" ▾  1 background · 0 ● · 1 quit"]);
		}
	});

	test("active pending and running tool nodes both contribute to the live aggregate", () => {
		const now = Date.now();
		const active: RunSnapshot = {
			...makeRun("active-tools", "active-publish", "running", [], now - 3_000),
			toolNodes: [
				{
					kind: "tool",
					id: "tool:pending-watcher",
					name: "pending-watcher",
					argsHash: "pending-hash",
					ordinal: 0,
					parentIds: [],
					status: "pending",
					startedAt: now - 2_000,
					attachable: false,
				},
				{
					kind: "tool",
					id: "tool:running-watcher",
					name: "running-watcher",
					argsHash: "running-hash",
					ordinal: 1,
					parentIds: [],
					status: "running",
					startedAt: now - 1_000,
					attachable: false,
				},
			],
		};

		const wide = renderWidgetLines(makeSnap([active]), 120)
			.map(stripAnsi)
			.join("\n");
		assert.match(wide, /pending-watcher · pending/);
		assert.match(wide, /running-watcher · running/);
		assert.deepEqual(renderWidgetLines(makeSnap([active]), 60).map(stripAnsi), [" ▾  1 background · 1 ● · 2 tools"]);
	});
	test("quit run renders resumable quit badge and note", () => {
		const run: RunSnapshot = {
			...makeRun("quit1234", "resume-me", "paused"),
			exitReason: "quit",
			resumable: true,
		};
		const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.ok(lines[0]!.includes("BACKGROUND  1 run  1 quit"));
		assert.ok(joined.includes("quit · resumable via /workflow resume"));
	});
	test("quit run with a pending prompt keeps quit treatment and is excluded from needs-attention count", () => {
		const now = 10_000;
		const theme = deriveGraphTheme({});
		const quit: RunSnapshot = {
			...makeRun("quit-with-prompt", "resume-me", "paused", [], now - 1_000),
			exitReason: "quit",
			resumable: true,
			pendingPrompt: {
				id: "quit-prompt",
				kind: "confirm",
				message: "Continue?",
				createdAt: now - 100,
			},
		};
		const lines = buildThemedWidgetLines(makeSnap([quit]), NULL_PI_THEME, 120, now);
		const joined = lines.join("\n");
		assert.ok(joined.includes(statusIcon("pending")), "quit card keeps the pending glyph");
		assert.ok(
			joined.includes(hexToAnsi(statusColor(quit.status, theme))),
			"quit card keeps the paused warning colour",
		);
		assert.doesNotMatch(stripAnsi(lines[0]!), /needs attention/);
		assert.ok(stripAnsi(lines[0]!).includes("1 quit"), "quit count remains visible");
	});
	test("quitting a pending input removes answer actions while preserving its resumable descriptor", () => {
		// Regression #2700: a real ctx.ui.input retains its descriptor after /workflow quit.
		const now = 10_000;
		const store = createStore();
		const runId = "quit-stage-prompt";
		const stage = makeStage("input-stage", "input", "running");
		store.recordRunStart(makeRun(runId, "resume-me", "running", [stage], now - 1_000));
		store.recordStagePendingPrompt(runId, stage.id, {
			id: "retained-prompt",
			kind: "input",
			message: "Which synthetic constellation?",
			createdAt: now - 100,
		});
		assert.match(
			buildThemedWidgetLines(store.snapshot(), NULL_PI_THEME, 120, now).join("\n"),
			/Answer: \/workflow connect/,
		);
		assert.equal(store.recordStagePaused(runId, stage.id), true);
		assert.equal(store.recordRunPaused(runId, now, { exitReason: "quit", resumable: true }), true);

		const output = buildThemedWidgetLines(store.snapshot(), NULL_PI_THEME, 120, now).map(stripAnsi).join("\n");
		assert.match(output, /quit · resumable via \/workflow resume/);
		assert.doesNotMatch(output, /Which synthetic constellation\?|F2 answer|\/workflow connect/);
		assert.equal(store.snapshot().runs[0]!.stages[0]!.pendingPrompt?.id, "retained-prompt");
	});
	test("quit card expires from the widget after the recent window while status stays resumable", () => {
		const originalNow = Date.now;
		let now = 1_000_000;
		Date.now = () => now;
		try {
			const store = createStore();
			const runId = "quit-after-pause";
			store.recordRunStart(makeRun(runId, "resume-me-later", "running", [], now - RECENT_ENDED_WINDOW_MS * 3));
			const pausedAt = now - RECENT_ENDED_WINDOW_MS * 2;
			assert.equal(store.recordRunPaused(runId, pausedAt), true);

			now += RECENT_ENDED_WINDOW_MS / 6;
			const quitAt = now;
			assert.equal(store.recordRunPaused(runId, undefined, { exitReason: "quit", resumable: true }), true);

			const quitRun = store.snapshot().runs[0]!;
			assert.equal(quitRun.status, "paused");
			assert.equal(quitRun.endedAt, undefined);
			assert.equal(quitRun.pausedAt, pausedAt, "quitting must not repurpose pausedAt");
			assert.equal(quitRun.quitAt, quitAt, "expiry must start when the run is quit");
			assert.equal(quitRun.resumable, true);
			assert.ok(
				renderWidgetLines(store.snapshot(), 120)
					.map(stripAnsi)
					.join("\n")
					.includes("quit · resumable via /workflow resume"),
				"a newly quit run should render immediately",
			);

			now = quitAt + RECENT_ENDED_WINDOW_MS + 1;
			assert.deepEqual(renderWidgetLines(store.snapshot(), 120), [], "expired quit card should disappear");

			const status = statusRuns({ store });
			assert.deepEqual(
				status.map((entry) => [entry.runId, entry.status]),
				[[runId, "paused"]],
			);
			assert.equal(store.snapshot().runs[0]!.resumable, true, "expiry must not change resumability");
		} finally {
			Date.now = originalNow;
		}
	});

	test("running run shows chain mode when multi-stage", () => {
		const run = makeRun("xyz000aaaa", "deep-research", "running", [
			makeStage("s1", "scout", "completed"),
			makeStage("s2", "specialist", "running"),
			makeStage("s3", "aggregate", "pending"),
		]);
		const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
		const metaLine = lines[2]!;
		assert.ok(metaLine.includes("chain"), "multi-stage run reads as chain");
		assert.ok(metaLine.includes("1/3"), "progress count includes done/total");
	});
	// PR #2969, review r3974468770: retained history must be indexed once, not once per card.
	test("shares expansion preparation across roots and refreshes it as nested runs change", () => {
		const now = 100_000;
		const store = createStore();
		for (const id of ["alpha", "beta"]) {
			store.recordRunStart(
				makeRun(id, id, "running", [
					// A local input wait avoids unrelated descendant-indicator scans in this cost assertion.
					makeStage("question", "question", "awaiting_input"),
					makeStage("import", "nested", "running", {
						workflowChildRun: { runId: `${id}-child`, alias: "nested", workflow: "nested" },
					}),
				]),
			);
		}
		const addChild = (id: string) =>
			store.recordRunStart({
				...makeRun(`${id}-child`, "nested", "running", [
					makeStage("done", "done", "completed"),
					makeStage("work", "work", "running"),
				]),
				parentRunId: id,
				parentStageId: "import",
				rootRunId: id,
				toolNodes: [
					{
						kind: "tool",
						id: "tool:cached",
						name: "cached",
						argsHash: "cached",
						ordinal: 0,
						parentIds: [],
						status: "cached",
						attachable: false,
					},
				],
			});
		const assertProgress = (alpha: string, beta: string) => {
			for (const theme of [undefined, NULL_PI_THEME]) {
				const retained = Array.from({ length: 32 }, (_, index) =>
					makeRun(`old-${index}`, "retained", "completed", [], 1_000, 2_000),
				);
				const snap = store.graphSnapshot();
				const runs = [...snap.runs, ...retained];
				// PR #2700: strict prompt ownership also reads IDs. Measure graph-index
				// preparation separately from those existing attribution scans.
				const indexPreparations = vi.spyOn(runs, "map");
				const lines = buildThemedWidgetLines({ ...snap, runs }, theme, 120, now)
					.map(stripAnsi)
					.join("\n");
				assert.match(lines, /BACKGROUND {2}2 runs /);
				assert.ok(lines.includes(`alpha · chain · ${alpha}`), lines);
				assert.ok(lines.includes(`beta · chain · ${beta}`), lines);
				assert.equal(indexPreparations.mock.calls.length, 1, "one full run-index preparation per render pass");
				indexPreparations.mockRestore();
			}
		};
		addChild("beta");
		assertProgress("0/2", "1/3");
		addChild("alpha");
		assertProgress("1/3", "1/3");
		store.recordStageEnd("alpha-child", makeStage("work", "work", "completed"));
		assertProgress("2/3", "1/3");
		store.recordStageStart("beta-child", makeStage("next", "next", "running"));
		assertProgress("2/3", "1/4");
	});

	test("recursive stage progress updates as child graphs materialize without counting their boundaries", () => {
		const now = 10_000;
		const store = createStore();
		const boundary = (id: string, childId: string) =>
			makeStage(id, "shared-alias", "running", {
				workflowChildRun: { runId: childId, alias: "shared-alias", workflow: "nested" },
			});
		store.recordRunStart(makeRun("root", "pr-fix-green-and-merge", "running", [boundary("import", "child")], 1_000));
		const assertProgress = (expected: string) => {
			for (const theme of [undefined, NULL_PI_THEME]) {
				for (const width of [80, 120]) {
					const lines = buildThemedWidgetLines(store.graphSnapshot(), theme, width, now).map(stripAnsi);
					assert.ok(lines[2]!.includes(`pr-fix-green-and-merge · ${expected} · 9s`), lines.join("\n"));
					assert.match(lines[0]!, /BACKGROUND {2}1 run /);
					assert.equal(lines.length, 4, "child runs must not become separate list entries");
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
			}
		};
		assertProgress("single · 0/1");
		store.recordRunStart({
			...makeRun("child", "nested", "running", [
				makeStage("same", "work", "completed"),
				boundary("import", "grandchild"),
			]),
			parentRunId: "root",
			parentStageId: "import",
			rootRunId: "root",
		});
		assertProgress("chain · 1/2");
		store.recordRunStart({
			...makeRun("grandchild", "nested", "running", [
				makeStage("same", "work", "failed"),
				boundary("import", "great-grandchild"),
			]),
			parentRunId: "child",
			parentStageId: "import",
			rootRunId: "root",
		});
		assertProgress("chain · 2/3");
		store.recordRunStart({
			...makeRun("great-grandchild", "nested", "running", [
				makeStage("same", "work", "skipped"),
				makeStage("active", "work", "running"),
				makeStage("waiting", "work", "pending"),
			]),
			parentRunId: "grandchild",
			parentStageId: "import",
			rootRunId: "root",
		});
		assertProgress("chain · 3/5");
		store.recordStageEnd("great-grandchild", makeStage("active", "work", "completed"));
		assertProgress("chain · 4/5");
	});
	test("recursive progress preserves retained completion metadata across snapshot restore and resume", () => {
		const replayBoundary = (id: string, childId: string) =>
			makeStage(id, "shared-alias", "completed", {
				workflowChild: {
					runId: childId,
					alias: "shared-alias",
					workflow: "nested",
					status: "completed",
					outputs: {},
				},
				workflowChildRun: { runId: "stale-child", alias: "shared-alias", workflow: "nested" },
			});
		const root = makeRun("root", "retained-tree", "paused", [replayBoundary("import", "child")], 1_000);
		const child: RunSnapshot = {
			...makeRun(
				"child",
				"nested",
				"completed",
				[makeStage("same", "work", "completed"), replayBoundary("import", "grandchild")],
				1_000,
				2_000,
			),
			parentRunId: "root",
			parentStageId: "import",
			rootRunId: "root",
		};
		const grandchild: RunSnapshot = {
			...makeRun(
				"grandchild",
				"nested",
				"completed",
				[makeStage("same", "work", "completed"), makeStage("skipped", "work", "skipped")],
				1_000,
				2_000,
			),
			parentRunId: "child",
			parentStageId: "import",
			rootRunId: "root",
			toolNodes: [
				{
					kind: "tool",
					id: "tool:cached",
					name: "cached",
					argsHash: "cached",
					ordinal: 0,
					parentIds: [],
					status: "cached",
					attachable: false,
				},
			],
		};
		const store = createStore();
		for (const run of structuredClone([root, child, grandchild])) store.recordRunStart(run);
		const render = () => buildThemedWidgetLines(store.graphSnapshot(), NULL_PI_THEME, 120).map(stripAnsi).join("\n");
		assert.match(render(), /retained-tree · chain · 3\/3/);
		assert.equal(store.recordRunResumed("root"), true);
		assert.match(render(), /retained-tree · chain · 3\/3/);
		store.recordStageStart("root", makeStage("next", "next", "running"));
		assert.match(render(), /retained-tree · chain · 3\/4/);
		assert.equal(store.runs()[0]!.stages[0]!.id, "import", "rendering must not replace stored boundaries");
	});
	test("recursive progress retains failed, skipped and aliased boundary summaries instead of counting stale children", () => {
		for (const status of ["failed", "skipped", "running"] as const) {
			const boundary = makeStage("import", "shared-alias", status, {
				workflowChildRun: { runId: "child", alias: "shared-alias", workflow: "nested" },
			});
			const root = makeRun("root", "boundary-fallback", "running", [boundary]);
			const child: RunSnapshot = {
				...makeRun("child", "nested", "running", [
					makeStage("same", "work", "completed"),
					makeStage("other", "work", "pending"),
				]),
				parentRunId: "root",
				parentStageId: "import",
				rootRunId: "root",
			};
			if (status === "running") root.stages.push({ ...boundary, id: "alias" });
			const text = buildThemedWidgetLines(makeSnap([root, child]), undefined, 120).join("\n");
			assert.match(
				text,
				status === "running" ? /boundary-fallback · chain · 1\/3/ : /boundary-fallback · single · 1\/1/,
			);
		}
	});
	test("active recoverable block renders as blocked and resumable, not running", () => {
		const run: RunSnapshot = {
			...makeRun("blocked1", "recoverable-auth", "running", [makeStage("s1", "provider", "failed")]),
			blockedAt: Date.now(),
			error: "Configure credentials and resume.",
			failureKind: "auth",
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
			failureMessage: "No API key for provider",
			resumable: true,
		};
		const snapshot = makeSnap([run]);
		const lines = renderWidgetLines(snapshot, 120).map(stripAnsi);
		const text = lines.join("\n");

		assert.match(lines[0] ?? "", /↑ 1 blocked/u);
		assert.doesNotMatch(lines[0] ?? "", /running/u);
		assert.match(text, /recoverable-auth · blocked · resumable via \/workflow resume/u);
		assert.match(text, /blocked · resumable via \/workflow resume/u);
		assert.equal(nextWidgetRefreshDelayMs(snapshot), undefined);
	});

	test("multiple active runs → header subtitle pluralises, entries stacked with blank separators", () => {
		const t = Date.now();
		const r1 = makeRun("aaa111zzz", "wf-one", "running", [], t - 2000);
		const r2 = makeRun("bbb222zzz", "wf-two", "running", [], t - 100);
		const lines = renderWidgetLines(makeSnap([r1, r2]), 120).map(stripAnsi);
		assert.ok(lines[0]!.includes("2 runs"));
		const joined = lines.join("\n");
		assert.ok(joined.includes("wf-one"));
		assert.ok(joined.includes("wf-two"));
		// Most-recently-started run is shown first.
		const wfTwoIdx = lines.findIndex((l) => l.includes("wf-two"));
		const wfOneIdx = lines.findIndex((l) => l.includes("wf-one"));
		assert.ok(wfTwoIdx < wfOneIdx, "most recently started run renders first");
	});
	test("more than four concurrent runs all render without truncation", () => {
		const now = Date.now();
		const runs = Array.from({ length: 6 }, (_, index) =>
			makeRun(`run-${index}-abcdef`, `wf-${index}`, "running", [], now - (6 - index) * 100),
		);
		const lines = renderWidgetLines(makeSnap(runs), 120).map(stripAnsi);
		const joined = lines.join("\n");

		assert.ok(lines[0]!.includes("6 runs"));
		for (let index = 0; index < runs.length; index++) {
			assert.ok(joined.includes(`wf-${index}`), `workflow ${index} should render`);
		}
		assert.equal(lines.filter((line) => line.includes("single")).length, 6);
	});

	test("hides reciprocally owned nested child workflow runs, showing only the top-level run", () => {
		const t = Date.now();
		const root = makeRun("root1111", "contract-hil-nested-root", "running", [], t - 3000);
		const parent: RunSnapshot = {
			...makeRun("parent22", "contract-hil-nested-parent", "running", [], t - 2000),
			parentRunId: "root1111",
			parentStageId: "root-to-parent",
			rootRunId: "root1111",
		};
		const child: RunSnapshot = {
			...makeRun("child333", "contract-hil-nested-child", "running", [], t - 1000),
			parentRunId: "parent22",
			parentStageId: "parent-to-child",
			rootRunId: "root1111",
		};
		root.stages.push(
			makeStage("root-to-parent", "parent", "running", {
				workflowChildRun: { alias: "parent", workflow: parent.name, runId: parent.id },
			}),
		);
		parent.stages.push(
			makeStage("parent-to-child", "child", "running", {
				workflowChildRun: { alias: "child", workflow: child.name, runId: child.id },
			}),
		);
		const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		// Only the top-level root is listed; the count reflects one run, not three.
		assert.ok(lines[0]!.includes("1 run"), `expected "1 run" subtitle, got: ${lines[0]}`);
		assert.ok(joined.includes("contract-hil-nested-root"));
		assert.ok(!joined.includes("contract-hil-nested-parent"), "nested parent run must be hidden");
		assert.ok(!joined.includes("contract-hil-nested-child"), "nested child run must be hidden");
	});

	test("surfaces a reciprocally owned hidden nested child's awaiting-input state on the top-level run", () => {
		const t = Date.now();
		// Root is running and blocked on its imported composition; the actual HiL
		// prompt is awaiting in the nested child run, which the widget hides.
		const root = makeRun("root1111", "contract-hil-nested-root", "running", [], t - 3000);
		const parent: RunSnapshot = {
			...makeRun("parent22", "contract-hil-nested-parent", "running", [], t - 2000),
			parentRunId: "root1111",
			parentStageId: "root-to-parent",
			rootRunId: "root1111",
		};
		const child: RunSnapshot = {
			...makeRun(
				"child333",
				"contract-hil-nested-child",
				"running",
				[makeStage("s1", "ask", "awaiting_input")],
				t - 1000,
			),
			parentRunId: "parent22",
			parentStageId: "parent-to-child",
			rootRunId: "root1111",
		};
		root.stages.push(
			makeStage("root-to-parent", "parent", "running", {
				workflowChildRun: { alias: "parent", workflow: parent.name, runId: parent.id },
			}),
		);
		parent.stages.push(
			makeStage("parent-to-child", "child", "running", {
				workflowChildRun: { alias: "child", workflow: child.name, runId: child.id },
			}),
		);
		const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
		const header = lines[0]!;
		// Only the root is listed, but its hidden descendant's awaiting state still
		// raises the "needs attention" badge so the HiL prompt is discoverable.
		assert.ok(header.includes("1 run"), `expected "1 run" subtitle, got: ${header}`);
		assert.ok(
			header.includes("↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
			`expected nested HiL to surface a needs-attention badge, got: ${header}`,
		);
		assert.ok(!lines.join("\n").includes("contract-hil-nested-child"), "nested child stays hidden");
	});

	test("count badges include stage-local awaiting input", () => {
		const awaiting = makeRun("r1xxxxxx", "wf-await", "running", [makeStage("s1", "ask", "awaiting_input")]);
		const lines = renderWidgetLines(makeSnap([awaiting]), 120).map(stripAnsi);
		const header = lines[0]!;
		assert.ok(header.includes("● 1 running"), "run remains active");
		assert.ok(
			header.includes("？ ↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
			"awaiting-input badge is labeled with status and attach action",
		);
	});

	test("count badges reflect status mix", () => {
		const t = Date.now();
		const running = makeRun("r1xxxxxx", "wf-r", "running", [], t - 1000);
		const paused = makeRun("r4xxxxxx", "wf-p", "paused", [], t - 3000);
		const done = makeRun("r2xxxxxx", "wf-d", "completed", [], t - 5000, t - 1000);
		const failed = makeRun("r3xxxxxx", "wf-f", "failed", [], t - 4000, t - 500);
		const lines = renderWidgetLines(makeSnap([running, paused, done, failed]), 120).map(stripAnsi);
		const header = lines[0]!;
		assert.ok(header.includes("● 1 running"), "running badge");
		assert.ok(header.includes("❚❚ 1 paused"), "paused badge");
		assert.ok(header.includes("✓ 1 complete"), "completed badge");
		assert.ok(header.includes("✗ 1 failed"), "failed badge");
	});
	test("expired quit runs do not contribute counts after their cards disappear", () => {
		const now = 1_000_000;
		const active = makeRun("active-run", "still-running", "running", [], now - 1_000);
		const expiredQuit = makeRun("expired-quit", "already-quit", "paused", [], now - RECENT_ENDED_WINDOW_MS * 2);
		expiredQuit.pausedAt = now - RECENT_ENDED_WINDOW_MS * 2;
		expiredQuit.quitAt = now - RECENT_ENDED_WINDOW_MS - 1;
		expiredQuit.exitReason = "quit";
		expiredQuit.resumable = true;
		const snap = makeSnap([active, expiredQuit]);

		const wide = renderWidgetLines(snap, 120).map(stripAnsi);
		assert.ok(wide.join("\n").includes("still-running"));
		assert.ok(wide[0]!.includes("BACKGROUND  1 run"), "wide header total must match its single rendered card");
		assert.ok(!wide[0]!.includes("quit"), "wide quit badge must match rendered cards");

		const collapsed = renderWidgetLines(snap, 60).map(stripAnsi);
		assert.ok(collapsed[0]!.includes("1 background"));
		assert.ok(!collapsed[0]!.includes("quit"), "collapsed quit badge must match rendered cards");
	});

	test("ctx.exit blocked remains distinct from completed exit statuses", () => {
		const t = Date.now();
		const skipped = makeRun("s1xxxxxx", "wf-s", "skipped", [], t - 5000, t - 3000);
		const cancelled = makeRun("c1xxxxxx", "wf-c", "cancelled", [], t - 4000, t - 2000);
		const blocked = makeRun("b1xxxxxx", "wf-b", "blocked", [], t - 3000, t - 1000);
		const lines = renderWidgetLines(makeSnap([skipped, cancelled, blocked]), 120).map(stripAnsi);
		const header = lines[0]!;

		assert.ok(header.includes("3 runs"), `expected exited runs in header total, got: ${header}`);
		assert.ok(header.includes("✓ 2 complete"), `expected completed exit badge, got: ${header}`);
		assert.ok(header.includes("↑ 1 blocked"), `expected blocked exit badge, got: ${header}`);
		assert.ok(lines.join("\n").includes("skipped · 2s"), "skipped row remains visible");
		assert.ok(lines.join("\n").includes("cancelled · 2s"), "cancelled row remains visible");
		assert.ok(lines.join("\n").includes("blocked · 2s"), "blocked row remains visible");
	});

	test("terminal rows render final duration without ticking ago labels", () => {
		const originalNow = Date.now;
		try {
			const startedAt = 1_000;
			const endedAt = 11_000;
			const completed = makeRun("r2xxxxxx", "wf-d", "completed", [], startedAt, endedAt);
			const failed = makeRun("r3xxxxxx", "wf-f", "failed", [], startedAt, endedAt);
			const killed = makeRun("r4xxxxxx", "wf-k", "killed", [], startedAt, endedAt);
			completed.durationMs = undefined;
			failed.durationMs = undefined;
			killed.durationMs = undefined;

			Date.now = () => 12_000;
			const at12s = renderWidgetLines(makeSnap([completed, failed, killed]), 120)
				.map(stripAnsi)
				.join("\n");
			Date.now = () => 29_000;
			const at29s = renderWidgetLines(makeSnap([completed, failed, killed]), 120)
				.map(stripAnsi)
				.join("\n");

			assert.match(at12s, /complete · 10s/);
			assert.match(at12s, /failed · 10s/);
			assert.match(at12s, /killed · 10s/);
			assert.doesNotMatch(at12s, /ago/);
			assert.equal(at29s, at12s);
		} finally {
			Date.now = originalNow;
		}
	});

	test("paused run renders pause status and frozen active elapsed time", () => {
		const originalNow = Date.now;
		try {
			Date.now = () => 71_000;
			const paused = makeRun("r4xxxxxx", "wf-p", "paused", [], 1_000);
			paused.pausedAt = 11_000;
			const lines = renderWidgetLines(makeSnap([paused]), 120).map(stripAnsi);
			assert.ok(lines.join("\n").includes("❚❚"), "paused glyph");
			assert.ok(lines[0]!.includes("❚❚ 1 paused"), "paused badge");
			assert.match(lines[2]!, /10s/);
			assert.doesNotMatch(lines[2]!, /1m/);

			Date.now = () => 76_000;
			const later = renderWidgetLines(makeSnap([paused]), 120).map(stripAnsi);
			assert.equal(later[2], lines[2]);
		} finally {
			Date.now = originalNow;
		}
	});

	test("terminal and fully paused widgets do not schedule second-boundary refreshes", () => {
		const now = 1_000_000;
		const terminal = makeRun("r2xxxxxx", "wf-d", "completed", [], now - 20_000, now - 10_000);
		const terminalDelay = nextWidgetRefreshDelayMs(makeSnap([terminal]), now);
		assert.equal(terminalDelay, RECENT_ENDED_WINDOW_MS - 10_000 + 1);

		const paused = makeRun("r4xxxxxx", "wf-p", "paused", [], now - 20_000);
		paused.pausedAt = now - 5_000;
		assert.equal(nextWidgetRefreshDelayMs(makeSnap([paused]), now), undefined);
	});

	test("active runs schedule the next exact elapsed-second refresh", () => {
		const now = 1_000_000;
		const active = makeRun("r1xxxxxx", "wf-a", "running", [], now - 5_000);
		assert.equal(nextWidgetRefreshDelayMs(makeSnap([active]), now), 1_000);

		const offsetActive = makeRun("r3xxxxxx", "wf-b", "running", [], now - 5_250);
		assert.equal(nextWidgetRefreshDelayMs(makeSnap([offsetActive]), now), 750);

		const ended = makeRun("r2xxxxxx", "wf-d", "completed", [], now - 20_000, now - 10_000);
		assert.equal(nextWidgetRefreshDelayMs(makeSnap([offsetActive, ended]), now), 750);
	});
	test("quit runs schedule the expiry repaint from quitAt", () => {
		const now = 1_000_000;
		const quitAt = now - RECENT_ENDED_WINDOW_MS / 6;
		const quit = makeRun("quit-refresh", "wf-quit", "paused", [], now - RECENT_ENDED_WINDOW_MS * 2);
		quit.pausedAt = now - RECENT_ENDED_WINDOW_MS * 2;
		quit.quitAt = quitAt;
		quit.exitReason = "quit";
		quit.resumable = true;

		assert.equal(
			nextWidgetRefreshDelayMs(makeSnap([quit]), now),
			RECENT_ENDED_WINDOW_MS - RECENT_ENDED_WINDOW_MS / 6 + 1,
		);
	});

	test("standard panel scales to the provided terminal width", () => {
		const width = 120;
		const snap = makeSnap([makeRun("abc123uuid", "my-wf", "running")]);
		const lines = renderWidgetLines(snap, width);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}
	});

	test("running run uses static ● glyph, never a braille spinner frame", () => {
		// The widget is the canonical 'workflow status' surface; per DESIGN.md
		// 'no spinners on prompt; no flash' it must render the same static
		// vocabulary as `renderStatusList`/`renderRunDetail` (statusIcon → '●').
		const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const t = Date.now();
		const snap = makeSnap([
			makeRun("r1xxxxxx", "wf-r", "running", [makeStage("s1", "stage-1", "running")], t - 1000),
		]);
		// Sample several `now` offsets — a frame-cycling glyph would land on
		// a different braille character at each tick.
		for (let dt = 0; dt < 800; dt += 80) {
			const lines = renderWidgetLines(snap, 120).map(stripAnsi);
			const joined = lines.join("\n");
			assert.ok(joined.includes("●"), `static ● glyph at +${dt}ms`);
			for (const frame of SPINNER_FRAMES) {
				assert.ok(
					!joined.includes(frame),
					`widget must not emit braille spinner frame ${JSON.stringify(frame)} at +${dt}ms`,
				);
			}
		}
	});
});

describe("pendingInputAffordance", () => {
	test("derives a normalized run-level prompt with a concrete identity", () => {
		const run = makeRun("run-level-owner", "release-docs", "running");
		run.pendingPrompt = {
			id: "run-prompt",
			kind: "confirm",
			message: "  Approve\n\tthis   release?  ",
			createdAt: 1,
		};

		assert.deepEqual(pendingInputAffordance(run, [run]), {
			identity: [run.id, null, "run-prompt"],
			visibleRunId: run.id,
			message: "Approve this release?",
		});
	});

	test("strips CSI, OSC, and leftover C0/C1 from displayable prompt text", () => {
		const run = makeRun("control-owner", "release-docs", "running");
		run.pendingPrompt = {
			id: "control-prompt",
			kind: "confirm",
			message: "  Approve\x1b[2J this\x1b]0;pwned\x07 release?\x07\x08  ",
			createdAt: 1,
		};

		assert.deepEqual(pendingInputAffordance(run, [run]), {
			identity: [run.id, null, "control-prompt"],
			visibleRunId: run.id,
			message: "Approve this release?",
		});
	});

	test("strips 8-bit CSI/OSC, RIS, and line separators without eating following text", () => {
		assert.equal(sanitizePromptDisplay("Keep\x1bc this"), "Keep this");
		assert.equal(sanitizePromptDisplay("Approve\x9b2J this\x9d0;pwned\x07 release?"), "Approve this release?");
		assert.equal(sanitizePromptDisplay("Line\u2028break\u2029now"), "Line break now");
		assert.equal(sanitizePromptDisplay("Approve\x1b[2J this\x1b]0;pwned\x07 release?"), "Approve this release?");
	});

	test("derives stage prompts and gives a pending prompt precedence over inputRequest", () => {
		const run = makeRun("stage-owner", "build-check", "running");
		const stage = makeStage("approve", "approve", "awaiting_input");
		stage.pendingPrompt = {
			id: "primitive-prompt",
			kind: "input",
			message: "Enter the approval note",
			createdAt: 1,
		};
		stage.inputRequest = {
			id: "structured-prompt",
			kind: "ask_user_question",
			questions: [{ question: "Should not be counted twice", options: [] }],
			createdAt: 1,
		};
		run.stages.push(stage);

		assert.deepEqual(pendingInputAffordance(run, [run]), {
			identity: [run.id, stage.id, "primitive-prompt"],
			visibleRunId: run.id,
			message: "Enter the approval note",
		});
	});

	test("derives a single-question structured request", () => {
		const run = makeRun("structured-owner", "readiness", "running", [makeStage("gate", "gate", "awaiting_input")]);
		run.stages[0]!.inputRequest = {
			id: "readiness-request",
			kind: "readiness_gate",
			questions: [{ question: "Ready to continue?", options: [] }],
			createdAt: 1,
		};

		assert.deepEqual(pendingInputAffordance(run, [run]), {
			identity: [run.id, "gate", "readiness-request"],
			visibleRunId: run.id,
			message: "Ready to continue?",
		});
	});

	test("retains a reciprocal nested owner identity while targeting the visible root", () => {
		const root = makeRun("visible-root", "nested-release", "running");
		const child = {
			...makeRun("nested-owner", "hidden-child", "running", [makeStage("child-ask", "ask", "awaiting_input")]),
			parentRunId: root.id,
			parentStageId: "root-to-child",
			rootRunId: root.id,
		};
		root.stages.push(
			makeStage("root-to-child", "child", "running", {
				workflowChildRun: { alias: "child", workflow: child.name, runId: child.id },
			}),
		);
		child.stages[0]!.pendingPrompt = {
			id: "nested-prompt",
			kind: "confirm",
			message: "Continue the child workflow?",
			createdAt: 1,
		};

		assert.deepEqual(pendingInputAffordance(root, [child, root]), {
			identity: [child.id, "child-ask", "nested-prompt"],
			visibleRunId: root.id,
			message: "Continue the child workflow?",
		});
	});

	test("keeps a descriptor-less wait status-only and counts it against a sibling descriptor", () => {
		const sole = makeRun("sole-promptless", "promptless", "running", [
			makeStage("waiting", "waiting", "awaiting_input"),
		]);
		assert.equal(pendingInputAffordance(sole, [sole]), undefined);

		const mixed = makeRun("promptless-root", "promptless-sibling", "running", [
			makeStage("waiting", "waiting", "awaiting_input"),
			makeStage("ask", "ask", "awaiting_input"),
		]);
		mixed.stages[1]!.pendingPrompt = {
			id: "real-prompt",
			kind: "confirm",
			message: "Answer the real prompt",
			createdAt: 1,
		};

		assert.equal(pendingInputAffordance(mixed, [mixed]), undefined);
	});

	test("falls back for empty, multi-question, or multiple prompt occurrences", () => {
		const empty = makeRun("empty-prompt", "empty", "running", [makeStage("ask", "ask", "awaiting_input")]);
		empty.stages[0]!.pendingPrompt = {
			id: "empty",
			kind: "input",
			message: " \n\t",
			createdAt: 1,
		};
		assert.equal(pendingInputAffordance(empty, [empty]), undefined);

		const emptySibling = makeRun("empty-sibling", "empty-sibling", "running", [
			makeStage("empty", "empty", "awaiting_input"),
			makeStage("valid", "valid", "awaiting_input"),
		]);
		emptySibling.stages[0]!.pendingPrompt = { ...empty.stages[0]!.pendingPrompt! };
		emptySibling.stages[1]!.pendingPrompt = {
			id: "valid-sibling-prompt",
			kind: "confirm",
			message: "Valid sibling prompt",
			createdAt: 1,
		};
		assert.equal(pendingInputAffordance(emptySibling, [emptySibling]), undefined);

		const multi = makeRun("multi-question", "multi", "running", [makeStage("ask", "ask", "awaiting_input")]);
		multi.stages[0]!.inputRequest = {
			id: "multi",
			kind: "ask_user_question",
			questions: [
				{ question: "First question", options: [] },
				{ question: "Second question", options: [] },
			],
			createdAt: 1,
		};
		assert.equal(pendingInputAffordance(multi, [multi]), undefined);

		const multiple = makeRun("multiple-prompts", "multiple", "running", [makeStage("ask", "ask", "awaiting_input")]);
		multiple.pendingPrompt = {
			id: "run-prompt",
			kind: "confirm",
			message: "Run prompt",
			createdAt: 1,
		};
		multiple.stages[0]!.pendingPrompt = {
			id: "stage-prompt",
			kind: "confirm",
			message: "Stage prompt",
			createdAt: 1,
		};
		assert.equal(pendingInputAffordance(multiple, [multiple]), undefined);
	});

	test("ignores stale descriptors on terminal or blocked owners", () => {
		for (const status of ["completed", "failed", "blocked"] as const) {
			const run = makeRun(`${status}-owner`, "stale", status, [makeStage("ask", "ask", "awaiting_input")]);
			run.pendingPrompt = {
				id: `${status}-prompt`,
				kind: "confirm",
				message: "Stale prompt",
				createdAt: 1,
			};
			assert.equal(pendingInputAffordance(run, [run]), undefined, `${status} owner must not surface a prompt`);
		}
	});

	test("excludes every terminal stage residue variant and keeps the one live identity", () => {
		for (const status of ["completed", "failed", "skipped"] as const) {
			const marker = makeStage(`${status}-marker`, "marker", status, { awaitingInputSince: 1 });
			const prompt = makeStage(`${status}-prompt`, "prompt", status, {
				pendingPrompt: {
					id: `${status}-pending-prompt`,
					kind: "confirm",
					message: "Stale terminal prompt",
					createdAt: 1,
				},
			});
			const request = makeStage(`${status}-request`, "request", status, {
				inputRequest: {
					id: `${status}-input-request`,
					kind: "ask_user_question",
					questions: [{ question: "Stale terminal question", options: [] }],
					createdAt: 1,
				},
			});

			for (const residue of [marker, prompt, request]) {
				const staleOnly = makeRun(`${status}-${residue.id}`, "terminal-residue", "running", [residue]);
				assert.equal(pendingInputAffordance(staleOnly, [staleOnly]), undefined, `${status} ${residue.id}`);
			}

			const live = makeStage(`${status}-live`, "live", "awaiting_input", {
				pendingPrompt: {
					id: `${status}-live-prompt`,
					kind: "confirm",
					message: "Answer the live prompt",
					createdAt: 2,
				},
			});
			const mixed = makeRun(`${status}-mixed`, "mixed", "running", [marker, prompt, request, live]);
			assert.deepEqual(pendingInputAffordance(mixed, [mixed]), {
				identity: [mixed.id, live.id, `${status}-live-prompt`],
				visibleRunId: mixed.id,
				message: "Answer the live prompt",
			});
		}
	});
});

describe("renderWidgetLines — awaiting-input affordances", () => {
	function awaitingRun(id: string, name: string, message: string, startedAt = Date.now() - 5_000): RunSnapshot {
		const run = makeRun(id, name, "running", [makeStage("ask", "ask", "awaiting_input")], startedAt);
		run.stages[0]!.pendingPrompt = {
			id: `${id}-prompt`,
			kind: "confirm",
			message,
			createdAt: startedAt,
		};
		return run;
	}

	test("renders run-level, stage-level, and structured prompts as four-row waiting cards", () => {
		const runLevel = makeRun("run-level-card", "run-level", "running");
		runLevel.pendingPrompt = {
			id: "run-level-prompt",
			kind: "confirm",
			message: "Approve the run?",
			createdAt: 1,
		};
		const stageLevel = awaitingRun("stage-level-card", "stage-level", "Approve the generated migration?");
		const structured = makeRun("structured-card", "structured", "running", [
			makeStage("gate", "gate", "awaiting_input"),
		]);
		structured.stages[0]!.inputRequest = {
			id: "structured-card-request",
			kind: "readiness_gate",
			questions: [{ question: "Approve the readiness gate?", options: [] }],
			createdAt: 1,
		};

		for (const [run, message] of [
			[runLevel, "Approve the run?"],
			[stageLevel, "Approve the generated migration?"],
			[structured, "Approve the readiness gate?"],
		] as const) {
			const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
			const joined = lines.join("\n");
			assert.equal(lines.length, 6, "waiting cards add exactly two rows to the ordinary card");
			assert.ok(joined.includes(`"${message}"`));
			assert.ok(joined.includes(`Answer: /workflow connect ${run.id}`));
			assert.doesNotMatch(joined, /F2 answer/);
			assert.ok(joined.includes(statusIcon("awaiting_input")));
		}
	});

	test("connect action targets the visible root for reciprocal nested prompts", () => {
		const root = makeRun("nested-visible-root", "nested-root", "running");
		const child = {
			...awaitingRun("nested-hidden-child", "nested-child", "Answer in the child workflow?"),
			parentRunId: root.id,
			parentStageId: "root-to-child",
			rootRunId: root.id,
		};
		root.stages.push(
			makeStage("root-to-child", "child", "running", {
				workflowChildRun: { alias: "child", workflow: child.name, runId: child.id },
			}),
		);
		const lines = renderWidgetLines(makeSnap([child, root]), 120).map(stripAnsi);
		const joined = lines.join("\n");

		assert.ok(joined.includes('"Answer in the child workflow?"'));
		assert.ok(joined.includes(`/workflow connect ${root.id}`));
		assert.ok(!joined.includes(child.id), "the hidden owner id is not substituted for the visible connect target");
	});

	test("keeps a stale-running child behind a completed boundary status-only", () => {
		const root = makeRun("completed-boundary-root", "completed-boundary-root", "running");
		const child = {
			...awaitingRun("stale-running-child", "stale-child", "Stale completed child question?"),
			parentRunId: root.id,
			parentStageId: "root-to-child",
			rootRunId: root.id,
		};
		root.stages.push(
			makeStage("root-to-child", "child", "completed", {
				workflowChild: {
					alias: "child",
					workflow: child.name,
					runId: child.id,
					status: "completed",
					outputs: {},
				},
			}),
		);
		const runs = [root, child];

		assert.deepEqual(visibleRunTreeMembers(root, runs), [root]);
		assert.equal(runIndicatorStatus(root, runs), "running");
		assert.equal(pendingInputAffordance(root, runs), undefined);
		const lines = renderWidgetLines(makeSnap(runs), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.equal(lines.length, 4);
		assert.ok(joined.includes(statusIcon("running")));
		assert.doesNotMatch(joined, /Stale completed child question|F2 answer/);
		assert.ok(!joined.includes(`/workflow connect ${root.id}`));
	});

	test("does not render a connect action for a one-sided nested claimant", () => {
		const root = makeRun("unowned-visible-root", "visible-root", "running");
		const claimant = {
			...awaitingRun("unowned-claimant", "claimant", "Answer the unowned prompt?"),
			parentRunId: root.id,
			parentStageId: "missing-boundary",
			rootRunId: root.id,
		};

		const lines = renderWidgetLines(makeSnap([claimant, root]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.equal(lines.length, 4);
		assert.doesNotMatch(joined, /Answer the unowned prompt|F2 answer/);
		assert.ok(!joined.includes(`/workflow connect ${root.id}`));
	});

	test("does not render prompt or connect semantics for divergent public-store duplicates", () => {
		const store = createStore();
		const root = makeRun("duplicate-widget-root", "duplicate-root", "running", [
			makeStage("to-child", "child", "running", {
				workflowChildRun: { alias: "child", workflow: "child", runId: "duplicate-widget-child" },
			}),
		]);
		const divergent = {
			...awaitingRun("duplicate-widget-child", "divergent-child", "Wrongly attributed prompt"),
			parentRunId: root.id,
			parentStageId: "missing-boundary",
			rootRunId: root.id,
		};
		const canonical = {
			...makeRun("duplicate-widget-child", "canonical-child", "running"),
			parentRunId: root.id,
			parentStageId: "to-child",
			rootRunId: root.id,
		};
		store.recordRunStart(root);
		store.recordRunStart(divergent);
		store.recordRunStart(canonical);
		assert.deepEqual(
			store.runs().map((run) => run.name),
			[root.name, divergent.name, canonical.name],
			"public store preserves both duplicate snapshots and their order",
		);

		const lines = renderWidgetLines(store.snapshot(), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.equal(lines.length, 4);
		assert.doesNotMatch(joined, /Wrongly attributed prompt|F2 answer/);
		assert.ok(!joined.includes(`/workflow connect ${root.id}`));
	});

	test("renders terminal stage residue as ordinary status without question or connect semantics", () => {
		for (const status of ["completed", "failed", "skipped"] as const) {
			const residues = [
				makeStage("marker", "marker", status, { awaitingInputSince: 1 }),
				makeStage("prompt", "prompt", status, {
					pendingPrompt: {
						id: `${status}-widget-prompt`,
						kind: "confirm",
						message: "Stale terminal prompt",
						createdAt: 1,
					},
				}),
				makeStage("request", "request", status, {
					inputRequest: {
						id: `${status}-widget-request`,
						kind: "ask_user_question",
						questions: [{ question: "Stale terminal question", options: [] }],
						createdAt: 1,
					},
				}),
			];

			for (const residue of residues) {
				const run = makeRun(`${status}-${residue.id}-card`, `${status}-${residue.id}`, "running", [residue]);
				const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
				const joined = lines.join("\n");
				assert.equal(lines.length, 4, `${status} ${residue.id}`);
				assert.doesNotMatch(joined, /Stale terminal (prompt|question)|F2 answer/);
				assert.ok(!joined.includes(`/workflow connect ${run.id}`), `${status} ${residue.id}`);
				assert.ok(!joined.includes(statusIcon("awaiting_input")), `${status} ${residue.id}`);
			}
		}
	});

	// #2700: every attention card must have a safe CTA before removing the fallback.
	test("keeps generic header guidance for every status-only and mixed attention case", () => {
		const single = awaitingRun("safe-root", "safe", "Approve safe?");
		const promptless = makeRun("promptless-root", "promptless", "running", [
			makeStage("ask", "ask", "awaiting_input"),
		]);
		const multiple = awaitingRun("multiple-root", "multiple", "First question?");
		multiple.stages.push(
			makeStage("other", "other", "awaiting_input", {
				pendingPrompt: { id: "other-prompt", kind: "confirm", message: "Second question?", createdAt: 1 },
			}),
		);
		const form = makeRun("form-root", "form", "running", [
			makeStage("ask", "ask", "awaiting_input", {
				inputRequest: {
					id: "form-request",
					kind: "ask_user_question",
					questions: [
						{ question: "First field?", options: [] },
						{ question: "Second field?", options: [] },
					],
					createdAt: 1,
				},
			}),
		]);
		for (const theme of [undefined, NULL_PI_THEME]) {
			for (const ambiguous of [promptless, multiple, form]) {
				for (const runs of [[ambiguous], [single, ambiguous], [ambiguous, single]]) {
					const lines = buildThemedWidgetLines(makeSnap(runs), theme, 180).map(stripAnsi);
					assert.ok(
						lines[0]!.includes(
							`？ ↵ ${runs.length} needs attention (attach to workflow with \`/workflow connect\`)`,
						),
					);
					assert.ok(!lines.join("\n").includes(`Answer: /workflow connect ${ambiguous.id}`));
					assert.equal(lines.join("\n").includes(`Answer: /workflow connect ${single.id}`), runs.includes(single));
				}
			}
			for (const runs of [[single], [single, awaitingRun("another-safe", "another", "Approve another?")]]) {
				const lines = buildThemedWidgetLines(makeSnap(runs), theme, 180).map(stripAnsi);
				assert.ok(lines[0]!.includes(`？ ↵ ${runs.length} needs attention`));
				assert.doesNotMatch(lines[0]!, /attach to workflow/);
			}
		}
	});

	test("each safe waiting root advertises only its exact Answer command", () => {
		const first = awaitingRun("first-waiting-root", "first-waiting", "Answer first?", Date.now() - 2_000);
		const second = awaitingRun("second-waiting-root", "second-waiting", "Answer second?", Date.now() - 1_000);
		const lines = renderWidgetLines(makeSnap([first, second]), 120).map(stripAnsi);
		const firstName = lines.findIndex((line) => line.includes("first-waiting ·"));
		const secondName = lines.findIndex((line) => line.includes("second-waiting ·"));
		assert.ok(firstName >= 0 && secondName >= 0);
		const firstAction = lines.slice(firstName).find((line) => line.includes("/workflow connect"));
		const secondAction = lines.slice(secondName).find((line) => line.includes("/workflow connect"));
		assert.ok(firstAction !== undefined && secondAction !== undefined);
		assert.ok(firstAction!.includes(`Answer: /workflow connect ${first.id}`));
		assert.ok(secondAction!.includes(`Answer: /workflow connect ${second.id}`));
		assert.doesNotMatch(lines.join("\n"), /F2 answer|❯|to answer/);
	});

	test("a newer non-awaiting active run leaves the older waiting card's exact command intact", () => {
		const waiting = awaitingRun("older-waiting-root", "older-waiting", "Answer the older run?", Date.now() - 2_000);
		const newer = makeRun("newer-active-root", "newer-active", "running", [], Date.now() - 1_000);
		const lines = renderWidgetLines(makeSnap([waiting, newer]), 120).map(stripAnsi);
		const waitingName = lines.findIndex((line) => line.includes("older-waiting ·"));
		assert.ok(waitingName >= 0);
		const waitingAction = lines.slice(waitingName).find((line) => line.includes("/workflow connect"));
		assert.ok(waitingAction !== undefined);
		assert.doesNotMatch(waitingAction!, /F2 answer/);
	});

	test("keeps prompt and exact command within 80 and 120 cells, with collapsed output below 80", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const run = awaitingRun(
			runId,
			"width-aware-waiting",
			"Approve this generated migration before deployment? This message is intentionally long enough to exercise cell truncation.",
		);

		for (const width of [80, 120]) {
			const lines = renderWidgetLines(makeSnap([run]), width).map(stripAnsi);
			for (const line of lines) assert.equal(visibleWidth(line), width, `line must fill width ${width}`);
			const joined = lines.join("\n");
			assert.ok(joined.includes(`/workflow connect ${runId}`), `full command must survive at width ${width}`);
			const promptLine = lines.find((line) => line.includes('"'));
			assert.match(promptLine ?? "", /".*…"/);
		}

		const collapsed = renderWidgetLines(makeSnap([run]), 79).map(stripAnsi);
		assert.equal(collapsed.length, 1);
		assert.ok(!collapsed.join("\n").includes("Approve this generated migration"));
		assert.ok(!collapsed.join("\n").includes("/workflow connect"));
	});

	// #2700: IDs remain verbatim even when the command needs continuation rows.
	test("wraps long identifiers without ellipsis and bounds Unicode questions", () => {
		const runId = "full-identifier-".repeat(12);
		const run = awaitingRun(runId, "unicode", "承認 é 確認 ".repeat(30));
		for (const theme of [undefined, NULL_PI_THEME]) {
			for (const width of [80, 81, 120]) {
				const lines = buildThemedWidgetLines(makeSnap([run]), theme, width).map(stripAnsi);
				for (const line of lines) assert.equal(visibleWidth(line), width);
				const actionIndex = lines.findIndex((line) => line.includes("Answer: /workflow connect "));
				assert.ok(actionIndex >= 0);
				const command = lines
					.slice(actionIndex, -1)
					.map((line) => line.slice(1, -1).trim())
					.join("");
				assert.equal(command, `Answer: /workflow connect ${runId}`);
				assert.match(lines.find((line) => line.includes('"')) ?? "", /".*…"/u);
			}
		}
	});

	test("keeps waiting rows width-safe with exact pending targets and live-tool metadata", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const waiting = awaitingRun(runId, "release", "Approve the release?");
		waiting.stages.push(makeStage("r", "r", "pending", { pendingStageDeliveryAvailable: true }));
		const run: RunSnapshot = {
			...waiting,
			toolNodes: [
				{
					kind: "tool",
					id: "tool:verify",
					name: "verify",
					argsHash: "verify-hash",
					ordinal: 0,
					parentIds: [],
					status: "running",
					attachable: false,
				},
			],
		};

		const narrow = buildThemedWidgetLines(makeSnap([run]), undefined, 80, run.startedAt + 5_000).map(stripAnsi);
		for (const line of narrow) assert.equal(visibleWidth(line), 80);
		const narrowText = narrow.join("\n");
		assert.match(narrowText, /verify · running/u);
		assert.match(narrowText, new RegExp(`/workflow connect ${runId}`));
		assert.doesNotMatch(narrowText, /\/workflow connect [^\n│]*…/u);

		const roomy = buildThemedWidgetLines(makeSnap([run]), undefined, 120, run.startedAt + 5_000).map(stripAnsi);
		for (const line of roomy) assert.equal(visibleWidth(line), 120);
		// #2700: preserve current main's root-anchored Intercom target on HIL cards.
		const exactPendingTarget = `workflow:${runId}/r`;
		assert.match(roomy.join("\n"), new RegExp(exactPendingTarget));
		assert.doesNotMatch(roomy.join("\n"), new RegExp(`workflow:${runId}/…`));
		assert.doesNotMatch(roomy.join("\n"), new RegExp(`${runId}:…`));
	});

	test("stays status-only when a newer custom prompt footprint can win F2 focus", () => {
		const now = Date.now();
		const run = awaitingRun("custom-focus-card", "custom-focus", "Answer the primitive prompt?", now - 2_000);
		run.stages.push(
			makeStage("custom", "custom", "awaiting_input", {
				startedAt: now - 1_000,
				awaitingInputSince: now - 1_000,
				promptFootprint: {
					id: "custom-prompt",
					kind: "custom",
					message: "Custom deployment picker",
					createdAt: now - 1_000,
				},
			}),
		);

		const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.equal(lines.length, 4);
		assert.ok(joined.includes(statusIcon("awaiting_input")));
		assert.doesNotMatch(joined, /Answer the primitive prompt|F2 answer/);
		assert.ok(!joined.includes(`/workflow connect ${run.id}`));
	});

	test("falls back to the ordinary status row for ambiguous prompts", () => {
		const run = makeRun("ambiguous-card", "ambiguous", "running", [makeStage("ask", "ask", "awaiting_input")]);
		run.stages[0]!.inputRequest = {
			id: "ambiguous-request",
			kind: "ask_user_question",
			questions: [
				{ question: "First", options: [] },
				{ question: "Second", options: [] },
			],
			createdAt: 1,
		};
		const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.equal(lines.length, 4);
		assert.ok(joined.includes(statusIcon("awaiting_input")));
		assert.ok(!joined.includes("First"));
		assert.ok(!joined.includes(`/workflow connect ${run.id}`));
	});

	test("waiting prompt rows do not emit raw ESC or OSC from untrusted prompt text", () => {
		const run = awaitingRun("control-render", "control-render", "Approve\x1b[2J this\x1b]0;pwned\x07 release?");
		const lines = renderWidgetLines(makeSnap([run]), 120);
		const joined = lines.join("\n");
		assert.ok(joined.includes('"Approve this release?"'));
		assert.equal(joined.includes("\x1b"), false, "plain widget output must not contain ESC");
		assert.equal(joined.includes("\x07"), false, "plain widget output must not contain BEL");
		assert.ok(!joined.includes("[2J"));
		assert.ok(!joined.includes("]0;"));
		assert.ok(!joined.includes("pwned"));
	});

	test("themed waiting prompt rows keep chrome SGR but drop untrusted CSI/OSC", () => {
		const run = awaitingRun(
			"themed-control-render",
			"themed-control-render",
			"Approve\x1b[2J this\x1b]0;pwned\x07 release?",
		);
		const joined = buildThemedWidgetLines(makeSnap([run]), NULL_PI_THEME, 120).join("\n");
		const chromeStripped = stripAnsi(joined);
		assert.ok(chromeStripped.includes('"Approve this release?"'));
		assert.equal(chromeStripped.includes("\x1b"), false, "SGR-stripped themed output must not retain ESC");
		assert.equal(joined.includes("\x07"), false, "themed widget output must not contain BEL");
		assert.ok(!joined.includes("[2J"));
		assert.ok(!joined.includes("]0;"));
		assert.ok(!joined.includes("pwned"));
	});

	test("themed waiting rows use the info-blue role", () => {
		const run = awaitingRun("themed-waiting", "themed", "Approve the themed prompt?");
		const theme = deriveGraphTheme({});
		const lines = buildThemedWidgetLines(makeSnap([run]), NULL_PI_THEME, 120);
		const joined = lines.join("\n");
		assert.ok(joined.includes(hexToAnsi(theme.info)));
		assert.ok(lines.some((line) => line.includes(`${hexToAnsi(theme.info)}     Answer:`)));
	});
});

// ---------------------------------------------------------------------------
// renderWidgetLines — collapsed form (< 80 cols)
// ---------------------------------------------------------------------------

describe("renderWidgetLines — collapsed form", () => {
	test("returns single line summary under threshold", () => {
		const r1 = makeRun("aaa", "wf-a", "running");
		const r2 = makeRun("bbb", "wf-b", "running");
		const lines = renderWidgetLines(makeSnap([r1, r2]), 60).map(stripAnsi);
		assert.equal(lines.length, 1);
		assert.ok(lines[0]!.includes("▾"));
		assert.ok(lines[0]!.includes("2 background"));
		assert.ok(lines[0]!.includes("2 ●"));
	});
});

// ---------------------------------------------------------------------------
// buildThemedWidgetLines — ANSI path includes Catppuccin escapes
// ---------------------------------------------------------------------------

describe("buildThemedWidgetLines — themed path", () => {
	test("when piTheme is provided, output carries ANSI escape sequences", () => {
		const snap = makeSnap([makeRun("zzz", "themed-wf", "running")]);
		const lines = buildThemedWidgetLines(snap, NULL_PI_THEME, 120);
		assert.ok(lines.length >= 4, "themed render returns panel + entry lines");
		const joined = lines.join("");
		assert.ok(joined.includes("\x1b["), "themed lines include ANSI escapes");
	});

	test("awaiting-input title badge uses info blue and question mark", () => {
		const awaiting = makeRun("r1xxxxxx", "wf-await", "running", [makeStage("s1", "ask", "awaiting_input")]);
		const lines = buildThemedWidgetLines(makeSnap([awaiting]), NULL_PI_THEME, 160);
		const joined = lines.join("\n");
		const infoBlue = hexToAnsi(deriveGraphTheme({}).info);

		assert.ok(
			joined.includes(`${infoBlue}？ ↵ 1 needs attention`),
			"awaiting-input badge should be styled with the graph info blue",
		);
		assert.ok(
			stripAnsi(joined).includes("？ ↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
			"awaiting-input badge should keep the status/question mark and attach copy",
		);
	});
});

describe("run identity rows", () => {
	test("keep complete ids and two-line identity for running, awaiting, quit, and terminal states", () => {
		const theme = deriveGraphTheme({});
		const now = Date.now();
		const ids = {
			running: "339e05a4-2289-408e-9076-d1a348f582ae",
			awaiting: "d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f",
			quit: "aa11bb22-33cc-44dd-55ee-66ff77889900",
			completed: "bb22cc33-44dd-55ee-66ff-778899001122",
			failed: "cc33dd44-55ee-66ff-7788-990011223344",
		};
		const awaiting = makeRun(ids.awaiting, "build-check", "running", [makeStage("s1", "ask", "awaiting_input")]);
		const quit: RunSnapshot = { ...makeRun(ids.quit, "release-docs", "paused"), exitReason: "quit" };
		const completed = makeRun(ids.completed, "publish-release", "completed", [], now - 10_000, now);
		const failed = makeRun(ids.failed, "verify-release", "failed", [], now - 10_000, now);
		const running = makeRun(ids.running, "stage-output-transcript", "running", [], now - 10_000);
		const lines = renderWidgetLines(makeSnap([running, awaiting, quit, completed, failed]), 120).map(stripAnsi);
		const joined = lines.join("\n");

		const cases = [
			{ id: ids.running, name: "stage-output-transcript", glyph: statusIcon("running") },
			{ id: ids.awaiting, name: "build-check", glyph: statusIcon("awaiting_input") },
			{ id: ids.quit, name: "release-docs", glyph: statusIcon("pending") },
			{ id: ids.completed, name: "publish-release", glyph: statusIcon("completed") },
			{ id: ids.failed, name: "verify-release", glyph: statusIcon("failed") },
		] as const;
		for (const entry of cases) {
			assert.ok(joined.includes(entry.id), `full id ${entry.id} is rendered`);
			const idLine = lines.find((line) => line.includes(entry.id));
			assert.ok(idLine?.includes(entry.glyph), `${entry.name} uses ${entry.glyph}`);
		}
		for (const name of [
			"stage-output-transcript",
			"build-check",
			"release-docs",
			"publish-release",
			"verify-release",
		]) {
			assert.ok(
				lines.some((line) => line.includes(`${name} ·`)),
				`${name} has a name/meta identity row`,
			);
		}

		const themed = buildThemedWidgetLines(makeSnap([running]), NULL_PI_THEME, 120);
		assert.ok(themed[1]?.includes(hexToAnsi(statusColor("running", theme))));
		assert.ok(themed[1]?.includes(statusIcon("running")));
		const themedAwaiting = buildThemedWidgetLines(makeSnap([awaiting]), NULL_PI_THEME, 120);
		assert.ok(themedAwaiting[1]?.includes(hexToAnsi(statusColor("awaiting_input", theme))));
		assert.ok(themedAwaiting[1]?.includes(statusIcon("awaiting_input")));
	});

	test("wide widget names projected pending stages and targets while collapsed mode stays aggregate", () => {
		const localStore = createStore();
		localStore.recordRunStart(
			makeRun("widget-run", "publish", "running", [
				makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true }),
				makeStage("offline", "offline", "pending", { pendingStageDeliveryAvailable: false }),
				makeStage("later", "later", "pending", { pendingStageDeliveryAvailable: true }),
			]),
		);
		const snapshot = localStore.graphSnapshot();
		const wide = renderWidgetLines(snapshot, 160).map(stripAnsi).join("\n");
		assert.ok(wide.includes("pending: review (review-a) → workflow:widget-run/review-a"));
		assert.match(wide, /offline \(offline\) · unavailable/);
		assert.doesNotMatch(wide, /widget-run:offline/);
		assert.match(wide, /… 1 more/);
		assert.doesNotMatch(wide, /widget-run:later/);
		const collapsed = renderWidgetLines(snapshot, 79).map(stripAnsi);
		assert.equal(collapsed.length, 1);
		assert.doesNotMatch(collapsed[0]!, /review|offline|widget-run/);
	});

	test("projected widget cards never advertise pending-stage targets after the run terminates", () => {
		const runId = "terminated-widget-run";
		const localStore = createStore();
		localStore.recordRunStart(
			makeRun(runId, "terminated-widget", "running", [
				makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true }),
			]),
		);
		localStore.recordRunEnd(runId, "failed", undefined, "boom");

		const wide = renderWidgetLines(localStore.graphSnapshot(), 160).map(stripAnsi).join("\n");

		assert.match(wide, /failed/);
		assert.doesNotMatch(wide, new RegExp(`workflow:${runId}/review-a`));
	});
	test("uses exact or labelled pending-stage identities with visible width elision", () => {
		const runId = "aaaaaaaa-1111-4111-8111-111111111111";
		const run = makeRun(runId, "release-docs", "running", [
			makeStage("s-build", "build", "completed"),
			makeStage("s-verify", "verify", "running"),
			makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true }),
			makeStage("review-b", "review", "pending", { pendingStageDeliveryAvailable: true }),
			makeStage("offline", "offline", "pending", { pendingStageDeliveryAvailable: false }),
		]);
		const snapshot = makeSnap([run]);

		const standard = renderWidgetLines(snapshot, 100).map(stripAnsi).join("\n");
		assert.doesNotMatch(standard, /→ [^\n│,]*…/u);
		assert.doesNotMatch(standard, /→/u, "a target that cannot fit is omitted rather than shortened");
		assert.match(standard, /review · stage review-a/u);
		assert.match(standard, /… 2 more/u);

		assert.deepEqual(renderWidgetLines(snapshot, 70).map(stripAnsi), [" ▾  1 background · 1 ●"]);

		const wide = renderWidgetLines(snapshot, 240).map(stripAnsi).join("\n");
		assert.match(wide, new RegExp(`workflow:${runId}/review-a`));
		assert.match(wide, new RegExp(`workflow:${runId}/review-b`));
		assert.doesNotMatch(wide, /→ [^\n│,]*…/u);
		assert.match(wide, /… 1 more/u);
	});
	test("omits pending metadata when it cannot fit without displacing tool and elapsed labels", () => {
		const now = 1_000_000;
		const pendingStages = [
			makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true }),
			makeStage("review-b", "review", "pending", { pendingStageDeliveryAvailable: true }),
		];
		const run: RunSnapshot = {
			...makeRun(
				"aaaaaaaa-1111-4111-8111-111111111111",
				"publish",
				"running",
				[makeStage("build", "build", "running"), ...pendingStages],
				now - 65_000,
			),
			toolNodes: [
				{
					kind: "tool",
					id: "tool:fetch-release-notes",
					name: "fetch-release-notes",
					argsHash: "fetch-release-notes",
					ordinal: 0,
					parentIds: [],
					status: "running",
					attachable: false,
				},
				{
					kind: "tool",
					id: "tool:verify-artifacts",
					name: "verify-artifacts",
					argsHash: "verify-artifacts",
					ordinal: 1,
					parentIds: [],
					status: "pending",
					attachable: false,
				},
			],
		};
		for (let width = 111; width <= 130; width++) {
			const rendered = buildThemedWidgetLines(makeSnap([run]), undefined, width, now)
				.map(stripAnsi)
				.join("\n");
			assert.match(rendered, /2 tools · fetch-release-notes · running, verify-artifacts · pending/u);
			assert.match(rendered, /1m 5s/u);
			assert.doesNotMatch(rendered, /pending:/u, `pending label must stay within its width budget at ${width}`);
		}
	});

	test("omits pending metadata when a long workflow identity leaves no room", () => {
		const now = 1_000_000;
		const run = makeRun(
			"aaaaaaaa-1111-4111-8111-111111111111",
			"implementation-review-and-release-pipeline",
			"running",
			[
				makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true }),
				makeStage("review-b", "review", "pending", { pendingStageDeliveryAvailable: true }),
			],
			now - 65_000,
		);
		for (let width = 80; width <= 90; width++) {
			const rendered = buildThemedWidgetLines(makeSnap([run]), undefined, width, now)
				.map(stripAnsi)
				.join("\n");
			assert.match(rendered, /1m 5s/u);
			assert.doesNotMatch(rendered, /pending:/u, `pending label must stay within its width budget at ${width}`);
		}
	});

	test("keeps every widget border line at the collapsed breakpoint", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const snap = makeSnap([makeRun(runId, "narrow-run", "running")]);
		for (const width of [80, 79, 60, 40, 30, 20]) {
			const lines = renderWidgetLines(snap, width).map(stripAnsi);
			if (width >= 80) {
				for (const line of lines) assert.equal(visibleWidth(line), width);
				assert.ok(lines.join("\n").includes(runId));
			} else {
				assert.equal(lines.length, 1, `width ${width} uses collapsed count-only form`);
				assert.ok(!lines.join("\n").includes("339e05a4"), "collapsed widget intentionally omits ids");
			}
		}
	});
});

// PR #2700 merge: pending cards must retain main's recursively expanded progress.
test("pending nested prompt cards preserve recursive progress and exact connect ownership", () => {
	const root = makeRun("visible-root", "nested-release", "running", [
		makeStage("import", "child", "running", {
			workflowChildRun: { alias: "child", workflow: "child", runId: "child-run" },
		}),
	]);
	const child: RunSnapshot = {
		...makeRun("child-run", "child", "running", [
			makeStage("done", "done", "completed"),
			makeStage("ask", "ask", "awaiting_input", {
				pendingPrompt: { id: "nested-prompt", kind: "input", message: "Continue nested work?", createdAt: 1 },
			}),
		]),
		parentRunId: root.id,
		parentStageId: "import",
		rootRunId: root.id,
	};
	for (const theme of [undefined, NULL_PI_THEME]) {
		const lines = buildThemedWidgetLines(makeSnap([root, child]), theme, 120)
			.map(stripAnsi)
			.join("\n");
		assert.ok(lines.includes("nested-release · chain · 1/2"), lines);
		assert.ok(lines.includes('"Continue nested work?"'), lines);
		assert.ok(lines.includes("/workflow connect visible-root"), lines);
		assert.ok(!lines.includes("/workflow connect child-run"), lines);
	}
});
