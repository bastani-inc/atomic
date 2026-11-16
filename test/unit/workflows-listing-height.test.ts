import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings, TuiMainScreen } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelRow,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { SelectorState } from "../../packages/coding-agent/src/modes/interactive/components/selector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import type { PiCustomComponent, PiCustomOverlayFactoryTui } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	openWorkflowsListing,
	type WorkflowsListingDefinition,
} from "../../packages/workflows/src/tui/workflows-listing.js";

import { ScreenTerminal } from "../helpers/screen-terminal.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => setKeybindings(previousKeys));

const NOW = 10_000_000;

function makeRuns(count: number): RunSnapshot[] {
	return Array.from(
		{ length: count },
		(_, index): RunSnapshot => ({
			id: `run-${String(index + 1).padStart(2, "0")}-0000`,
			name: "ralph",
			status: "running",
			inputs: { objective: `task ${index + 1}` },
			stages: [],
			toolNodes: [],
			startedAt: NOW - index * 60_000,
		}),
	);
}

function makeDefinitions(count: number): WorkflowsListingDefinition[] {
	return Array.from({ length: count }, (_, index) => ({
		normalizedName: index === count - 1 ? "deploy" : `workflow-${String(index + 1).padStart(2, "0")}`,
		description: `Run workflow ${index + 1}`,
		inputs: {},
	}));
}

function toOverlayTui(tui: TuiMainScreen): PiCustomOverlayFactoryTui {
	return {
		mode: tui.mode,
		terminal: tui.terminal,
		requestRender: () => tui.requestRender(),
	};
}

function toTuiComponent(component: PiCustomComponent): Component {
	return {
		render: (width: number) => component.render(width),
		handleInput: (data: string) => {
			component.handleInput?.(data);
		},
		invalidate: () => {
			component.invalidate?.();
		},
	};
}

test("/workflows keeps title and search visible across a 24-row terminal including the group boundary (#5245)", async () => {
	const terminal = new ScreenTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const runs = makeRuns(12);
	const definitions = makeDefinitions(8);
	let component: PiCustomComponent | undefined;

	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					const created = factory(toOverlayTui(tui), undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
					component = created;
					const wrapped = toTuiComponent(created);
					tui.addChild(wrapped);
					tui.setFocus(wrapped);
					tui.start();
				}),
		},
		{
			runs: () => runs,
			definitions: () => definitions,
		},
	);

	try {
		await terminal.waitForRender();
		assert.ok(component);
		const initialViewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.match(initialViewport, /Workflows/);
		assert.match(initialViewport, /Search…/);
		const initialLines = component.render(80);
		assert.ok(
			initialLines.length <= 24,
			`expected initial render <= 24 lines on an 80x24 terminal, got ${initialLines.length}`,
		);

		for (let step = 0; step < runs.length + definitions.length; step++) {
			terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
			const stepLines = component.render(80);
			assert.ok(
				stepLines.length <= 24,
				`expected step ${step + 1} render <= 24 lines across group boundary, got ${stepLines.length}`,
			);
			const viewport = (await terminal.flushAndGetViewport()).join("\n");
			assert.match(viewport, /Workflows/);
			assert.match(viewport, /Search…/);
		}

		for (const ch of "deploy") terminal.sendInput(ch);
		await terminal.waitForRender();
		const searchViewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.match(searchViewport, /Workflows/);
		assert.match(searchViewport, /deploy/);

		terminal.sendInput("\r");
		assert.deepEqual(await pending, { kind: "definition", name: "deploy" });
	} finally {
		component?.dispose?.();
		tui.stop();
	}
});

test("/workflows scales visible rows with terminal height and clamps short terminals (#5245)", async () => {
	const runs = makeRuns(16);

	async function mountAtRows(rows: number | undefined): Promise<PiCustomComponent> {
		let mounted: PiCustomComponent | undefined;
		void openWorkflowsListing(
			{
				custom: (factory) =>
					new Promise<undefined>((resolve) => {
						mounted = factory(
							{ terminal: rows === undefined ? undefined : { rows }, requestRender() {} },
							undefined,
							undefined,
							() => resolve(undefined),
						) as PiCustomComponent;
					}),
			},
			{
				runs: () => runs,
				definitions: () => [],
			},
		);
		assert.ok(mounted);
		return mounted;
	}

	const tiny = await mountAtRows(10);
	const standard = await mountAtRows(24);
	const tall = await mountAtRows(40);
	try {
		const tinyLines = tiny.render(80);
		const tinyText = stripVTControlCharacters(tinyLines.join("\n"));
		const standardLines = standard.render(80);
		const tallLines = tall.render(80);
		assert.match(tinyText, /ralph · task 1/);
		assert.doesNotMatch(tinyText, /ralph · task 2/);
		assert.ok(standardLines.length > tinyLines.length);
		assert.ok(tallLines.length > standardLines.length);
		assert.ok(tallLines.length <= 40);
	} finally {
		tiny.dispose?.();
		standard.dispose?.();
		tall.dispose?.();
	}
});

