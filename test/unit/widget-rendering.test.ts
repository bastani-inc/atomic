/**
 * Unit tests for the background-workflow widget.
 *
 * Visual contract:
 *   - One transparent rounded `BACKGROUND` panel with `N runs` subtitle and
 *     status-icon count badges in the title.
 *   - Two-line entry per run (status glyph + full id on line 1; workflow name
 *     and dim mode · progress · duration on line 2).
 *   - Hides entirely (returns []) when no active or recently-ended runs.
 *
 * cross-ref: src/tui/widget.ts · orchestrator-panel-ui.png · DESIGN.md §5
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
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
				let retainedIdReads = 0;
				const retained = Array.from({ length: 32 }, (_, index) => ({
					...makeRun(`old-${index}`, "retained", "completed", [], 1_000, 2_000),
					get id() {
						retainedIdReads++;
						return `old-${index}`;
					},
				}));
				const snap = store.graphSnapshot();
				const lines = buildThemedWidgetLines({ ...snap, runs: [...snap.runs, ...retained] }, theme, 120, now)
					.map(stripAnsi)
					.join("\n");
				assert.match(lines, /BACKGROUND {2}2 runs /);
				assert.ok(lines.includes(`alpha · chain · ${alpha}`), lines);
				assert.ok(lines.includes(`beta · chain · ${beta}`), lines);
				assert.equal(retainedIdReads, retained.length, "one full run-index preparation per render pass");
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

	test("hides nested child workflow runs, showing only the top-level run", () => {
		const t = Date.now();
		const root = makeRun("root1111", "contract-hil-nested-root", "running", [], t - 3000);
		const parent: RunSnapshot = {
			...makeRun("parent22", "contract-hil-nested-parent", "running", [], t - 2000),
			parentRunId: "root1111",
			parentStageId: "hil-parent:imported-composition",
			rootRunId: "root1111",
		};
		const child: RunSnapshot = {
			...makeRun("child333", "contract-hil-nested-child", "running", [], t - 1000),
			parentRunId: "parent22",
			parentStageId: "hil-child:imported",
			rootRunId: "root1111",
		};
		const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		// Only the top-level root is listed; the count reflects one run, not three.
		assert.ok(lines[0]!.includes("1 run"), `expected "1 run" subtitle, got: ${lines[0]}`);
		assert.ok(joined.includes("contract-hil-nested-root"));
		assert.ok(!joined.includes("contract-hil-nested-parent"), "nested parent run must be hidden");
		assert.ok(!joined.includes("contract-hil-nested-child"), "nested child run must be hidden");
	});

	test("surfaces a hidden nested child's awaiting-input (HiL) state on the top-level run", () => {
		const t = Date.now();
		// Root is running and blocked on its imported composition; the actual HiL
		// prompt is awaiting in the nested child run, which the widget hides.
		const root = makeRun("root1111", "contract-hil-nested-root", "running", [], t - 3000);
		const parent: RunSnapshot = {
			...makeRun("parent22", "contract-hil-nested-parent", "running", [], t - 2000),
			parentRunId: "root1111",
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
			rootRunId: "root1111",
		};
		child.stages[0]!.pendingPrompt = {
			id: "nested-prompt",
			kind: "confirm",
			message: "Answer in the child workflow?",
			createdAt: t - 1000,
		};
		const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		const header = lines[0]!;
		// Only the root is listed, but its hidden descendant's awaiting state still
		// raises the "needs attention" badge so the HiL prompt is discoverable.
		assert.ok(header.includes("1 run"), `expected "1 run" subtitle, got: ${header}`);
		assert.ok(
			header.includes("↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
			`expected nested HiL to surface a needs-attention badge, got: ${header}`,
		);
		assert.ok(joined.includes(statusIcon("awaiting_input")));
		assert.ok(!joined.includes("contract-hil-nested-child"), "nested child stays hidden");
		assert.ok(!joined.includes("child333"));
		assert.ok(!joined.includes('"Answer in the child workflow?"'));
		assert.ok(!joined.includes("/workflow connect child333"));
	});

	test("BACKGROUND needs-attention agrees with runIndicatorStatus for nested owner shapes", () => {
		const t = Date.now();
		const childId = "child-nested";
		const rootId = "root-nested";
		const prompt = {
			id: "nested-prompt",
			kind: "confirm" as const,
			message: "Answer the nested prompt?",
			createdAt: t - 1000,
		};
		const childBase = (): RunSnapshot => {
			const child = makeRun(
				childId,
				"nested-child",
				"running",
				[makeStage("ask", "ask", "awaiting_input")],
				t - 1000,
			);
			child.stages[0]!.pendingPrompt = prompt;
			return child;
		};
		const shapes: Array<{
			name: string;
			root: RunSnapshot;
			child: RunSnapshot;
			preview: boolean;
		}> = [
			{
				name: "loose ancestry",
				root: makeRun(rootId, "nested-root", "running", [], t - 3000),
				child: { ...childBase(), parentRunId: rootId, rootRunId: rootId },
				preview: false,
			},
			{
				name: "parentStageId without reciprocal link",
				root: makeRun(rootId, "nested-root", "running", [makeStage("to-child", "child", "running")], t - 3000),
				child: { ...childBase(), parentRunId: rootId, parentStageId: "to-child", rootRunId: rootId },
				preview: false,
			},
			{
				name: "fully linked ancestry",
				root: makeRun(
					rootId,
					"nested-root",
					"running",
					[
						makeStage("to-child", "child", "running", {
							workflowChildRun: { alias: "child", workflow: "child", runId: childId },
						}),
					],
					t - 3000,
				),
				child: { ...childBase(), parentRunId: rootId, parentStageId: "to-child", rootRunId: rootId },
				preview: true,
			},
		];

		for (const shape of shapes) {
			const runs = [shape.child, shape.root];
			assert.equal(runIndicatorStatus(shape.root, runs), "awaiting_input", shape.name);
			const lines = renderWidgetLines(makeSnap(runs), 120).map(stripAnsi);
			const joined = lines.join("\n");
			assert.ok(lines[0]!.includes("needs attention"), `${shape.name}: header must agree with runIndicatorStatus`);
			assert.ok(
				joined.includes(statusIcon("awaiting_input")),
				`${shape.name}: glyph must agree with runIndicatorStatus`,
			);
			if (shape.preview) {
				assert.ok(joined.includes('"Answer the nested prompt?"'), `${shape.name}: linked preview`);
				assert.ok(
					joined.includes(`Answer: /workflow connect ${rootId}`),
					`${shape.name}: connect the visible root`,
				);
			} else {
				assert.ok(
					lines[0]!.includes("(attach to workflow with `/workflow connect`)"),
					`${shape.name}: unproven ownership keeps the header connect hint`,
				);
				assert.ok(!joined.includes('"Answer the nested prompt?"'), `${shape.name}: no preview`);
				assert.ok(
					!joined.includes(`Answer: /workflow connect ${rootId}`),
					`${shape.name}: no selected connect row`,
				);
			}
		}
	});
	test("surfaces a reciprocally owned hidden nested child's awaiting-input state on the top-level run", () => {
		const t = Date.now();
		const root = makeRun(
			"root1111",
			"contract-hil-nested-root",
			"running",
			[
				makeStage("to-parent", "parent", "running", {
					workflowChildRun: { alias: "parent", workflow: "contract-hil-nested-parent", runId: "parent22" },
				}),
			],
			t - 3000,
		);
		const parent: RunSnapshot = {
			...makeRun(
				"parent22",
				"contract-hil-nested-parent",
				"running",
				[
					makeStage("to-child", "child", "running", {
						workflowChildRun: { alias: "child", workflow: "contract-hil-nested-child", runId: "child333" },
					}),
				],
				t - 2000,
			),
			parentRunId: "root1111",
			parentStageId: "to-parent",
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
			parentStageId: "to-child",
			rootRunId: "root1111",
		};
		child.stages[0]!.pendingPrompt = {
			id: "nested-prompt",
			kind: "confirm",
			message: "Answer in the child workflow?",
			createdAt: t - 1000,
		};
		const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		const header = lines[0]!;
		assert.ok(header.includes("1 run"), `expected "1 run" subtitle, got: ${header}`);
		assert.ok(
			header.includes("↵ 1 needs attention"),
			`expected nested HiL to surface a needs-attention badge, got: ${header}`,
		);
		assert.ok(joined.includes('"Answer in the child workflow?"'));
		assert.ok(joined.includes(`/workflow connect ${root.id}`));
		assert.ok(!joined.includes("contract-hil-nested-child"), "nested child stays hidden");
		assert.ok(!joined.includes(child.id), "the hidden owner id is not the connect target");
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

	test("awaiting-input run shows question mark in compact indicator (plain)", () => {
		const awaiting = makeRun("r1xxxxxx", "wf-await", "running", [makeStage("s1", "ask", "awaiting_input")]);
		const lines = renderWidgetLines(makeSnap([awaiting]), 60).map(stripAnsi);
		assert.equal(lines.length, 1);
		// Should show the awaiting_input glyph (？) before the running count
		assert.ok(lines[0]!.includes("？"), "compact indicator must include the question-mark glyph");
		assert.ok(lines[0]!.includes("1 ●"), "running count still displayed");
		assert.ok(lines[0]!.includes("1 background"), "total count still displayed");
	});

	test("ordinary running run without pending input keeps bullet indicator (plain)", () => {
		const running = makeRun("r2xxxxxx", "wf-run", "running");
		const lines = renderWidgetLines(makeSnap([running]), 60).map(stripAnsi);
		assert.equal(lines.length, 1);
		assert.ok(!lines[0]!.includes("？"), "no question mark for ordinary running");
		assert.ok(lines[0]!.includes("1 ●"), "plain running indicator");
	});

	test("awaiting-input compact indicator uses info blue in themed output", () => {
		const awaiting = makeRun("r3xxxxxx", "wf-await-themed", "running", [makeStage("s1", "ask", "awaiting_input")]);
		const lines = buildThemedWidgetLines(makeSnap([awaiting]), NULL_PI_THEME, 60);
		assert.equal(lines.length, 1);
		const infoBlue = hexToAnsi(deriveGraphTheme({}).info);
		assert.ok(lines[0]!.includes(infoBlue), "themed compact uses info blue for awaiting-input");
		assert.ok(stripAnsi(lines[0]!).includes("？"), "question-mark glyph present in themed compact");
	});

	test("answering the question returns compact indicator to ordinary running state", () => {
		const localStore = createStore();
		const stage = makeStage("s1", "ask", "awaiting_input");
		const run = makeRun("r4xxxxxx", "wf-resolve", "running", [stage]);
		localStore.recordRunStart(run);
		// Before answer — should show question mark
		const before = renderWidgetLines(localStore.graphSnapshot(), 60).map(stripAnsi);
		assert.ok(before[0]!.includes("？"), "question mark shown while awaiting");

		// Simulate stage resuming after question answered
		localStore.recordStageEnd("r4xxxxxx", { ...stage, status: "running" });
		localStore.recordStageStart("r4xxxxxx", { ...stage, status: "running" });
		const after = renderWidgetLines(localStore.graphSnapshot(), 60).map(stripAnsi);
		assert.ok(!after[0]!.includes("？"), "question mark gone after stage resumes");
		assert.ok(after[0]!.includes("1 ●"), "back to ordinary running indicator");
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

	test("eligible waiting rows preserve identity metadata and connect navigation", () => {
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
			assert.ok(joined.includes(run.name));
		}
	});

	test("mixed roots retain both unique previews and general needs-input guidance", () => {
		const unique = awaitingRun("safe-root", "safe", "Approve safe?");
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
		const lines = renderWidgetLines(makeSnap([unique, form]), 180).map(stripAnsi);
		const joined = lines.join("\n");
		assert.ok(lines[0]!.includes("？ ↵ 2 needs attention (attach to workflow with `/workflow connect`)"));
		assert.ok(joined.includes(`Answer: /workflow connect ${unique.id}`));
		assert.ok(!joined.includes(`Answer: /workflow connect ${form.id}`));
		assert.ok(!joined.includes("First field?"));
	});

	test("same-id truncated prefixes keep general guidance without a preview", () => {
		const prefix = "x".repeat(256);
		const run = makeRun("prefix-collision", "prefix-collision", "running", [
			makeStage("ask", "ask", "awaiting_input"),
		]);
		run.stages[0]!.pendingPrompt = {
			id: "shared-prompt",
			kind: "confirm",
			message: `${prefix} APPROVE`,
			createdAt: 1,
		};
		run.stages[0]!.inputRequest = {
			id: "shared-prompt",
			kind: "ask_user_question",
			questions: [{ question: `${prefix} REJECT`, options: [] }],
			createdAt: 1,
		};
		const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
		const joined = lines.join("\n");
		assert.ok(lines[0]!.includes("needs attention"));
		assert.ok(joined.includes(statusIcon("awaiting_input")));
		assert.ok(!joined.includes("APPROVE"));
		assert.ok(!joined.includes("REJECT"));
		assert.ok(!joined.includes(`Answer: /workflow connect ${run.id}`));
	});

	test("unpaired surrogates render as well-formed rows of the requested width", () => {
		const run = awaitingRun("surrogate-card", "surrogate-card", "Approve \ud800 release?");
		for (const width of [80, 120]) {
			for (const lines of [
				renderWidgetLines(makeSnap([run]), width),
				buildThemedWidgetLines(makeSnap([run]), NULL_PI_THEME, width),
			]) {
				for (const line of lines) {
					const plain = stripAnsi(line);
					assert.equal(plain.isWellFormed(), true, JSON.stringify(plain));
					assert.equal(visibleWidth(plain), width);
				}
			}
		}
	});

	test("hostile prompt controls cannot escape plain or themed rendering", () => {
		const run = awaitingRun("control-render", "control-render", "Approve\x1b[2J this\x1b]0;pwned\x07 release?");
		const plain = renderWidgetLines(makeSnap([run]), 120).join("\n");
		assert.ok(plain.includes('"Approve this release?"'));
		assert.equal(plain.includes("\x1b"), false, "plain widget output must not contain ESC");
		assert.equal(plain.includes("\x07"), false, "plain widget output must not contain BEL");
		assert.ok(!plain.includes("[2J"));
		assert.ok(!plain.includes("pwned"));

		const themed = buildThemedWidgetLines(makeSnap([run]), NULL_PI_THEME, 120).join("\n");
		const chromeStripped = stripAnsi(themed);
		assert.ok(chromeStripped.includes('"Approve this release?"'));
		assert.equal(chromeStripped.includes("\x1b"), false, "SGR-stripped themed output must not retain ESC");
		assert.equal(themed.includes("\x07"), false, "themed widget output must not contain BEL");
		assert.ok(!themed.includes("[2J"));
		assert.ok(!themed.includes("pwned"));
		assert.ok(themed.includes(hexToAnsi(deriveGraphTheme({}).info)));
	});

	test("preview rows obey cell width at the collapse boundary", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const run = awaitingRun(
			runId,
			"width-aware-waiting",
			"Approve this generated migration before deployment? This message is intentionally long enough to exercise cell truncation.\tAnd a tab.",
		);
		for (const width of [1, 27, 40, 79, 80, 81, 120]) {
			const lines = renderWidgetLines(makeSnap([run]), width).map(stripAnsi);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
			}
			if (width < 80) {
				assert.equal(lines.length, 1);
				assert.ok(!lines.join("\n").includes("Approve this generated migration"));
				assert.ok(!lines.join("\n").includes("/workflow connect"));
			} else {
				for (const line of lines) assert.equal(visibleWidth(line), width, `line must fill width ${width}`);
				assert.ok(lines.join("\n").includes(`/workflow connect ${runId}`));
			}
		}

		const cjk = awaitingRun("cjk-run", "unicode", "承認 é 確認 👍 ".repeat(20));
		for (const width of [80, 81, 120]) {
			const lines = renderWidgetLines(makeSnap([cjk]), width).map(stripAnsi);
			for (const line of lines) assert.equal(visibleWidth(line), width);
			assert.match(lines.find((line) => line.includes('"')) ?? "", /".*…"/u);
		}
	});

	test("prompt rendering leaves descriptors drafts and answers unchanged", () => {
		const run = awaitingRun("immutable-card", "immutable", "Approve the original?");
		run.stages[0]!.pendingPrompt = {
			id: "immutable-prompt",
			kind: "input",
			message: "Approve\x1b[2J the original?",
			createdAt: 1,
			initial: "draft-text",
		};
		const snap = makeSnap([run]);
		const before = structuredClone(snap);
		renderWidgetLines(snap, 120);
		buildThemedWidgetLines(snap, NULL_PI_THEME, 80);
		assert.deepEqual(snap, before);
	});

	test("hostile zero-width combining and bidi text stay bounded and readable", () => {
		const MAX_PROMPT_ROW_CHARS = 512;
		const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/u;
		const cases = [
			`Approve?${"\u200b".repeat(200_000)}`,
			`Approve?${"\u0301".repeat(100_000)}`,
			"\u202eStop! Do not approve",
		] as const;
		for (const message of cases) {
			const run = awaitingRun("hostile-bound", "hostile-bound", message);
			const snap = makeSnap([run]);
			const before = structuredClone(snap);
			const plain = renderWidgetLines(snap, 120);
			const themed = buildThemedWidgetLines(snap, NULL_PI_THEME, 120);
			for (const lines of [plain, themed]) {
				for (const line of lines) {
					assert.ok(
						line.length <= MAX_PROMPT_ROW_CHARS,
						`unbounded row (${line.length}): ${JSON.stringify(line)}`,
					);
					assert.equal(visibleWidth(stripAnsi(line)), 120);
					assert.equal(BIDI_RE.test(line), false);
				}
				const joined = lines.map(stripAnsi).join("\n");
				assert.ok(joined.includes('"'));
				if (message.includes("Stop")) {
					assert.ok(joined.includes("Stop! Do not approve"));
					assert.equal(joined.includes("\u202e"), false);
				} else {
					assert.ok(joined.includes("Approve?"));
				}
			}
			assert.deepEqual(snap, before);
		}
	});

	test("zero-cell prompt text keeps the ordinary needs-attention card", () => {
		const run = awaitingRun("zero-cell-card", "zero-cell-card", "\u0301".repeat(300));
		const snap = makeSnap([run]);
		const before = structuredClone(snap);
		for (const lines of [renderWidgetLines(snap, 120), buildThemedWidgetLines(snap, NULL_PI_THEME, 120)]) {
			assert.equal(lines.length, 4, "zero-cell prompts must not add preview or Answer rows");
			const joined = lines.map(stripAnsi).join("\n");
			assert.ok(joined.includes(run.id));
			assert.ok(joined.includes(statusIcon("awaiting_input")));
			assert.ok(joined.includes("needs attention"));
			assert.doesNotMatch(joined, /"/);
			assert.doesNotMatch(joined, /Answer: \/workflow connect/);
			for (const line of lines) {
				const plain = stripAnsi(line);
				assert.equal(visibleWidth(plain), 120);
				assert.equal(
					[...plain].filter((c) => /\p{Mn}/u.test(c)).length,
					0,
					"combining marks must not land on widget chrome",
				);
			}
		}
		assert.deepEqual(snap, before);
	});

	test("waiting and non-waiting metadata rows stay identical for the same run", () => {
		const now = 1_700_000_000_000;
		const id = "8f3a1c20-5b64-4d8e-a791-2c3f0e6b9d44";
		const stages: StageSnapshot[] = [
			makeStage("ask", "ask", "running"),
			makeStage("publish", "publish", "pending", { pendingStageDeliveryAvailable: true }),
		];
		const running = makeRun(id, "release-docs", "running", stages, now - 5_000);
		running.rootRunId = id;
		const waitingStages: StageSnapshot[] = [
			makeStage("ask", "ask", "awaiting_input", {
				pendingPrompt: { id: "ask-prompt", kind: "confirm", message: "Approve metadata parity?", createdAt: now },
			}),
			makeStage("publish", "publish", "pending", { pendingStageDeliveryAvailable: true }),
		];
		const waiting = makeRun(id, "release-docs", "running", waitingStages, now - 5_000);
		waiting.rootRunId = id;
		const runningLines = buildThemedWidgetLines(makeSnap([running]), undefined, 120, now).map(stripAnsi);
		const waitingLines = buildThemedWidgetLines(makeSnap([waiting]), undefined, 120, now).map(stripAnsi);
		assert.equal(runningLines.length, 4);
		assert.equal(waitingLines.length, 6);
		assert.equal(waitingLines[2], runningLines[2]);
		assert.ok(waitingLines[3]?.includes('"Approve metadata parity?"'));
		assert.ok(waitingLines[4]?.includes(`Answer: /workflow connect ${id}`));
	});

	test("completed retained cards drop stale prompt actions while quit cards suppress them until resume", () => {
		const completedStore = createStore();
		const completedId = "00000000-0000-4000-8000-0000000000e1";
		completedStore.recordRunStart({
			id: completedId,
			name: "stale-card",
			inputs: {},
			status: "running",
			startedAt: Date.now() - 5_000,
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		assert.equal(
			completedStore.recordStagePendingPrompt(completedId, "ask", {
				id: "p",
				kind: "confirm",
				message: "Answer the stale prompt?",
				createdAt: 1,
			}),
			true,
		);
		assert.match(
			renderWidgetLines(completedStore.snapshot(), 120).map(stripAnsi).join("\n"),
			/"Answer the stale prompt\?"/,
		);

		assert.equal(completedStore.recordRunEnd(completedId, "completed", {}), true);
		const completedLines = renderWidgetLines(completedStore.snapshot(), 120).map(stripAnsi);
		const completedJoined = completedLines.join("\n");
		assert.equal(completedLines.length, 4);
		assert.equal(completedJoined.includes(completedId), true);
		assert.doesNotMatch(completedJoined, /"Answer the stale prompt\?"/);
		assert.doesNotMatch(completedJoined, /Answer: \/workflow connect/);

		const quitStore = createStore();
		const quitId = "00000000-0000-4000-8000-0000000000e2";
		quitStore.recordRunStart({
			id: quitId,
			name: "stale-card",
			inputs: {},
			status: "running",
			startedAt: Date.now() - 5_000,
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		assert.equal(
			quitStore.recordStagePendingPrompt(quitId, "ask", {
				id: "p",
				kind: "confirm",
				message: "Answer the stale prompt?",
				createdAt: 1,
			}),
			true,
		);
		assert.equal(quitStore.recordRunPaused(quitId, Date.now(), { exitReason: "quit", resumable: true }), true);
		const quitRun = quitStore.runs()[0]!;
		assert.equal(quitRun.exitReason, "quit");
		assert.equal(quitRun.resumable, true);
		assert.equal(quitRun.stages[0]!.pendingPrompt?.id, "p");
		const quitLines = renderWidgetLines(quitStore.snapshot(), 120).map(stripAnsi);
		const quitJoined = quitLines.join("\n");
		assert.equal(quitLines.length, 4);
		assert.equal(quitJoined.includes(quitId), true);
		assert.match(quitJoined, /quit · resumable via \/workflow resume/);
		assert.doesNotMatch(quitJoined, /"Answer the stale prompt\?"/);
		assert.doesNotMatch(quitJoined, /Answer: \/workflow connect/);

		assert.equal(quitStore.recordRunResumed(quitId), true);
		const resumedJoined = renderWidgetLines(quitStore.snapshot(), 120).map(stripAnsi).join("\n");
		assert.match(resumedJoined, /"Answer the stale prompt\?"/);
		assert.match(resumedJoined, new RegExp(`Answer: /workflow connect ${quitId}`));
	});

	test("nested and boundary prompts in one root keep general guidance without a preview", () => {
		const rootId = "00000000-0000-4000-8000-000000000c01";
		const childId = "00000000-0000-4000-8000-000000000c02";
		const nested = createStore();
		nested.recordRunStart({
			id: rootId,
			name: "nested-root",
			inputs: {},
			status: "running",
			startedAt: Date.now() - 5_000,
			stages: [
				{
					id: "fanout",
					name: "fanout",
					status: "running",
					parentIds: [],
					toolEvents: [],
					workflowChildRun: { alias: "child", workflow: "hidden-child", runId: childId },
				},
			],
		});
		nested.recordRunStart({
			id: childId,
			name: "hidden-child",
			inputs: {},
			status: "running",
			startedAt: Date.now() - 4_000,
			parentRunId: rootId,
			parentStageId: "fanout",
			rootRunId: rootId,
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		assert.equal(
			nested.recordStagePendingPrompt(childId, "ask", {
				id: "child-prompt",
				kind: "confirm",
				message: "Child question?",
				createdAt: 1,
			}),
			true,
		);
		assert.equal(
			nested.recordStagePendingPrompt(rootId, "fanout", {
				id: "root-prompt",
				kind: "confirm",
				message: "Root question?",
				createdAt: 1,
			}),
			true,
		);

		for (const width of [80, 120]) {
			for (const lines of [
				renderWidgetLines(nested.snapshot(), width).map(stripAnsi),
				buildThemedWidgetLines(nested.snapshot(), NULL_PI_THEME, width).map(stripAnsi),
			]) {
				const joined = lines.join("\n");
				assert.match(lines[0] ?? "", /needs attention/);
				assert.ok(joined.includes(statusIcon("awaiting_input")));
				assert.ok(joined.includes(rootId));
				assert.doesNotMatch(joined, /"Root question\?"/);
				assert.doesNotMatch(joined, /"Child question\?"/);
				assert.doesNotMatch(joined, /Answer: \/workflow connect/);
				if (width === 120) assert.equal(lines.length, 4);
				for (const line of lines) assert.equal(visibleWidth(line), width);
			}
		}

		assert.equal(nested.resolveStagePendingPrompt(rootId, "fanout", "root-prompt", true), true);
		const uniqueLines = renderWidgetLines(nested.snapshot(), 120).map(stripAnsi);
		const uniqueJoined = uniqueLines.join("\n");
		assert.equal(uniqueLines.length, 6);
		assert.match(uniqueJoined, /"Child question\?"/);
		assert.match(uniqueJoined, new RegExp(`Answer: /workflow connect ${rootId}`));
	});

	// #2529 / #3027: a truncated preview must stay plain in the unthemed entry point.
	test("truncated previews keep the plain entry point free of terminal controls", () => {
		const long = "Approve the generated migration before deployment? ".repeat(10);
		const run = awaitingRun("truncated-preview", "truncated-preview", long);
		for (const width of [80, 96, 120]) {
			const plain = renderWidgetLines(makeSnap([run]), width);
			const promptRow = plain.find((line) => line.includes('"Approve the generated migration'));
			assert.ok(promptRow, `missing preview row at ${width}`);
			assert.equal(visibleWidth(promptRow), width, `preview row must fill ${width}`);
			assert.equal(
				promptRow.includes("\x1b"),
				false,
				`plain preview row contains ESC at ${width}: ${JSON.stringify(promptRow)}`,
			);
			assert.ok(promptRow.includes("…"), `preview must be truncated at ${width}`);
			assert.ok(!promptRow.includes(long), `full prompt must not fit at ${width}`);
		}
	});
});
