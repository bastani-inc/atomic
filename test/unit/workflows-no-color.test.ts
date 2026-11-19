import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { RunDetail } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { hexBg, hexToAnsi, paint } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { type RunOutcome, renderRunOutcome } from "../../packages/workflows/src/tui/run-outcome.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { openWorkflowsListing } from "../../packages/workflows/src/tui/workflows-listing.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { makeTestTui as makeGraphTui, makeRun, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";
import { makeHandle, makeTestTui as makeStageTui } from "./stage-chat-view-helpers.js";

/** An SGR sequence that sets a color (not one that restores the default with 39 or 49). */
const COLOR_SGR = /\x1b\[(?:[0-9;]*;)?(?:3[0-8]|4[0-8]|9[0-7]|10[0-7])(?:;[0-9;]*)?m/;
const TRUECOLOR_SGR = /\x1b\[(?:[0-9;]*;)?[34]8;2;/;
const COLOR_256_SGR = /\x1b\[(?:[0-9;]*;)?[34]8;5;/;

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

function runSheetLines(): string[] {
	const detail: RunDetail = {
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
	return renderRunDetail(detail, { theme: deriveGraphTheme({}), now: 66_000, width: 100 }).split("\n");
}

const OUTCOME: RunOutcome = {
	runId: "abc123uuid",
	name: "refactor-auth",
	state: "failed",
	elapsedMs: 65_000,
	reason: "build failed",
	outputs: [],
	artifacts: [],
	blockers: [],
	events: [],
	log: [],
};

const SURFACES: ReadonlyArray<readonly [string, () => string[]]> = [
	["graph view", graphLines],
	["stage chat", stageChatLines],
	["run sheet", runSheetLines],
];

test("NO_COLOR leaves no color in the workflow graph, a stage chat or a run sheet, and keeps their text", () => {
	colorEnv({});
	const colored = new Map(SURFACES.map(([name, render]) => [name, render()]));
	colorEnv({ NO_COLOR: "1" });
	for (const [name, render] of SURFACES) {
		const lines = render();
		const raw = lines.join("\n");
		assert.doesNotMatch(raw, COLOR_SGR, `${name} paints a color under NO_COLOR`);
		assert.deepEqual(
			lines.map((line) => stripVTControlCharacters(line)),
			colored.get(name)?.map((line) => stripVTControlCharacters(line)),
			`${name} text and layout`,
		);
	}
});

test("FORCE_COLOR=0 turns workflow colors off like NO_COLOR", () => {
	colorEnv({ FORCE_COLOR: "0" });
	assert.equal(hexToAnsi("#89b4fa"), "");
	assert.equal(hexBg("#313244"), "");
	assert.equal(paint("word", "#89b4fa", { bg: "#313244" }).replace(/\x1b\[0m/g, ""), "word");
	assert.doesNotMatch(graphLines().join("\n"), COLOR_SGR);
});

test("FORCE_COLOR=1 and 2 limit workflow colors to 256, and FORCE_COLOR=3 or no setting keeps true color", () => {
	for (const forced of ["1", "2"]) {
		colorEnv({ FORCE_COLOR: forced });
		assert.match(hexToAnsi("#89b4fa"), /^\x1b\[38;5;\d+m$/, `FORCE_COLOR=${forced} foreground`);
		assert.match(hexBg("#313244"), /^\x1b\[48;5;\d+m$/, `FORCE_COLOR=${forced} background`);
		for (const [name, render] of SURFACES) {
			const raw = render().join("\n");
			assert.doesNotMatch(raw, TRUECOLOR_SGR, `${name} under FORCE_COLOR=${forced}`);
			assert.match(raw, COLOR_256_SGR, `${name} under FORCE_COLOR=${forced} keeps colors`);
		}
	}
	for (const env of [{ FORCE_COLOR: "3" }, {}]) {
		colorEnv(env);
		assert.equal(hexToAnsi("#89b4fa"), "\x1b[38;2;137;180;250m");
		assert.equal(hexBg("#313244"), "\x1b[48;2;49;50;68m");
		assert.match(graphLines().join("\n"), TRUECOLOR_SGR);
	}
});

test("painting workflow colors never reads NO_COLOR or FORCE_COLOR", () => {
	colorEnv({});
	const theme = deriveGraphTheme({});
	const outcome = OUTCOME;
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
			hexToAnsi("#89b4fa");
			hexBg("#313244");
			paint("word", "#a6e3a1", { bg: "#1e1e2e", bold: true });
			renderRunOutcome(outcome, { theme, width: 100, logs: false, selected: 0 });
		}
	} finally {
		process.env = original;
	}
	assert.equal(reads, 0);
});

test("an open detail view repaints in the new color level after the color environment changes", () => {
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
		for (const open of ["o", "enter"] as const) {
			colorEnv({});
			view.handleInput(open === "o" ? "o" : "\r");
			const colored = view.render(100);
			assert.match(colored.join("\n"), TRUECOLOR_SGR, `${open}: detail painted in true color first`);
			colorEnv({ NO_COLOR: "1" });
			view.invalidate();
			const plain = view.render(100);
			assert.doesNotMatch(plain.join("\n"), COLOR_SGR, `${open}: detail painted after NO_COLOR`);
			assert.deepEqual(
				plain.map((line) => stripVTControlCharacters(line)),
				colored.map((line) => stripVTControlCharacters(line)),
				`${open}: same text`,
			);
			view.handleInput("\x1b");
		}
	} finally {
		view.dispose();
	}
});

test("no workflows or subagents source reads NO_COLOR or FORCE_COLOR itself: colors follow the cached color level", () => {
	const roots = ["packages/workflows/src", "packages/subagents/src"].map((root) => join(process.cwd(), root));
	const readers: string[] = [];
	for (const root of roots) {
		for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			const path = join(entry.parentPath, entry.name);
			if (/process\.env(?:\.|\[["'])(?:NO_COLOR|FORCE_COLOR)\b/.test(readFileSync(path, "utf8"))) readers.push(path);
		}
	}
	assert.deepEqual(readers, []);
});

test("an open /workflows list follows the color environment after a refresh, like a newly opened one", async () => {
	const runs = makeSnap([makeStage("first")]).runs;
	const mount = () => {
		let component: { render(width: number): string[]; invalidate?(): void; dispose?(): void } | undefined;
		const closed = openWorkflowsListing(
			{
				custom(factory) {
					const mounted = factory({ terminal: { rows: 30 }, requestRender() {} }, undefined, undefined, () => {});
					assert.ok(!(mounted instanceof Promise), "the listing mounts synchronously");
					component = mounted;
					return Promise.resolve(undefined);
				},
			},
			{ runs: () => runs },
		);
		assert.ok(component);
		return { component, closed };
	};
	for (const [from, to] of [
		[{ NO_COLOR: "1" }, {}],
		[{}, { NO_COLOR: "1" }],
	] as const) {
		colorEnv(from);
		const open = mount();
		const before = open.component.render(100).join("\n");
		assert.equal(COLOR_SGR.test(before), from.NO_COLOR === undefined, "painted in the starting environment");
		colorEnv(to);
		open.component.invalidate?.();
		const after = open.component.render(100).join("\n");
		const fresh = mount();
		const expected = fresh.component.render(100).join("\n");
		assert.equal(COLOR_SGR.test(after), to.NO_COLOR === undefined, "the open list follows the refreshed environment");
		assert.equal(after, expected, "the open list paints like a newly opened one");
		open.component.dispose?.();
		fresh.component.dispose?.();
		await Promise.all([open.closed, fresh.closed]);
	}
});
