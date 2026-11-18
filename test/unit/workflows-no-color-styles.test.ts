import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, test, vi } from "vitest";
import { refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { RunDetail } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { paint } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import {
	paintOnFill,
	paint as paintStageChat,
} from "../../packages/workflows/src/tui/stage-chat-view-render-helpers.js";
import { openWorkflowsListing } from "../../packages/workflows/src/tui/workflows-listing.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { makeTestTui as makeGraphTui, makeRun, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";
import { makeHandle, makeTestTui as makeStageTui } from "./stage-chat-view-helpers.js";

/** The block a stage chat draws as its composer cursor: the one inverse cell it keeps under NO_COLOR. */
const CURSOR_BLOCK = "\x1b[7m \x1b[0m";
/** Any SGR sequence that sets a style or a color. Only resets (0, 22, 23, 24, 27, 29, 39 and 49) are allowed. */
const STYLE_SGR = /\x1b\[(?!(?:0|22|23|24|27|29|39|49)?m)[0-9;]*m/;
const BOLD_SGR = /\x1b\[(?:[0-9;]*;)?1(?:;[0-9;]*)?m/;

afterEach(() => {
	vi.unstubAllEnvs();
	refreshColorEnvironment();
});

function colorEnv(env: { NO_COLOR?: string; FORCE_COLOR?: string }): void {
	vi.stubEnv("NO_COLOR", env.NO_COLOR);
	vi.stubEnv("FORCE_COLOR", env.FORCE_COLOR);
	refreshColorEnvironment();
}

function graphLines(): string[] {
	const view = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([makeStage("first"), makeStage("second", ["first"])])),
		graphTheme: deriveGraphTheme({}),
		piTui: makeGraphTui(24),
	});
	try {
		return view.render(100);
	} finally {
		view.dispose();
	}
}

function stageChatLines(): string[] {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "publish-release",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: Date.now(),
	});
	store.recordStageStart("run-1", {
		id: "stage-a",
		name: "implement",
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
	const { handle } = makeHandle();
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "publish-release",
		handle,
		piTui: makeStageTui(12),
		onDetach: () => {},
		onClose: () => {},
	});
	try {
		return view.render(100);
	} finally {
		view.dispose();
	}
}

const RUN_DETAIL: RunDetail = {
	runId: "abc123uuid",
	name: "refactor-auth",
	status: "failed",
	mode: "chain",
	startedAt: 1_000,
	endedAt: 66_000,
	durationMs: 65_000,
	inputs: { task: "rename" },
	stages: [
		{
			id: "s1",
			name: "plan",
			status: "completed",
			parentIds: [],
			toolEvents: [],
			startedAt: 1_000,
			endedAt: 9_000,
		},
		{
			id: "s2",
			name: "build",
			status: "failed",
			parentIds: ["s1"],
			toolEvents: [],
			startedAt: 9_000,
			endedAt: 66_000,
		},
	],
	tools: [],
	error: "build failed",
};

function runSheetLines(): string[] {
	return renderRunDetail(RUN_DETAIL, { theme: deriveGraphTheme({}), now: 66_000, width: 100 }).split("\n");
}

function listingLines(): string[] {
	const runs = makeSnap([makeStage("first")]).runs;
	let lines: string[] = [];
	openWorkflowsListing(
		{
			custom(factory) {
				const mounted = factory({ terminal: { rows: 30 }, requestRender() {} }, undefined, undefined, () => {});
				assert.ok(!(mounted instanceof Promise), "the listing mounts synchronously");
				lines = mounted.render(100);
				mounted.dispose?.();
				return Promise.resolve(undefined);
			},
		},
		{ runs: () => runs },
	);
	return lines;
}

const SURFACES: ReadonlyArray<readonly [string, () => string[]]> = [
	["graph view", graphLines],
	["stage chat", stageChatLines],
	["run sheet", runSheetLines],
	["/workflows list", listingLines],
];

function styledSequences(lines: readonly string[]): string[] {
	return lines.join("\n").replaceAll(CURSOR_BLOCK, "").match(new RegExp(STYLE_SGR, "g")) ?? [];
}