test("/workflows keeps title and search visible at 80x24 with footer and 12-run agent panel at every Down position (#5245)", async () => {
	const terminal = new ScreenTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const runs = makeRuns(12);
	const definitions = makeDefinitions(8);
	const panelRows: AgentPanelRow[] = runs.map((run) => ({
		id: `workflow:${run.id}`,
		kind: "workflow",
		state: "running",
		name: run.name,
		task: "stage plan",
		elapsedMs: 1_000,
		progress: { done: 0, total: 3 },
	}));
	let component: PiCustomComponent | undefined;

	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					const created = factory(toOverlayTui(tui), undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
					component = created;
					const wrapped = toTuiComponent(created);
					tui.addChild(wrapped);
					tui.addChild({
						render: (width: number) => [
							"model-x • ~/project (main)".slice(0, width),
							"status: ready".slice(0, width),
						],
						invalidate() {},
					});
					tui.addChild({
						render: (width: number) => renderAgentPanelRows(panelRows, width, themedAgentPanelStyle(), {}),
						invalidate() {},
					});
					tui.setFocus(wrapped);
					tui.start();
				}),
		},
		{
			runs: () => runs,
			definitions: () => definitions,
		},
	);

	try {
		await terminal.waitForRender();
		for (let step = 0; step <= runs.length + definitions.length; step++) {
			const viewport = (await terminal.flushAndGetViewport()).join("\n");
			assert.match(viewport, /Workflows/, `expected title visible at step ${step}`);
			assert.match(viewport, /Search…/, `expected search visible at step ${step}`);
			assert.match(viewport, /❯/, `expected highlight visible at step ${step}`);
			terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
		}
		terminal.sendInput("\x1b");
		assert.equal(await pending, undefined);
	} finally {
		component?.dispose?.();
		tui.stop();
	}
});

test("/workflows updates its page size when the terminal shrinks from 40 to 24 rows (#5245)", async () => {
	const state = new SelectorState({
		items: [
			{ id: "a", value: "a", label: "a" },
			{ id: "b", value: "b", label: "b" },
		],
		maxVisible: 4,
	});
	state.setMaxVisible(Number.NaN);
	state.setMaxVisible(Number.POSITIVE_INFINITY);
	assert.equal(state.maxVisible, 4);
	const terminal = new ScreenTerminal(80, 40);
	const tui = new TuiMainScreen(terminal);
	const runs = makeRuns(20);
	const definitions = makeDefinitions(1);
	let component: PiCustomComponent | undefined;

	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					const created = factory(toOverlayTui(tui), undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
					component = created;
					const wrapped = toTuiComponent(created);
					tui.addChild(wrapped);
					tui.addChild({
						render: (width: number) => ["model-x • ~/project (main)".slice(0, width)],
						invalidate() {},
					});
					tui.setFocus(wrapped);
					tui.start();
				}),
		},
		{
			runs: () => runs,
			definitions: () => definitions,
		},
	);

	try {
		await terminal.waitForRender();
		assert.ok(component);
		for (let step = 0; step < 6; step++) {
			terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
		}
		const beforeViewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.match(beforeViewport, /Workflows/);
		assert.match(beforeViewport, /❯ ralph · task 7/);

		terminal.resize(80, 24);
		tui.requestRender(true);
		await terminal.waitForRender();

		const afterLines = component.render(80);
		assert.ok(afterLines.length <= 22, `expected resized sheet <= 22 lines, got ${afterLines.length}`);
		const afterViewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.match(afterViewport, /Workflows/);
		assert.match(afterViewport, /Search…/);
		assert.match(afterViewport, /❯ ralph · task 7/);

		terminal.sendInput("\r");
		assert.deepEqual(await pending, { kind: "run", runId: "run-07-0000" });
	} finally {
		component?.dispose?.();
		tui.stop();
	}
});
