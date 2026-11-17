import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings, TuiMainScreen } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SelectorState } from "../../packages/coding-agent/src/modes/interactive/components/selector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent, PiCustomOverlayFactoryTui } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { openWorkflowsListing } from "../../packages/workflows/src/tui/workflows-listing.js";

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
			name: index === count - 1 ? "deploy" : "ralph",
			status: "running",
			inputs: { objective: `task ${index + 1}` },
			stages: [],
			toolNodes: [],
			startedAt: NOW - index * 60_000,
		}),
	);
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

test("/workflows keeps title and search visible across a 24-row terminal (#5224)", async () => {
	const terminal = new ScreenTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const runs = makeRuns(20);
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

		for (let step = 0; step < runs.length; step++) {
			terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
			const stepLines = component.render(80);
			assert.ok(stepLines.length <= 24, `expected step ${step + 1} render <= 24 lines, got ${stepLines.length}`);
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
		assert.deepEqual(await pending, { kind: "run", runId: "run-20-0000" });
	} finally {
		component?.dispose?.();
		tui.stop();
	}
});

test("/workflows scales visible rows with terminal height and clamps short terminals (#5224)", async () => {
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
			},
		);
		assert.ok(mounted);
		return mounted;
	}

	const tiny = await mountAtRows(8);
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

test("/workflows render is idempotent across repeated calls at every height and selection position, with or without preview (#5224)", async () => {
	const runs = makeRuns(20);
	for (const preview of [false, true]) {
		for (let rows = 8; rows <= 60; rows++) {
			let component: PiCustomComponent | undefined;
			void openWorkflowsListing(
				{
					custom: (factory) =>
						new Promise<undefined>((resolve) => {
							component = factory({ terminal: { rows }, requestRender() {} }, undefined, undefined, () =>
								resolve(undefined),
							) as PiCustomComponent;
						}),
				},
				{ runs: () => runs },
			);
			assert.ok(component);
			if (preview) component.handleInput?.(" ");
			for (let step = 0; step < runs.length; step++) {
				const first: string[] = component.render(80);
				const second: string[] = component.render(80);
				const third: string[] = component.render(80);
				assert.deepEqual(second, first, `rows=${rows}, step=${step}, preview=${preview}`);
				assert.deepEqual(third, first, `rows=${rows}, step=${step}, preview=${preview}`);
				component.handleInput?.("\x1b[B");
			}
			component.dispose?.();
		}
	}
});

test("/workflows updates its page size when the terminal shrinks from 40 to 24 rows and grows back to 40 (#5224)", async () => {
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
		},
	);

	try {
		await terminal.waitForRender();
		assert.ok(component);
		for (let step = 0; step < 6; step++) {
			terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
		}
		const tallLines = component.render(80);
		const beforeViewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.match(beforeViewport, /Workflows/);
		assert.match(beforeViewport, /❯ ralph · task 7/);

		terminal.resize(80, 24);
		tui.requestRender(true);
		await terminal.waitForRender();

		const shortLines = component.render(80);
		assert.ok(shortLines.length <= 22, `expected resized sheet <= 22 lines, got ${shortLines.length}`);
		assert.ok(shortLines.length < tallLines.length);
		const afterViewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.match(afterViewport, /Workflows/);
		assert.match(afterViewport, /Search…/);
		assert.match(afterViewport, /❯ ralph · task 7/);

		terminal.resize(80, 40);
		tui.requestRender(true);
		await terminal.waitForRender();
		const regrownLines = component.render(80);
		assert.equal(regrownLines.length, tallLines.length, "growing the terminal restores the taller page size");

		terminal.sendInput("\r");
		assert.deepEqual(await pending, { kind: "run", runId: "run-07-0000" });
	} finally {
		component?.dispose?.();
		tui.stop();
	}
});
