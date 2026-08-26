// @ts-nocheck -- focused GraphView tool-detail input/rendering coverage

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { classifyCheckpointPayload, encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { createToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	boundedToolPayloadRecord,
	TOOL_PAYLOAD_TRUNCATION_MARKER,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../../packages/workflows/src/shared/tool-payload-bounds.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { computeLayout, NODE_H, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderSessionList } from "../../packages/workflows/src/tui/session-list.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { renderToolDetail } from "../../packages/workflows/src/tui/tool-detail.js";
import { ANSI_RE, defaultTheme, visibleText } from "./overlay-graph-helpers.js";

const KEY_DOWN = "\x1b[B";
const KEY_UP = "\x1b[A";
const KEY_PAGE_DOWN = "\x1b[6~";
const KEY_PAGE_UP = "\x1b[5~";
const KEY_HOME = "\x1b[H";
const KEY_END = "\x1b[F";

/**
 * Two snapshots of a five-million-element null array.
 *
 * The bounded walk is a few milliseconds; the unbounded one reviewers measured
 * cost 1.1–3.5 seconds *per call* and was re-paid on every version bump. This
 * budget leaves roughly two orders of magnitude of headroom for a loaded
 * machine — vitest runs files in parallel — while still failing that shape.
 */
const LARGE_NULL_SNAPSHOT_BUDGET_MS = 400;

/** Element kinds JSON emits as `null`, which the cap once charged nothing for. */
const UNCHARGED_ELEMENT_SHAPES: ReadonlyArray<readonly [string, () => unknown[]]> = [
	["null elements", () => new Array(5_000_000).fill(null)],
	["undefined elements", () => new Array(2_000_000).fill(undefined)],
	["function elements", () => new Array(2_000_000).fill(() => undefined)],
	["symbol elements", () => new Array(2_000_000).fill(Symbol("tool"))],
	["sparse holes", () => new Array(20_000_000)],
];

/** Strip both SGR and the layout's OSC-8 reset so row suffixes are comparable. */
function stripFrameEscapes(row: string): string {
	return row.replace(ANSI_RE, "").replace(/\x1b\]8;;\x07/g, "");
}

/** Return one marker per visible cell, showing whether the tool background is active. */
function backgroundPaintMap(row: string): string {
	let backgroundActive = false;
	let offset = 0;
	let map = "";
	const sgr = /\x1b\[([0-9;]*)m/g;
	for (const match of row.matchAll(sgr)) {
		const index = match.index ?? row.length;
		map += (backgroundActive ? "S" : ".").repeat(visibleWidth(row.slice(offset, index)));
		const params = match[1] ?? "";
		const codes = params.length === 0 ? [0] : params.split(";").map((code) => Number(code));
		for (let codeIndex = 0; codeIndex < codes.length; codeIndex++) {
			const code = codes[codeIndex];
			if (code === 0) {
				backgroundActive = false;
			} else if (code === 48 && codes[codeIndex + 1] === 2) {
				backgroundActive = true;
				codeIndex += 4;
			} else if (code === 48 && codes[codeIndex + 1] === 5) {
				backgroundActive = true;
				codeIndex += 2;
			} else if (code === 49) {
				backgroundActive = false;
			}
		}
		offset = index + match[0].length;
	}
	map += (backgroundActive ? "S" : ".").repeat(visibleWidth(row.slice(offset)));
	return map;
}

function assertFullyPainted(rows: string[], width: number, label: string): void {
	for (const [index, row] of rows.entries()) {
		const map = backgroundPaintMap(row);
		assert.equal(map.length, width, `${label}: row ${index} must fill ${width} cells`);
		assert.doesNotMatch(map, /\./, `${label}: row ${index} has an unpainted cell`);
	}
}

/** Read back the array a bounded tool result retained in the live store. */
function retainedRows(store: ReturnType<typeof createStore>): unknown[] {
	const node = store.runs()[0]?.toolNodes?.[0];
	assert.ok(node, "the run must hold the recorded tool node");
	const rows = (node.result as { rows?: unknown[] }).rows;
	assert.ok(Array.isArray(rows), "the retained result must keep its array");
	return rows;
}

/** Record one finished tool node into a live store the way the runtime does. */
function storeWithToolResult(result: unknown, runId = RUN_ID): ReturnType<typeof createStore> {
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "hostile run",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	});
	store.recordToolNodeStart(runId, {
		kind: "tool",
		id: "tool:hostile",
		name: "hostile",
		argsHash: "hostile-hash",
		ordinal: 1,
		parentIds: [],
		status: "pending",
		attachable: false,
	});
	store.recordToolNodeEnd(runId, "tool:hostile", {
		status: "completed",
		endedAt: Date.now(),
		result: result as never,
		resultSummary: "hostile",
	});
	return store;
}

const RUN_ID = "tool-detail-run";

function tool(overrides: Partial<ToolNodeSnapshot> = {}): ToolNodeSnapshot {
	return {
		kind: "tool",
		id: "tool:inspect",
		name: "inspect-api",
		args: { branch: "feat/inspect", checks: ["lint", "test"] },
		argsHash: "args-hash",
		ordinal: 1,
		parentIds: [],
		status: "completed",
		startedAt: 100,
		endedAt: 175,
		result: { ok: true, output: ["passed", "passed"] },
		resultSummary: '{"ok":true}',
		attachable: false,
		...overrides,
	};
}

function viewFor(node: ToolNodeSnapshot, piKeybindings?: unknown): GraphView {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "inspection run",
		inputs: {},
		status: "completed",
		stages: [],
		toolNodes: [node],
		startedAt: 1,
		endedAt: 200,
	});
	return new GraphView({
		mode: "overlay",
		runId: RUN_ID,
		store,
		graphTheme: defaultTheme,
		piTui: { terminal: { rows: 32 } },
		piKeybindings,
		onStageAttach() {
			throw new Error("tool detail must not attach a stage chat");
		},
	});
}

/** Same run shape as `viewFor`, with an explicit terminal height. */
function viewForAtRows(node: ToolNodeSnapshot, rows: number): GraphView {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "inspection run",
		inputs: {},
		status: "completed",
		stages: [],
		toolNodes: [node],
		startedAt: 1,
		endedAt: 200,
	});
	return new GraphView({
		mode: "overlay",
		runId: RUN_ID,
		store,
		graphTheme: defaultTheme,
		piTui: { terminal: { rows } },
	});
}

/**
 * Observe the width the layout actually hands the body, which is narrower than
 * the frame whenever the scrollbar column is reserved.
 */
function withBodyWidthProbe(view: GraphView): {
	bodyWidth: () => number | undefined;
	renderAll: (width: number) => string[];
} {
	const target = view as unknown as {
		_renderBody: (width: number, top: number, rows: number, contentRows: number) => string[];
	};
	const original = target._renderBody.bind(view);
	const widths: number[] = [];
	target._renderBody = (width, top, rows, contentRows) => {
		widths.push(width);
		return original(width, top, rows, contentRows);
	};
	return {
		bodyWidth: () => widths.at(-1),
		renderAll: (width) => original(width, 0, Number.MAX_SAFE_INTEGER, 0),
	};
}

/** Scroll to the bottom using only keys, the way a mouseless terminal must. */
function keyboardScrollToBottom(view: GraphView, width: number): string {
	let previous = -1;
	for (let step = 0; step < 200 && view._graphScrollOffset !== previous; step++) {
		previous = view._graphScrollOffset;
		view.handleInput(KEY_PAGE_DOWN);
		view.render(width);
	}
	return visibleText(view.render(width));
}

