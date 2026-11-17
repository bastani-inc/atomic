import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	setKeybindings,
	Text,
	TuiMainScreen,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelRow,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import type {
	PiCustomComponent,
	PiCustomOverlayFactoryTui,
	PiCustomOverlayFunction,
} from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { openWorkflowsListing } from "../../packages/workflows/src/tui/workflows-listing.js";
import { ScreenTerminal } from "../helpers/screen-terminal.js";
import { fakeFooterAgentSession } from "./stage-chat-view-helpers.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => setKeybindings(previousKeys));

const DOWN = "\x1b[B";
const STATUS = "MCP  1 server · 3 tools";
const RUNS: RunSnapshot[] = Array.from(
	{ length: 20 },
	(_, index): RunSnapshot => ({
		id: `run-${String(index + 1).padStart(2, "0")}-0000`,
		name: "ralph",
		status: "running",
		inputs: { objective: `task ${index + 1}` },
		stages: [],
		toolNodes: [],
		startedAt: Date.now() - index * 60_000,
	}),
);
const PANEL_ROWS: AgentPanelRow[] = RUNS.map((run) => ({
	id: `workflow:${run.id}`,
	kind: "workflow",
	state: "running",
	name: run.name,
	task: "stage plan",
	elapsedMs: 1_000,
	progress: { done: 0, total: 3 },
}));

function panelWidget(): Component {
	return {
		invalidate() {},
		render: (width: number) => renderAgentPanelRows(PANEL_ROWS, width, themedAgentPanelStyle(), {}),
	};
}

function assertSheetVisible(lines: readonly string[], where: string): void {
	const screen = lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_pi:[^\x07]*\x07/g, "")));
	const text = screen.join("\n");
	assert.match(text, /Workflows/, `title hidden ${where}\n${text}`);
	assert.match(text, /Search…/, `search hidden ${where}\n${text}`);
	assert.match(text, /❯/, `selection hidden ${where}\n${text}`);
	assert.match(text, /enter open/, `hint hidden ${where}\n${text}`);
}

async function sweepFullscreen(columns: number, rows: number): Promise<void> {
	const host = createProductionFullscreenContext({ rows, columns, transcriptLines: 60 });
	const { context, tui, terminal } = host;
	Object.assign(context, {
		navigationInlineCustomUiDepth: 0,
		blockingInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set(),
		widgetReleaseListeners: new Map(),
		extensionOverlays: new Set(),
		nextBlockingOverlayId: 0,
		tuiInputSubscriptions: new Set(),
		programStatus: { report() {}, setBlocked() {} },
		activeSelectorDispose: undefined,
	});
	const editor = context.editor as unknown as { getText(): string; setText(text: string): void };
	editor.getText = () => "";
	editor.setText = () => {};
	const footerData = new FooterDataProvider(tmpdir());
	footerData.setExtensionStatus("mcp", STATUS);
	context.footerContainer.clear();
	context.footerContainer.addChild(new FooterComponent(fakeFooterAgentSession(), footerData));
	context.setExtensionWidget("atomic.agent-panel", () => panelWidget(), { placement: "belowEditor" });
	let sheet: PiCustomComponent | undefined;
	const custom: PiCustomOverlayFunction = (factory, options) =>
		context.showExtensionCustom<unknown>(
			(tuiArg, theme, keys, done) => {
				sheet = factory(tuiArg as unknown as PiCustomOverlayFactoryTui, theme, keys, done) as PiCustomComponent;
				return sheet as Component;
			},
			options as Parameters<typeof context.showExtensionCustom>[1],
		);
	const pending = openWorkflowsListing({ custom }, { runs: () => RUNS });
	await new Promise((resolve) => setImmediate(resolve));
	try {
		assert.ok(sheet);
		for (let step = 0; step <= RUNS.length; step++) {
			tui.renderNow();
			assertSheetVisible(getLayoutFrame(tui).lines, `at ${columns}x${rows}, step ${step}`);
			terminal.input(DOWN);
		}
	} finally {
		sheet?.dispose?.();
		await pending;
		host.resolveTheme();
		await host.initPromise;
		tui.stop();
		host.restoreOffline();
		footerData.dispose();
	}
}

async function sweepMainScreen(columns: number, rows: number): Promise<void> {
	const terminal = new ScreenTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	const footerData = new FooterDataProvider(tmpdir());
	footerData.setExtensionStatus("mcp", STATUS);
	const transcript = new Container();
	for (let line = 1; line <= 60; line++) transcript.addChild(new Text(`transcript line ${line}`, 0, 0));
	const widgetsAbove = new Container();
	widgetsAbove.addChild(new Spacer(1));
	const editorContainer = new Container();
	const footerContainer = new Container();
	footerContainer.addChild(new FooterComponent(fakeFooterAgentSession(), footerData));
	const widgetsBelow = new Container();
	const widgetHost = {
		ui: tui,
		widgetContainerAbove: widgetsAbove,
		widgetContainerBelow: widgetsBelow,
		extensionWidgetsAbove: new Map<string, Component>(),
		extensionWidgetsBelow: new Map<string, Component>([["atomic.agent-panel", panelWidget()]]),
		navigationInlineCustomUiDepth: 0,
		renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer,
	};
	for (const child of [
		transcript,
		widgetsAbove,
		new Text("usage", 0, 0),
		editorContainer,
		footerContainer,
		widgetsBelow,
	])
		tui.addChild(child);
	let sheet: PiCustomComponent | undefined;
	void openWorkflowsListing(
		{
			custom: (factory, options) => {
				if (options?.purpose === "navigation") {
					widgetHost.navigationInlineCustomUiDepth = 1;
					InteractiveMode.prototype.renderWidgets.call(widgetHost as unknown as InteractiveMode);
				}
				sheet = factory(
					{ mode: tui.mode, terminal: tui.terminal, requestRender: () => tui.requestRender() },
					undefined,
					undefined,
					() => {},
				) as PiCustomComponent;
				const mounted: Component = {
					render: (width) => sheet!.render(width),
					handleInput: (data) => {
						sheet!.handleInput?.(data);
					},
					invalidate: () => sheet!.invalidate?.(),
				};
				editorContainer.addChild(mounted);
				tui.setFocus(mounted);
				return new Promise<undefined>(() => {});
			},
		},
		{ runs: () => RUNS },
	);
	tui.start();
	try {
		await terminal.waitForRender();
		for (let step = 0; step <= RUNS.length; step++) {
			assertSheetVisible(await terminal.flushAndGetViewport(), `at ${columns}x${rows}, step ${step}`);
			terminal.sendInput(DOWN);
			await terminal.waitForRender();
		}
	} finally {
		sheet?.dispose?.();
		tui.stop();
		footerData.dispose();
	}
}

const SIZES: ReadonlyArray<readonly [number, number]> = [
	[80, 24],
	[100, 30],
	[120, 40],
	...[25, 27, 29, 31, 33, 35, 37, 39, 41].map((rows) => [100, rows] as const),
];

for (const [columns, rows] of SIZES) {
	test(`/workflows keeps its title, search, selection and hint on screen in the fullscreen layout at ${columns}x${rows} with a status row and agent panel (#5224)`, async () => {
		await sweepFullscreen(columns, rows);
	});
	test(`/workflows keeps its title, search, selection and hint on screen in the main-screen layout at ${columns}x${rows} with a status row and agent panel (#5224)`, async () => {
		await sweepMainScreen(columns, rows);
	});
}