test("NO_COLOR leaves no bold, italic or other text style in any workflow surface, and keeps their text", () => {
	colorEnv({});
	const styled = new Map(SURFACES.map(([name, render]) => [name, render()]));
	for (const [name, lines] of styled)
		assert.ok(styledSequences(lines ?? []).length > 0, `${name} is styled by default`);
	for (const env of [{ NO_COLOR: "1" }, { FORCE_COLOR: "0" }]) {
		colorEnv(env);
		for (const [name, render] of SURFACES) {
			const lines = render();
			assert.deepEqual(styledSequences(lines), [], `${name} under ${JSON.stringify(env)}`);
			assert.deepEqual(
				lines.map((line) => stripVTControlCharacters(line)),
				styled.get(name)?.map((line) => stripVTControlCharacters(line)),
				`${name} text and layout under ${JSON.stringify(env)}`,
			);
		}
	}
});

test("bold and italic stay on with color: FORCE_COLOR 1, 2 and 3 and no setting keep them", () => {
	for (const env of [{ FORCE_COLOR: "1" }, { FORCE_COLOR: "2" }, { FORCE_COLOR: "3" }, {}]) {
		colorEnv(env);
		assert.match(paint("word", "#89b4fa", { bold: true }), BOLD_SGR, JSON.stringify(env));
		assert.match(paintStageChat("word", "#89b4fa", { italic: true }), /\x1b\[3m/, JSON.stringify(env));
		assert.match(graphLines().join("\n"), BOLD_SGR, JSON.stringify(env));
	}
});

test("the workflow paint helpers write plain text under NO_COLOR", () => {
	colorEnv({ NO_COLOR: "1" });
	const resets = /\x1b\[(?:0|22|23|39|49)?m/g;
	assert.equal(paint("word", "#89b4fa", { bg: "#313244", bold: true }).replace(resets, ""), "word");
	assert.equal(paintStageChat("word", "#89b4fa", { bold: true, italic: true }).replace(resets, ""), "word");
	assert.equal(paintOnFill("word", "#89b4fa", { bold: true, italic: true }).replace(resets, ""), "word");
});

test("painting workflow text styles never reads NO_COLOR or FORCE_COLOR", () => {
	colorEnv({});
	const theme = deriveGraphTheme({});
	const original = process.env;
	let reads = 0;
	process.env = new Proxy(original, {
		get(target, key, receiver) {
			if (key === "NO_COLOR" || key === "FORCE_COLOR") reads++;
			return Reflect.get(target, key, receiver);
		},
	});
	try {
		for (let i = 0; i < 1_000; i++) {
			paint("word", "#a6e3a1", { bold: true });
			paintStageChat("word", "#a6e3a1", { bold: true, italic: true });
			paintOnFill("word", "#a6e3a1", { bold: true, italic: true });
			renderRunDetail(RUN_DETAIL, { theme, now: 66_000, width: 100 });
		}
	} finally {
		process.env = original;
	}
	assert.equal(reads, 0);
});

test("an open graph and its run detail repaint without text styles after NO_COLOR is set, and with them after it is cleared", () => {
	colorEnv({});
	const failed = {
		...makeStage("build"),
		status: "failed" as const,
		startedAt: 1_000,
		endedAt: 9_000,
		error: "build failed",
	};
	const run = {
		...makeRun([failed]),
		status: "failed" as const,
		startedAt: 1_000,
		endedAt: 9_000,
		error: "build failed",
	};
	const view = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: run.id,
		store: makeStore({ runs: [run], notices: [], version: 1 }),
		graphTheme: deriveGraphTheme({}),
		piTui: makeGraphTui(24),
	});
	try {
		for (const open of [undefined, "o"] as const) {
			colorEnv({});
			if (open) view.handleInput(open);
			const styled = view.render(100);
			assert.match(styled.join("\n"), BOLD_SGR, `${open ?? "graph"}: bold first`);
			colorEnv({ NO_COLOR: "1" });
			view.invalidate();
			const plain = view.render(100);
			assert.deepEqual(styledSequences(plain), [], `${open ?? "graph"}: no styles after NO_COLOR`);
			colorEnv({});
			view.invalidate();
			assert.equal(view.render(100).join("\n"), styled.join("\n"), `${open ?? "graph"}: styles come back`);
			if (open) view.handleInput("\x1b");
		}
	} finally {
		view.dispose();
	}
});