function clickForSingleNode(stage: ToolNodeSnapshot, width = 120, rows = 32): string {
	const projection = {
		id: stage.id,
		name: stage.name,
		status: stage.status === "cached" ? "completed" : stage.status === "cancelled" ? "skipped" : stage.status,
		parentIds: stage.parentIds,
		nodeKind: "tool",
		toolStatus: stage.status,
		toolEvents: [],
		attachable: false,
		workflowGraphTarget: { runId: RUN_ID, stageId: stage.id, runName: "inspection run", depth: 0 },
	};
	const [node] = computeLayout([projection], { orientation: "vertical" });
	const marginRows = 1;
	const bodyRows = rows - marginRows * 2 - 6;
	const totalGraphRows = node.y + NODE_H;
	const topPad =
		totalGraphRows <= bodyRows ? Math.min(3, Math.max(0, Math.floor((bodyRows - totalGraphRows) / 2))) : 0;
	const graphInner = Math.max(1, width - 4);
	const canvasWidth = node.x + NODE_W;
	const leftMargin = Math.max(2, canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2);
	const col = leftMargin + node.x + 2;
	const row = marginRows + 3 + topPad + node.y + 2;
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

describe("tool graph inspection", () => {
	test("Enter and direct selection open a collapsed read-only tool message block", () => {
		const node = tool();
		const enterView = viewFor(node);
		enterView.render(120);
		assert.equal(enterView.handleInput("\r"), true);
		assert.ok(enterView._toolDetail);
		const collapsed = visibleText(enterView.render(120));
		for (const expected of [
			"$ inspect-api",
			'{"branch":"feat/inspect","checks":["lint","test"]}',
			'{"ok":true,"output":["passed","passed"]}',
			"Took 0s",
		])
			assert.ok(collapsed.includes(expected), expected);
		assert.match(collapsed, /ctrl\+o expand/);
		for (const hidden of ["ARGS", "RESULT", "SOURCE", "TIMING", "MARKERS"])
			assert.doesNotMatch(collapsed, new RegExp(`\\b${hidden}\\b`));
		assert.doesNotMatch(collapsed, /stage chat|attach|interrupt|resume|steer/i);

		assert.equal(enterView.handleInput("\x0f"), true);
		const expanded = visibleText(enterView.render(120));
		assert.match(expanded, /ctrl\+o collapse/);
		for (const expected of [
			"$ inspect-api",
			'{"branch":"feat/inspect","checks":["lint","test"]}',
			'{"ok":true,"output":["passed","passed"]}',
			"Took 0s",
		])
			assert.ok(expanded.includes(expected), expected);
		for (const hidden of ["ARGS", "RESULT", "SOURCE", "TIMING", "MARKERS", "startedAt=", "endedAt=", "duration="])
			assert.doesNotMatch(expanded, new RegExp(hidden));
		assert.equal(enterView.handleInput("\x0f"), true);
		assert.doesNotMatch(visibleText(enterView.render(120)), /\bTIMING\b/);
		assert.equal(enterView.handleInput("\x1b"), true);
		assert.equal(enterView._toolDetail, null);
		enterView.dispose();

		const configured = viewFor(node, {
			matches(data: string, action: string): boolean {
				return action === "app.tools.expand" && data === "x";
			},
			getKeys(): readonly string[] {
				return ["alt+e"];
			},
		});
		assert.equal(configured.handleInput("\r"), true);
		assert.match(visibleText(configured.render(120)), /alt\+e expand/);
		assert.equal(configured.handleInput("\x0f"), false, "the host manager owns expansion when present");
		assert.equal(configured._toolDetailExpanded, false);
		assert.equal(configured.handleInput("x"), true);
		assert.equal(configured._toolDetailExpanded, true);
		assert.match(visibleText(configured.render(120)), /Took 0s/);
		assert.match(visibleText(configured.render(120)), /alt\+e collapse/);
		configured.dispose();

		const clickView = viewFor(node);
		clickView.render(120);
		assert.equal(clickView.handleInput(clickForSingleNode(node)), true);
		assert.ok(clickView._toolDetail);
		clickView.dispose();
	});
	test("opened tool detail keeps canvas between the chrome bars and the painted card", () => {
		const view = viewFor(tool());
		view.render(120);
		assert.equal(view.handleInput("\r"), true);
		const rows = view.render(120);
		const callIndex = rows.findIndex((row) => visibleText([row]).includes("$ inspect-api"));
		const headerIndex = rows.findIndex((row) => visibleText([row]).includes("ORCHESTRATOR"));
		const footerIndex = rows.findIndex((row) => visibleText([row]).includes("GRAPH"));
		assert.ok(callIndex > headerIndex + 2, "the call must sit below the header band");
		assert.ok(footerIndex > callIndex, "the footer must sit below the card");
		const callText = visibleText([rows[callIndex]!]);
		assert.match(callText, /^ \$/, "the card aligns with the chrome; only Box pad precedes $");
		assert.equal(visibleText([rows[callIndex - 1]!]).trim(), "", "the card keeps an inner top pad");
		assert.equal(visibleText([rows[callIndex - 2]!]).trim(), "", "canvas separates the header bar from the card");
		const tookIndex = rows.findIndex((row) => visibleText([row]).includes("Took 0s"));
		assert.ok(tookIndex > callIndex, "the duration footer belongs to the card");
		assert.ok(footerIndex > tookIndex + 1, "canvas separates the card from the footer bar");
		assert.equal(visibleText([rows[tookIndex + 1]!]).trim(), "", "the card keeps an inner bottom pad");
		assert.equal(visibleText([rows[footerIndex - 2]!]).trim(), "", "canvas sits above the footer bar");
		view.dispose();
	});

	test("collapsed multi-line errors keep the block inset and account for bounded rows", () => {
		const wideError = "first line\nsecond line\nthird line";
		const wideRows = renderToolDetail(tool({ status: "failed", result: undefined, error: wideError }), {
			width: 120,
			expandKey: "ctrl+o",
		}).split("\n");
		assert.deepEqual(wideRows, [
			"",
			' $ inspect-api {"branch":"feat/inspect","checks":["lint","test"]} ✗',
			"",
			" first line",
			" second line",
			" third line",
			"",
			" Took 0s",
			"",
		]);
		assert.ok(wideRows.filter((row) => row.includes("line")).every((row) => row.startsWith(" ")));

		const narrowRows = renderToolDetail(
			tool({
				status: "failed",
				result: undefined,
				error: `${"a".repeat(200)}\nSECOND-LINE-MARKER\nTHIRD-LINE-MARKER`,
			}),
			{ width: 60, expandKey: "ctrl+o" },
		).split("\n");
		assert.ok(
			narrowRows.some((row) => row.includes("SECOND-LINE-MARKER")),
			"second error line must remain visible",
		);
		assert.ok(
			narrowRows.some((row) => row.includes("THIRD-LINE-MARKER")),
			"third error line must remain visible",
		);
		assert.ok(narrowRows.slice(1).every((row) => row.trim() === "" || row.startsWith(" ") || row.includes("Took")));
		assert.ok(
			narrowRows.every((row) => visibleWidth(row) <= 60),
			"collapsed rows must fit the frame",
		);

		const manyRows = renderToolDetail(
			tool({
				status: "failed",
				result: undefined,
				error: Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n"),
			}),
			{ width: 80, expandKey: "ctrl+o" },
		).split("\n");
		assert.equal(manyRows.length, 17, `collapsed preview emitted ${manyRows.length} rows`);
		assert.ok(manyRows.some((row) => row.includes("line-199")));
		assert.match(manyRows.find((row) => row.includes("earlier lines")) ?? "", /190 earlier lines, ctrl\+o Expand/);
	});

	test("operator chrome keeps the result tail, sub-second timing, markers, paths, and shading", () => {
		const longResult = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
		const collapsed = renderToolDetail(
			tool({ status: "failed", result: undefined, error: longResult, startedAt: 100, endedAt: 111 }),
			{
				width: 40,
				expandKey: "ctrl+o",
			},
		);
		assert.match(collapsed, /earlier lines, ctrl\+o Expand/);
		assert.ok(collapsed.includes("line-19"));
		assert.ok(!collapsed.includes("line-0"));
		assert.match(collapsed, /Took 0s/);
		assert.doesNotMatch(collapsed, /\(0s\)|duration=/);

		const cached = renderToolDetail(
			tool({ status: "cached", replayed: true, result: "cached", startedAt: 100, endedAt: 111 }),
			{
				width: 80,
				expanded: true,
			},
		);
		assert.match(cached, /Took 0s · cached · replayed/);
		assert.doesNotMatch(cached, /MARKERS/);

		const path = "/Users/tonystark/Documents/projects/atomic-issue-2462/.ci-diagnostics/p0-2462/probe-1";
		const pathText = renderToolDetail(tool({ result: path }), { width: 40, expanded: true });
		assert.ok(pathText.includes("atomic-issue"));
		assert.doesNotMatch(pathText, /atomic-issu[^e]/);
		const pathRows = pathText.split("\n");
		const headerIndex = pathRows.findIndex((row) => row.includes("$"));
		assert.ok(headerIndex >= 0, "header must render");
		const continuation = pathRows
			.slice(headerIndex + 1)
			.find((row) => row.trim().length > 0 && !row.includes("Took"));
		assert.ok(continuation?.startsWith(" "), "wrapped header continuation must stay indented");

		const slashWrap = renderToolDetail(tool({ args: undefined, name: "t", result: "abcdef/next" }), {
			width: 7,
			expanded: true,
		});
		assert.match(slashWrap, /\//, "an unrendered slash must stay available on a later row");
		assert.match(slashWrap, /next/);
		const commaWrap = renderToolDetail(tool({ args: undefined, name: "t", result: "abcdef,tail" }), {
			width: 7,
			expanded: true,
		});
		assert.match(commaWrap, /,/, "an unrendered comma must stay available on a later row");
		assert.match(commaWrap, /tail/);
		const emojiWrap = renderToolDetail(tool({ args: undefined, name: "t", result: "👍/next" }), {
			width: 12,
			expanded: true,
		});
		assert.match(emojiWrap, /\//, "a one-cell emoji fallback must not swallow the following slash");
		assert.match(emojiWrap, /next/);

		const themed = renderToolDetail(tool({ result: "ok" }), { width: 40, theme: defaultTheme });
		assert.match(themed, /\x1b\[48;2;/);
		assert.doesNotMatch(renderToolDetail(tool({ result: "ok" }), { width: 40 }), /\x1b/);
		const themedRows = themed.split("\n");
		const footerIndex = themedRows.findIndex((row) => visibleText([row]).includes("Took 0s"));
		assert.ok(footerIndex > 0, "themed output must include the duration footer");
		assert.equal(visibleText([themedRows[footerIndex - 1]!]).trim(), "", "footer needs a blank separator row");
		assert.match(themedRows[footerIndex - 1]!, /\x1b\[48;2;/, "blank separator keeps the tool background");
		assert.match(themed, /\x1b\[38;2;180;190;254m/, "title uses host toolTitle");
		assert.match(themed, /\x1b\[38;2;205;214;244m/, "body uses host toolOutput");

		const longHint = renderToolDetail(
			tool({
				status: "failed",
				result: undefined,
				error: Array.from({ length: 24 }, (_, index) => `report-line-${index}`).join("\n"),
			}),
			{ width: 80, theme: defaultTheme, expandKey: "ctrl+o" },
		);
		assert.match(visibleText(longHint.split("\n")), /ctrl\+o Expand/);
		assert.match(longHint, /\x1b\[38;2;127;132;156mctrl\+o/, "expand key uses dim");
	});

	test("running tool headers omit the status marker without changing other status markers", () => {
		const plain = renderToolDetail(
			tool({ name: "push-propagated-2657", args: undefined, status: "running", endedAt: undefined }),
			{ width: 80, now: 2_000 },
		);
		const plainRows = plain.split("\n");
		const plainHeader = plainRows.find((row) => row.includes("$"));
		assert.equal(plainHeader?.trimEnd(), " $ push-propagated-2657");
		assert.doesNotMatch(plain, /●/);
		assert.match(plain, /Elapsed 1s/);

		const withArgs = renderToolDetail(
			tool({ name: "push", args: { branch: "main" }, status: "running", endedAt: undefined }),
			{ width: 80, now: 2_000 },
		);
		const argsHeader = withArgs.split("\n").find((row) => row.includes("$"));
		assert.equal(argsHeader?.trimEnd(), ' $ push {"branch":"main"}');

		const themedRows = renderToolDetail(
			tool({ name: "push", args: undefined, status: "running", endedAt: undefined }),
			{ width: 80, theme: defaultTheme, now: 2_000 },
		).split("\n");
		const themedHeader = themedRows.find((row) => visibleText([row]).includes("$"));
		assert.equal(themedHeader === undefined ? undefined : stripFrameEscapes(themedHeader).trimEnd(), " $ push");
		assert.doesNotMatch(visibleText(themedRows), /●/);
		assertFullyPainted(themedRows, 80, "running themed detail");

		for (const [status, marker] of [
			["failed", "✗"],
			["cached", "↻"],
			["cancelled", "⊘"],
			["pending", "○"],
		] as const) {
			const rendered = renderToolDetail(tool({ status, args: undefined }), { width: 80 });
			const header = rendered.split("\n").find((row) => row.includes("$"));
			assert.equal(header?.trimEnd(), ` $ inspect-api ${marker}`);
		}
	});

	test("collapsed previews use the full bounded body and exact visual tail count", () => {
		const longLines = Array.from({ length: 24 }, (_, index) => `report-line-${index}-abcdefghijklmnopqrstuvwxyz`);
		const wideRows = renderToolDetail(tool({ args: undefined, result: { ok: true, lines: longLines } }), {
			width: 80,
			expandKey: "ctrl+o",
		}).split("\n");
		assert.equal(wideRows[3], " ... (6 earlier lines, ctrl+o Expand)");
		assert.ok(wideRows.some((row) => row.includes("report-line-23")));
		assert.ok(!wideRows.some((row) => row.includes("report-line-0")));
		assert.doesNotMatch(wideRows.join("\n"), /… \[truncated\]/);

		const narrowRows = renderToolDetail(
			tool({
				args: undefined,
				result: { ok: true, lines: Array.from({ length: 24 }, (_, index) => `report-line-${index}`) },
			}),
			{ width: 40, expandKey: "ctrl+o" },
		).split("\n");
		assert.equal(narrowRows[3], " ... (3 earlier lines, ctrl+o Expand)");
		assert.ok(narrowRows.some((row) => row.includes("report-line-23")));
		assert.ok(!narrowRows.some((row) => row.includes("report-line-0")));
		assert.doesNotMatch(narrowRows.join("\n"), /… \[truncated\]/);
	});

	test("status-tinted backgrounds cover every rendered tool cell", () => {
		const cases = [
			["completed with args", tool({ result: "ok" })],
			["failed", tool({ status: "failed", result: undefined, error: "check failed", args: { attempt: 1 } })],
			["cached", tool({ status: "cached", replayed: true, result: "cached" })],
			["running", tool({ status: "running", endedAt: undefined, result: "working" })],
		] as const;
		for (const width of [40, 80]) {
			for (const [label, node] of cases) {
				const rows = renderToolDetail(node, { width, theme: defaultTheme, expanded: true, now: 2_000 }).split("\n");
				assertFullyPainted(rows, width, `${label} at ${width}`);
			}
		}
	});

	test("plain detail output stays ANSI-free when narrow rows are clipped", () => {
		const result = {
			lines: Array.from({ length: 24 }, (_, index) => `report-line-${index}-abcdefghijklmnopqrstuvwxyz`),
		};
		for (let width = 1; width <= 120; width++) {
			const rendered = renderToolDetail(tool({ result }), {
				width,
				expandKey: "ctrl+shift+alt+o",
				now: 2_000,
			});
			assert.doesNotMatch(rendered, /\x1b/, `plain width ${width} must not emit ANSI`);
		}
	});

	test("capped long result rendering stays within the responsive frame budget", () => {
		const LARGE_RESULT_RENDER_BUDGET_MS = 80;
		const node = tool({
			args: undefined,
			result: {
				lines: Array.from({ length: 600 }, (_, index) => `report-line-${index}-abcdefghijklmnopqrstuvwxyz`),
			},
		});
		renderToolDetail(node, { width: 40, now: 2_000 });
		const startedAt = performance.now();
		renderToolDetail(node, { width: 40, now: 2_000 });
		const elapsedMs = performance.now() - startedAt;
		assert.ok(
			elapsedMs < LARGE_RESULT_RENDER_BUDGET_MS,
			`capped result took ${elapsedMs.toFixed(1)}ms; budget is ${LARGE_RESULT_RENDER_BUDGET_MS}ms`,
		);
	});

	test("oversized errors and results share head truncation marker placement", () => {
		const oversized = `HEAD-MARKER${"e".repeat(TOOL_PAYLOAD_VALUE_LIMIT + 100)}TAIL-MARKER`;
		const outputs = [
			renderToolDetail(tool({ status: "failed", result: undefined, error: oversized }), {
				width: 80,
				expanded: true,
			}),
			renderToolDetail(tool({ result: oversized }), { width: 80, expanded: true }),
		];
		for (const output of outputs) {
			const body = output.slice(0, output.indexOf("Took")).trimEnd();
			const bodyWithoutNewlines = body.replace(/\n\s*/g, "");
			assert.ok(bodyWithoutNewlines.includes("HEAD-MARKER"));
			assert.doesNotMatch(body, /TAIL-MARKER/);
			assert.ok(body.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER));
		}
	});

	test("width wrapping does not emit lone surrogates when skipping a wide grapheme boundary", () => {
		const rendered = renderToolDetail(tool({ result: "👍👍/abc" }), { width: 3, expanded: true });
		const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		assert.doesNotMatch(rendered, loneSurrogate);
	});
	test("completed cards omit the empty marker row and keep the bash-like header", () => {
		const rendered = renderToolDetail(tool({ status: "completed", replayed: false }), {
			theme: defaultTheme,
			width: 96,
			expanded: true,
		});
		const text = visibleText(rendered.split("\n"));
		assert.match(text, /\$ inspect-api/);
		assert.doesNotMatch(text, /✓ inspect-api|\bMARKERS\b|\bARGS\b/);
	});
	test("large and unusual values render with an explicit truncation marker", () => {
		const huge = "x".repeat(20_000);
		assert.doesNotThrow(() => {
			const text = renderToolDetail(
				tool({
					args: { huge },
					result: { huge },
				}),
				{ theme: defaultTheme, width: 80, expanded: true },
			);
			assert.match(text, /… \[truncated\]/);
		});
		const errorText = renderToolDetail(tool({ status: "failed", result: undefined, error: "check failed" }), {
			theme: defaultTheme,
			width: 80,
			expanded: true,
		}).replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(errorText, /\$ inspect-api[\s\S]*check failed/);
	});

	test("failed, cached, and replayed tool nodes keep status markers in the message block", () => {
		const failed = visibleText(
			renderToolDetail(tool({ status: "failed", result: undefined, error: "check failed" }), {
				theme: defaultTheme,
				width: 96,
				expanded: true,
			}).split("\n"),
		);
		assert.match(failed, /✗/);
		assert.match(failed, /\$ inspect-api[\s\S]*check failed/);

		const cached = visibleText(
			renderToolDetail(tool({ status: "cached", replayed: true, resultSummary: "cached result" }), {
				theme: defaultTheme,
				width: 96,
				expanded: true,
			}).split("\n"),
		);
		assert.match(cached, /↻/);
		assert.match(cached, /Took 0s · cached · replayed/);

		const replayed = visibleText(
			renderToolDetail(tool({ replayed: true }), { theme: defaultTheme, width: 96, expanded: true }).split("\n"),
		);
		assert.match(replayed, /Took 0s · replayed/);
		assert.doesNotMatch(cached, /MARKERS/);
		assert.doesNotMatch(replayed, /MARKERS/);
	});

	test("malformed snapshot display values never make the detail renderer throw", () => {
		const cyclic: { self?: object } = {};
		cyclic.self = cyclic;
		const throwingCoercion = {
			toJSON(): never {
				throw new Error("toJSON failed");
			},
			toString(): never {
				throw new Error("toString failed");
			},
		};

		for (const [label, overrides, expected] of [
			["cyclic", { args: cyclic as never }, "<cycle>"],
			["BigInt", { result: 42n as never }, "42"],
			["throwing coercion", { args: throwingCoercion as never }, "<unserializable>"],
		] as const) {
			let rendered = "";
			assert.doesNotThrow(() => {
				rendered = renderToolDetail(tool(overrides), { theme: defaultTheme, width: 80 });
			}, label);
			assert.ok(rendered.includes(expected), `${label}: ${expected}`);
		}
	});

	test("durable tool execution carries exact args and result into snapshots", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "durable-detail",
			name: "detail",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		let started: ToolNodeSnapshot | undefined;
		let ended: ToolNodeSnapshot | undefined;
		const tool = createToolPrimitive({
			workflowId: "durable-detail",
			backend,
			nextCheckpointId: () => "unused",
			throwIfCancelled() {},
			onNodeStart(node) {
				started = node;
			},
			onNodeEnd(nodeId, update) {
				ended = { ...(started as ToolNodeSnapshot), id: nodeId, ...update };
			},
		});
		const args = { branch: "feat/inspect", duplicate: ["same", "same"] };
		const result = { ok: true, value: ["first", "second"] };
		assert.deepEqual(await tool("inspect", args, async () => result), result);
		assert.deepEqual(started?.args, args);
		assert.deepEqual(ended?.result, result);
		const checkpoint = backend.listCheckpoints("durable-detail").find((entry) => entry.kind === "tool");
		assert.deepEqual(checkpoint?.kind === "tool" ? checkpoint.args : undefined, args);
		assert.deepEqual(checkpoint?.kind === "tool" ? checkpoint.output : undefined, result);
	});

	test("graph snapshots detach full tool payloads before freezing them", () => {
		const args = { nested: { values: ["first", "second"] } };
		const result = { nested: { ok: true } };
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "snapshot run",
			inputs: {},
			status: "completed",
			stages: [],
			toolNodes: [tool({ args, result })],
			startedAt: 1,
			endedAt: 2,
		});
		const snapshotNode = store.graphSnapshot().runs[0]?.toolNodes?.[0];
		assert.deepEqual(snapshotNode?.args, args);
		assert.deepEqual(snapshotNode?.result, result);
		assert.notStrictEqual(snapshotNode?.args, args);
		assert.notStrictEqual(snapshotNode?.result, result);
		assert.notStrictEqual(snapshotNode?.args?.nested, args.nested);
		assert.notStrictEqual(snapshotNode?.result?.nested, result.nested);
		assert.equal(Object.isFrozen(args), false);
		assert.equal(Object.isFrozen(result), false);
	});

	test("detail view keeps large payloads scrollable without activating graph controls", () => {
		const source = Array.from({ length: 2_000 }, (_, index) => `source-line-${index}`).join("\n");
		const view = viewFor(tool({ source }));
		view.render(120);
		assert.equal(view.handleInput("\r"), true);
		assert.equal(view.handleInput("\x0f"), true);
		view.render(120);
		assert.equal(view.handleInput("\x1b[<65;1;1M"), true);
		assert.ok(view._graphScrollOffset > 0);
		assert.equal(view.handleInput("q"), false);
		assert.ok(view._toolDetail);
		view.dispose();
	});

	test("the real graph view survives hostile payloads through the store projection", () => {
		const selfReferential: Record<string, unknown> = {};
		selfReferential.self = selfReferential;
		// Reviewer-reported shape: an own enumerable `toJSON` that throws, on a
		// cyclic object. `structuredClone` rejects the function, and the old
		// hand-rolled fallback then recursed on the cycle until the stack died.
		const throwingToJson: Record<string, unknown> = {
			toJSON(): never {
				throw new Error("toJSON boom");
			},
		};
		throwingToJson.self = throwingToJson;
		const throwingGetter: Record<string, unknown> = {};
		Object.defineProperty(throwingGetter, "boom", {
			enumerable: true,
			get() {
				throw new Error("getter boom");
			},
		});

		for (const [label, payload, expected] of [
			["cyclic with throwing toJSON", { hostile: throwingToJson, loop: selfReferential }, "<unserializable>"],
			["enumerable throwing getter", { hostile: throwingGetter }, "<unreadable>"],
		] as const) {
			let view!: GraphView;
			assert.doesNotThrow(() => {
				view = viewFor(tool({ args: payload as never, result: payload as never }));
			}, `${label}: constructing the view must not throw`);
			let text = "";
			assert.doesNotThrow(() => {
				view.render(120);
				assert.equal(view.handleInput("\r"), true);
				text = visibleText(view.render(120));
			}, `${label}: opening the detail must not throw`);
			assert.ok(view._toolDetail, label);
			assert.ok(text.includes("inspect-api"), `${label}: renders the tool`);
			assert.ok(text.includes(expected), `${label}: ${expected}`);
			view.dispose();
		}

		const cycleView = viewFor(tool({ args: { loop: selfReferential } as never }));
		cycleView.render(120);
		cycleView.handleInput("\r");
		assert.ok(visibleText(cycleView.render(120)).includes("<cycle>"));
		cycleView.dispose();
	});

	test("the graph projection retains bounded tool payloads", () => {
		const huge = "y".repeat(2_000_000);
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "bounded run",
			inputs: {},
			status: "completed",
			stages: [],
			toolNodes: [tool({ args: { huge }, result: { huge } })],
			startedAt: 1,
			endedAt: 2,
		});

		const node = store.graphSnapshot().runs[0]?.toolNodes?.[0];
		assert.ok(node);
		const retained = [node.args?.huge as string, (node.result as { huge: string }).huge];
		for (const value of retained) {
			assert.ok(
				value.length <= TOOL_PAYLOAD_VALUE_LIMIT + TOOL_PAYLOAD_TRUNCATION_MARKER.length,
				`retained ${value.length} characters`,
			);
			assert.ok(value.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER));
			// Verbatim within the cap: nothing normalized, reordered, or dropped.
			assert.equal(value.slice(0, 32), huge.slice(0, 32));
		}
	});

	test("detail serialization is bounded by the display cap rather than the payload", () => {
		const entries = 20_000;
		let reads = 0;
		const target: Record<string, string> = {};
		for (let index = 0; index < entries; index++) target[`field${index}`] = "";
		const probe = new Proxy(target, {
			get(_target, key) {
				if (typeof key === "string" && key.startsWith("field")) reads += 1;
				return "v".repeat(64);
			},
		});

		const rendered = renderToolDetail(tool({ args: probe as never }), {
			theme: defaultTheme,
			width: 96,
			expanded: true,
		});
		assert.ok(reads > 0, "the serializer must read the payload it displays");
		// One capped field cannot cost a whole payload walk: ~16 KiB of output at
		// ~77 characters per entry settles near 200 reads, never 20,000.
		assert.ok(reads < entries / 10, `observed ${reads} property reads`);
		assert.ok(rendered.includes(TOOL_PAYLOAD_TRUNCATION_MARKER.slice(0, 3)));
	});

	test("timing stays inspectable at the narrowest supported detail width", () => {
		const rendered = renderToolDetail(tool({ startedAt: 1786890801337, endedAt: 1786890801341 }), {
			theme: defaultTheme,
			width: 40,
			expanded: true,
		});
		const text = visibleText(rendered.split("\n"));
		assert.ok(text.includes("Took 0s"));
		assert.doesNotMatch(text, /startedAt=|endedAt=|duration=|\(0s\)/);
	});

	test("callback source is captured at registration, persisted, and rendered", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "durable-source",
			name: "source",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		let started: ToolNodeSnapshot | undefined;
		let callbackRuns = 0;
		const durableTool = createToolPrimitive({
			workflowId: "durable-source",
			backend,
			nextCheckpointId: () => "unused",
			throwIfCancelled() {},
			onNodeStart(node) {
				started = node;
			},
		});
		await durableTool("inspect", {}, async () => {
			callbackRuns += 1;
			return { published: true };
		});

		assert.equal(callbackRuns, 1, "capturing source must not re-execute the callback");
		assert.ok(started?.source?.includes("published: true"), started?.source);
		const checkpoint = backend.listCheckpoints("durable-source").find((entry) => entry.kind === "tool");
		assert.equal(checkpoint?.kind === "tool" ? checkpoint.source : undefined, started?.source);

		const rendered = renderToolDetail(tool({ source: started?.source }), {
			theme: defaultTheme,
			width: 96,
			expanded: true,
		});
		assert.ok(rendered.includes("published: true"));

		const oversized = `${"s".repeat(TOOL_PAYLOAD_VALUE_LIMIT + 1_000)}`;
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "source run",
			inputs: {},
			status: "completed",
			stages: [],
			toolNodes: [tool({ source: oversized })],
			startedAt: 1,
			endedAt: 2,
		});
		const retained = store.graphSnapshot().runs[0]?.toolNodes?.[0]?.source ?? "";
		assert.equal(retained.length, TOOL_PAYLOAD_VALUE_LIMIT);
		assert.ok(retained.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER));
		assert.ok(
			renderToolDetail(tool({ source: oversized }), { theme: defaultTheme, width: 96, expanded: true }).includes(
				TOOL_PAYLOAD_TRUNCATION_MARKER,
			),
		);
	});

	test("tool cards render a constant body while status keeps the result summary", () => {
		const nodes = [
			tool({ id: "tool:done", name: "done", argsHash: "h1", status: "completed", resultSummary: '"published"' }),
			tool({
				id: "tool:failed",
				name: "failed",
				argsHash: "h2",
				status: "failed",
				result: undefined,
				resultSummary: undefined,
				error: "publish rejected",
			}),
			tool({ id: "tool:live", name: "live", argsHash: "h3", status: "running", endedAt: undefined }),
		];
		const run = {
			id: RUN_ID,
			name: "card run",
			inputs: {},
			status: "running" as const,
			stages: [],
			toolNodes: nodes,
			startedAt: 1,
		};
		const graph = expandWorkflowGraph({ runs: [run], notices: [], version: 1 }, RUN_ID);

		for (const node of nodes) {
			const card = graph.renderStages.find((stage) => stage.toolStatus === node.status);
			assert.ok(card !== undefined, node.status);
			const rows = renderNodeCard(card, { theme: defaultTheme })
				.map((row) =>
					row
						.replace(ANSI_RE, "")
						.replace(/[│╭╮╰╯─]/g, "")
						.trim(),
				)
				.filter((row) => row.length > 0);
			assert.ok(rows.includes("durable tool"), `${node.status}: ${rows.join(" | ")}`);
			assert.ok(!rows.some((row) => row.includes("publish rejected")), `${node.status}: no error preview`);
			assert.ok(!rows.some((row) => row.includes("published")), `${node.status}: no result preview`);
		}

		const summarized = summarizeRunSnapshot(run, 300).tools.find((entry) => entry.name === "done");
		assert.equal(summarized?.resultSummary, '"published"');
	});

	test("the session list survives every non-clonable tool result the store can hold", () => {
		const withOwnFunction: Record<string, unknown> = { ok: true, retry: () => undefined };
		const withProxy = new Proxy({ ok: true }, {});
		const variants: Array<readonly [string, unknown]> = [
			["baseline", undefined],
			["plain", { ok: true }],
			["own function property", withOwnFunction],
			["promise", { pending: Promise.resolve("later") }],
			["proxy", { proxied: withProxy }],
			["symbol value", { marker: Symbol("tool") }],
			["weakmap", { cache: new WeakMap() }],
		];

		for (const [label, result] of variants) {
			const store = storeWithToolResult(result);
			assert.doesNotThrow(() => {
				renderSessionList(store.runs(), { theme: defaultTheme, includeAll: true });
			}, `${label}: renderSessionList must not throw`);
			assert.doesNotThrow(() => {
				structuredClone(store.runs()[0]?.toolNodes?.[0]);
			}, `${label}: the stored node must stay clonable`);
		}
	});

	test("an inspection-only field never invalidates a durable checkpoint", async () => {
		// Args whose `toJSON` runs are reachable end to end. A *throwing* `toJSON`
		// getter is not: `durableHash` reads the raw args first and rejects the
		// call before any inspection copy exists, which is pre-existing identity
		// behavior this change must not alter. Its stored shape is covered by the
		// envelope cases below, which is where the suppression risk lives.
		const hostileArgs: Array<readonly [string, Record<string, unknown>]> = [
			[
				"throwing toJSON",
				{
					branch: "feat/x",
					toJSON(): never {
						throw new Error("args toJSON boom");
					},
				},
			],
			["array toJSON", { branch: "feat/x", toJSON: () => ["a", "b"] }],
			["string toJSON", { branch: "feat/x", toJSON: () => "flat" }],
		];

		for (const [label, args] of hostileArgs) {
			const backend = new InMemoryDurableBackend();
			const workflowId = `durable-args-${label.replace(/\s+/g, "-")}`;
			backend.registerWorkflow({ workflowId, name: label, inputs: {}, createdAt: 1, status: "running" });
			const durableTool = createToolPrimitive({
				workflowId,
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled() {},
			});
			await durableTool("inspect", args as never, async () => ({ ok: true }));
			const checkpoint = backend.listCheckpoints(workflowId).find((entry) => entry.kind === "tool");
			assert.ok(checkpoint, label);
			const envelope = encodeCheckpoint(checkpoint);
			const classified = classifyCheckpointPayload(workflowId, checkpoint.checkpointId, envelope);
			assert.equal(classified.kind, "current", `${label}: a tool checkpoint must never classify as unknown`);
		}

		// A decoder must also tolerate a stored field it did not expect rather
		// than discarding the workflow that owns it.
		const base = {
			kind: "tool" as const,
			workflowId: "legacy",
			checkpointId: "tool:legacy",
			name: "legacy",
			argsHash: "legacy-hash",
			output: { ok: true },
			completedAt: 5,
		};
		const legacyEnvelope = encodeCheckpoint(base);
		assert.equal(classifyCheckpointPayload("legacy", "tool:legacy", legacyEnvelope).kind, "current");
		assert.equal(legacyEnvelope.args, undefined, "a legacy envelope carries no args");

		for (const [label, override] of [
			["string args", { args: "flat" }],
			["array args", { args: ["a", "b"] }],
			["null args", { args: null }],
			["unserializable placeholder args", { args: "<unserializable>" }],
			["unreadable placeholder args", { args: "<unreadable>" }],
			["numeric source", { source: 42 }],
		] as const) {
			const classified = classifyCheckpointPayload("legacy", "tool:legacy", {
				...legacyEnvelope,
				...override,
			} as never);
			assert.equal(classified.kind, "current", `${label}: must decode, not suppress the workflow`);
			if (classified.kind === "current" && classified.checkpoint.kind === "tool") {
				assert.equal(classified.checkpoint.output !== undefined, true, `${label}: replayable output survives`);
			}
		}
	});

	test("bounding the live store never bounds the replayed durable output", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "durable-replay",
			name: "replay",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const oversized = "z".repeat(TOOL_PAYLOAD_VALUE_LIMIT * 2);
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "replay run",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		const primitiveFor = (onNodeStart?: (node: ToolNodeSnapshot) => void) =>
			createToolPrimitive({
				workflowId: "durable-replay",
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled() {},
				onNodeStart(node) {
					onNodeStart?.(node);
					store.recordToolNodeStart(RUN_ID, { ...node, status: "pending" });
				},
				onNodeEnd(nodeId, update) {
					store.recordToolNodeEnd(RUN_ID, nodeId, update);
				},
			});

		const first = await primitiveFor()("big", {}, async () => ({ big: oversized }));
		assert.equal((first as { big: string }).big.length, oversized.length);

		let replayExecutions = 0;
		const replayed = await primitiveFor()("big", {}, async () => {
			replayExecutions += 1;
			return { big: "re-executed" };
		});
		assert.equal(replayExecutions, 0, "a cached call must not re-execute");
		assert.deepEqual(replayed, first, "the replayed value must be the exact original output");
		assert.equal((replayed as { big: string }).big.length, oversized.length);

		const retained = store.runs()[0]?.toolNodes?.[0]?.result as { big: string };
		assert.ok(
			retained.big.length <= TOOL_PAYLOAD_VALUE_LIMIT + TOOL_PAYLOAD_TRUNCATION_MARKER.length,
			`live store retained ${retained.big.length} characters`,
		);
		assert.ok(retained.big.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER));
	});

	test("the live store keeps a multi-megabyte tool result bounded", () => {
		const store = storeWithToolResult({ payload: "m".repeat(5_000_000) });
		const serialized = JSON.stringify(store.snapshot());
		assert.ok(serialized.length < 100_000, `store.snapshot() serialized to ${serialized.length} bytes`);
		assert.ok(serialized.includes(TOOL_PAYLOAD_TRUNCATION_MARKER));
	});

	test("the detail view scrolls from the keyboard alone", () => {
		const source = Array.from({ length: 600 }, (_, index) => `source-line-${index}`).join("\n");
		const view = viewFor(tool({ source }));
		view.render(120);
		assert.equal(view.handleInput("\r"), true);
		assert.equal(view.handleInput("\x0f"), true);
		view.render(120);
		assert.equal(view._graphScrollOffset, 0);

		assert.equal(view.handleInput(KEY_DOWN), true);
		view.render(120);
		const afterDown = view._graphScrollOffset;
		assert.equal(afterDown, 1, "Down scrolls one row");

		assert.equal(view.handleInput(KEY_PAGE_DOWN), true);
		view.render(120);
		const afterPage = view._graphScrollOffset;
		assert.ok(afterPage > afterDown + 1, `PageDown advanced to ${afterPage}`);

		assert.equal(view.handleInput(KEY_PAGE_UP), true);
		view.render(120);
		assert.ok(view._graphScrollOffset < afterPage, "PageUp scrolls back");

		assert.equal(view.handleInput(KEY_END), true);
		const atEnd = visibleText(view.render(120));
		assert.ok(view._graphScrollOffset > afterPage, "End reaches the bottom");
		assert.ok(atEnd.includes("source-line-599"), "the last source row is reachable without a mouse event");
		assert.ok(atEnd.includes("Took 0s"));

		assert.equal(view.handleInput(KEY_HOME), true);
		view.render(120);
		assert.equal(view._graphScrollOffset, 0, "Home returns to the first row");

		assert.equal(view.handleInput(KEY_UP), true);
		view.render(120);
		assert.equal(view._graphScrollOffset, 0, "Up at the top stays clamped");
		assert.ok(view._toolDetail, "scrolling never closes the detail");
		view.dispose();
	});

	test("source text cannot desynchronize the box or emit escape sequences", () => {
		const width = 60;
		for (const [label, source] of [
			["tab indented", "async () => {\n\treturn {\n\t\tok: true,\n\t};\n}"],
			["embedded escape", "async () => {\n\tconsole.log('\x1b[31mred\x1b[0m');\n\treturn null;\n}"],
			["carriage return and bell", "async () => {\r\n\treturn '\x07';\r\n}"],
		] as const) {
			const lines = renderToolDetail(tool({ source, name: `tool\x1b[31m-${label}` }), {
				width,
				expanded: true,
			}).split("\n");
			for (const [index, line] of lines.entries()) {
				assert.ok(visibleWidth(line) <= width, `${label}: row ${index} overflows`);
			}
			const rendered = lines.join("\n");
			assert.ok(!rendered.includes("\x1b"), `${label}: no raw escape byte reaches the frame`);
			assert.ok(!rendered.includes("\x07"), `${label}: no raw bell reaches the frame`);
			assert.ok(!rendered.includes("\t"), `${label}: tabs are expanded`);
		}
	});

	test("the scroll range always equals the rows the body really rendered", () => {
		// The height callback and body callback receive the same detail width,
		// including when a scrollbar column is reserved.
		const source = Array.from({ length: 800 }, (_, index) => `source-line-${index}`).join("\n");
		for (const width of [40, 60, 72, 79, 80, 81, 100, 101, 102, 110, 120]) {
			const view = viewForAtRows(tool({ source }), 40);
			const probe = withBodyWidthProbe(view);
			view.render(width);
			assert.equal(view.handleInput("\r"), true);
			assert.equal(view.handleInput("\x0f"), true);
			view.render(width);

			const bodyWidth = probe.bodyWidth();
			assert.ok(bodyWidth !== undefined, `width ${width}: the body must render`);
			const layout = (view as unknown as { graphLayout: { contentRows: number } }).graphLayout;
			assert.equal(
				layout.contentRows,
				probe.renderAll(bodyWidth).length,
				`width ${width}: scroll range must equal the rows produced at body width ${bodyWidth}`,
			);
			view.dispose();
		}
	});

	test("the tail of a capped payload is reachable on ordinary terminals", () => {
		const source = Array.from({ length: 800 }, (_, index) => `source-line-${index}`).join("\n");
		for (const [width, rows] of [
			[80, 40],
			[100, 24],
		] as const) {
			const view = viewForAtRows(tool({ source }), rows);
			view.render(width);
			assert.equal(view.handleInput("\r"), true);
			assert.equal(view.handleInput("\x0f"), true);
			view.render(width);

			assert.equal(view.handleInput(KEY_END), true);
			const atEnd = visibleText(view.render(width));
			assert.ok(atEnd.includes("source-line-799"), `${width}x${rows}: End must reveal the last source row`);
			assert.ok(atEnd.includes("Took 0s"), `${width}x${rows}: End must reveal the Took line`);
			for (const field of ["SOURCE", "TIMING", "MARKERS"]) assert.doesNotMatch(atEnd, new RegExp(field));

			assert.equal(view.handleInput(KEY_HOME), true);
			view.render(width);
			assert.equal(view._graphScrollOffset, 0);
			const keyboardOnly = keyboardScrollToBottom(view, width);
			assert.ok(keyboardOnly.includes("source-line-799"), `${width}x${rows}: PageDown must reveal the source tail`);
			assert.ok(keyboardOnly.includes("Took 0s"), `${width}x${rows}: PageDown must reveal the footer`);
			view.dispose();
		}
	});

	test("an ordinary result reaches the operator footer at 80x40", () => {
		const source = Array.from({ length: 500 }, (_, index) => `source-line-${index}`).join("\n");
		const view = viewForAtRows(tool({ result: { payload: "published" }, source }), 40);
		view.render(80);
		assert.equal(view.handleInput("\r"), true);
		assert.equal(view.handleInput("\x0f"), true);
		view.render(80);
		assert.equal(view.handleInput(KEY_END), true);
		const atEnd = visibleText(view.render(80));
		assert.ok(atEnd.includes("Took 0s"), "the operator footer must be reachable");
		assert.ok(atEnd.includes("source-line-499"));
		view.dispose();
	});

	test("End and PageDown reach the end of a long result", () => {
		const result = Array.from({ length: 300 }, (_, index) => `result-line-${index}`).join("\n");
		const view = viewForAtRows(tool({ result }), 24);
		view.render(80);
		assert.equal(view.handleInput("\r"), true);
		assert.equal(view.handleInput("\x0f"), true);
		view.render(80);

		assert.equal(view.handleInput(KEY_END), true);
		const atEnd = stripFrameEscapes(view.render(80).join("\n"));
		assert.match(atEnd, /result-\s*line-299/, "End must reveal the final result line");
		assert.ok(atEnd.includes("Took 0s"), "End must reveal the operator footer");

		assert.equal(view.handleInput(KEY_HOME), true);
		view.render(80);
		const keyboardOnly = stripFrameEscapes(keyboardScrollToBottom(view, 80));
		assert.match(keyboardOnly, /result-\s*line-299/, "PageDown must reveal the final result line");
		assert.ok(keyboardOnly.includes("Took 0s"), "PageDown must reveal the operator footer");
		view.dispose();
	});

	test("a focused tool node advertises its activation key", () => {
		const view = viewFor(tool());
		const graphFooter = visibleText(view.render(120));
		assert.ok(graphFooter.includes("↵"), "a focused tool node must offer an Enter affordance");
		assert.match(graphFooter, /↵ open tool detail/);
		assert.ok(graphFooter.includes("ctrl+x"), "the hierarchy chord stays first");

		// The compact fallback is width-driven and, at the budgets that select it,
		// only its leading hierarchy chord fits — for a tool node exactly as for a
		// stage node. Assert that shape is untouched rather than inventing a width
		// where the second segment would render.
		const compactFooter = visibleText(
			(view as unknown as { _renderStatusline: (width: number) => string[] })._renderStatusline(30),
		);
		assert.match(compactFooter, /ctrl\+x/);
		assert.ok(!compactFooter.includes("open tool detail"), "the compact budget drops the trailing segment");

		assert.equal(view.handleInput("\r"), true);
		const detailFooter = visibleText(view.render(120));
		assert.ok(detailFooter.includes("scroll"), "the open detail advertises scrolling instead");
		assert.ok(!detailFooter.includes("↵"), "the open detail has nothing left for Enter to activate");
		view.dispose();
	});

	test("an unbound expand action omits the statusline expand hint", () => {
		const unbound = viewFor(tool(), {
			matches(): boolean {
				return false;
			},
			getKeys(): readonly string[] {
				return [];
			},
		});
		assert.equal(unbound.handleInput("\r"), true);
		const collapsed = visibleText(unbound.render(120));
		assert.match(collapsed, /ctrl\+x return to graph/);
		assert.match(collapsed, /↑↓ pgup\/pgdn scroll/);
		assert.doesNotMatch(collapsed, /ctrl\+o expand|alt\+e expand/);
		assert.doesNotMatch(collapsed, / · \s+expand/);
		assert.doesNotMatch(collapsed, /GRAPH[^\n]*\bexpand\b/);
		assert.equal(unbound.handleInput("\x0f"), false, "an unbound host action must not expand");
		assert.equal(unbound._toolDetailExpanded, false);
		unbound.dispose();
	});

	test("stage-node statusline hints are unchanged", () => {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "stage run",
			inputs: {},
			status: "completed",
			stages: [
				{
					id: "retained",
					name: "retained",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					attachable: false,
					sessionFile: "/tmp/retained.jsonl",
				},
			],
			startedAt: 1,
			endedAt: 2,
		});
		const attachable = new GraphView({
			mode: "overlay",
			runId: RUN_ID,
			store,
			graphTheme: defaultTheme,
			piTui: { terminal: { rows: 32 } },
			onStageAttach() {},
		});
		assert.match(visibleText(attachable.render(120)), /↵ open stage chat/);
		attachable.dispose();

		const plainStore = createStore();
		plainStore.recordRunStart({
			id: RUN_ID,
			name: "stage run",
			inputs: {},
			status: "running",
			stages: [{ id: "pending", name: "pending", status: "pending", parentIds: [], toolEvents: [] }],
			startedAt: 1,
		});
		const plain = new GraphView({
			mode: "overlay",
			runId: RUN_ID,
			store: plainStore,
			graphTheme: defaultTheme,
			piTui: { terminal: { rows: 32 } },
		});
		// A stage node keeps the stage-chat wording it always had, whether or not
		// a retained session exists; only tool nodes changed.
		assert.match(visibleText(plain.render(120)), /↵ open stage chat/);
		plain.dispose();

		const emptyStore = createStore();
		const empty = new GraphView({
			mode: "overlay",
			runId: null,
			store: emptyStore,
			graphTheme: defaultTheme,
			piTui: { terminal: { rows: 32 } },
		});
		assert.ok(!visibleText(empty.render(120)).includes("↵"), "with no focused node the ↵ hint stays filtered out");
		empty.dispose();
	});

	test("every element kind advances the retention cap", () => {
		// JSON emits `null` for holes, `undefined`, functions, and symbols. A
		// walker that returns those without charging never reaches the cap, so a
		// multi-million-element array of them was retained whole.
		for (const [label, build] of UNCHARGED_ELEMENT_SHAPES) {
			const store = storeWithToolResult({ rows: build() });
			const rows = retainedRows(store);
			assert.ok(Array.isArray(rows), `${label}: rows must survive as an array`);
			assert.ok(
				rows.length <= TOOL_PAYLOAD_VALUE_LIMIT / 4,
				`${label}: retained ${rows.length} elements against a ${TOOL_PAYLOAD_VALUE_LIMIT} cap`,
			);
			assert.ok(
				rows.length >= TOOL_PAYLOAD_VALUE_LIMIT / 16,
				`${label}: retained only ${rows.length} elements — the cap must bound, not erase`,
			);
			assert.equal(rows.at(-1), TOOL_PAYLOAD_TRUNCATION_MARKER, `${label}: truncation stays marked`);
		}
	});

	test("a sparse array is bounded rather than densified", () => {
		const store = storeWithToolResult({ rows: new Array(20_000_000) });
		const rows = retainedRows(store);
		assert.ok(rows.length <= TOOL_PAYLOAD_VALUE_LIMIT / 4, `retained ${rows.length} of 20,000,000 holes`);
		assert.equal(rows.at(-1), TOOL_PAYLOAD_TRUNCATION_MARKER);
	});

	test("durable args stay bounded for uncharged element kinds", () => {
		const record = boundedToolPayloadRecord({ rows: new Array(3_000_000).fill(null) } as never);
		const rows = (record as { rows: unknown[] }).rows;
		assert.ok(Array.isArray(rows));
		assert.ok(rows.length <= TOOL_PAYLOAD_VALUE_LIMIT / 4, `durable args retained ${rows.length} elements`);

		const encoded = encodeCheckpoint({
			kind: "tool",
			workflowId: "durable-null-args",
			checkpointId: "tool:null-args",
			name: "null-args",
			args: record,
			argsHash: "null-args-hash",
			output: { ok: true },
			completedAt: 1,
		});
		const bytes = JSON.stringify(encoded).length;
		assert.ok(bytes < 100_000, `the durable checkpoint payload grew to ${bytes} bytes`);
	});

	test("repeated graph snapshots re-walk only a bounded payload", () => {
		const store = storeWithToolResult({ rows: new Array(5_000_000).fill(null) });
		for (const pass of ["first", "after a version bump"]) {
			if (pass !== "first") {
				// The projection memoizes per version, so bump it: the reviewers'
				// measurement re-paid the full walk on every unrelated store write.
				store.recordRunStart({
					id: "second-run",
					name: "second",
					inputs: {},
					status: "running",
					stages: [],
					startedAt: Date.now(),
				});
			}
			const started = performance.now();
			const snapshot = store.graphSnapshot();
			const elapsed = performance.now() - started;

			// Deterministic: what each pass copies is what the cap allows. The
			// wall-clock ceiling below is the secondary signal — the unbounded
			// walk measured 2798 ms and 2838 ms per pass under Bun — because a
			// timing assertion alone is runner- and load-dependent.
			const projectedNode = snapshot.runs[0]?.toolNodes?.[0];
			assert.ok(projectedNode, `${pass}: the projection keeps the tool node`);
			const projected = (projectedNode.result as { rows?: unknown[] }).rows;
			assert.ok(Array.isArray(projected), `${pass}: the projection keeps the array`);
			assert.ok(
				projected.length <= TOOL_PAYLOAD_VALUE_LIMIT / 4,
				`${pass}: the projection copied ${projected.length} elements`,
			);
			assert.ok(
				elapsed < LARGE_NULL_SNAPSHOT_BUDGET_MS,
				`${pass} graphSnapshot took ${elapsed.toFixed(1)} ms against a ${LARGE_NULL_SNAPSHOT_BUDGET_MS} ms budget`,
			);
		}
	});

	test("the collapsed and expanded message block stay width-safe at the narrowest frame", () => {
		const view = viewForAtRows(
			tool({
				status: "failed",
				result: undefined,
				error: Array.from({ length: 30 }, (_, index) => `error-line-${index}`).join("\n"),
				source: Array.from({ length: 80 }, (_, index) => `source-line-${index}`).join("\n"),
			}),
			24,
		);
		view.render(40);
		assert.equal(view.handleInput("\r"), true);
		const collapsed = visibleText(view.render(40));
		assert.match(collapsed, /earlier lines, ctrl\+o Exp/);
		assert.doesNotMatch(collapsed, /╰─{30,}╯/);
		assert.equal(view.handleInput("\x0f"), true);
		view.render(40);
		assert.equal(view.handleInput(KEY_END), true);
		const frame = view.render(40).map(stripFrameEscapes);
		const text = frame.join("\n");
		assert.match(text, /Took 0s/);
		assert.doesNotMatch(text, /SOURCE|TIMING|MARKERS|startedAt=|endedAt=|duration=/);
		assert.doesNotMatch(text, /╰─{30,}╯/);
		for (const row of frame) assert.ok(visibleWidth(row) <= 40, `row overflowed: ${JSON.stringify(row)}`);
		view.dispose();
	});

	test("tool snapshots remain non-attachable", () => {
		assert.equal(tool().attachable, false);
	});
});
