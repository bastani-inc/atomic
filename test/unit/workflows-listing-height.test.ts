import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings, type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import type { Terminal as XtermInstance } from "@xterm/headless";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent, PiCustomOverlayFactoryTui } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	openWorkflowsListing,
	type WorkflowsListingDefinition,
} from "../../packages/workflows/src/tui/workflows-listing.js";

const XtermTerminal = xterm.Terminal;

class ScreenTerminal implements Terminal {
	private readonly xterm: XtermInstance;
	private inputHandler?: (data: string) => void;
	readonly columns: number;
	readonly rows: number;
	readonly kittyProtocolActive = true;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.xterm = new XtermTerminal({
			cols: columns,
			rows,
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	async drainInput(): Promise<void> {}

	stop(): void {
		this.inputHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	moveBy(lines: number): void {
		if (lines > 0) this.xterm.write(`\x1b[${lines}B`);
		else if (lines < 0) this.xterm.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	setProgress(): void {}
	setProgramStatus(): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	async waitForRender(): Promise<void> {
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await new Promise<void>((resolve) => this.xterm.write("", () => resolve()));
	}

	async flushAndGetViewport(): Promise<string[]> {
		await new Promise<void>((resolve) => this.xterm.write("", () => resolve()));
		const buffer = this.xterm.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < this.xterm.rows; i++) {
			lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
		}
		return lines;
	}
}

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
		const tinyText = stripVTControlCharacters(tiny.render(80).join("\n"));
		const standardLines = standard.render(80);
		const tallLines = tall.render(80);
		assert.match(tinyText, /ralph · task 3/);
		assert.doesNotMatch(tinyText, /ralph · task 4/);
		assert.ok(tallLines.length > standardLines.length);
		assert.ok(tallLines.length <= 40);
	} finally {
		tiny.dispose?.();
		standard.dispose?.();
		tall.dispose?.();
	}
});
