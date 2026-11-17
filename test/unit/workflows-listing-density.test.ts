import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelRow,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
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
import { openWorkflowsListing, workflowsListingItems } from "../../packages/workflows/src/tui/workflows-listing.js";
import { fakeFooterAgentSession } from "./stage-chat-view-helpers.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => setKeybindings(previousKeys));

test("workflow sheet uses every fitting row at 80x24 and 80x25 in the production layout with a footer and hidden agent panel (#5224)", async () => {
	const runs = Array.from({ length: 20 }, (_, index) => ({
		id: `run-${String(index + 1).padStart(2, "0")}-0000`,
		name: "ralph",
		status: "running",
		inputs: { objective: `task ${index + 1}` },
		stages: [],
		toolNodes: [],
		startedAt: 100_000 - index,
	})) as RunSnapshot[];
	const labels = new Set(workflowsListingItems(runs).map((item) => item.label));
	const panelRows: AgentPanelRow[] = runs.map((entry) => ({
		id: `workflow:${entry.id}`,
		kind: "workflow",
		state: "running",
		name: entry.name,
		task: "stage plan",
		elapsedMs: 1_000,
		progress: { done: 0, total: 3 },
	}));
	for (const rows of [24, 25] as const) {
		const host = createProductionFullscreenContext({ rows, columns: 80, transcriptLines: 60 });
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
		footerData.setExtensionStatus("mcp", "MCP  1 server · 3 tools");
		context.footerContainer.clear();
		context.footerContainer.addChild(new FooterComponent(fakeFooterAgentSession(), footerData));
		context.setExtensionWidget(
			"atomic.agent-panel",
			() => ({
				invalidate() {},
				render: (width: number) => renderAgentPanelRows(panelRows, width, themedAgentPanelStyle(), {}),
			}),
			{ placement: "belowEditor" },
		);
		const transcriptRow = 1;
		const usageRow = 1;
		const footerRows = 2;
		const spacerRow = 1;
		const externalRows = transcriptRow + usageRow + footerRows + spacerRow;
		let sheet: PiCustomComponent | undefined;
		let lastLines: string[] = [];
		const custom: PiCustomOverlayFunction = (factory, options) =>
			context.showExtensionCustom<unknown>(
				(tuiArg, theme, keys, done) => {
					const created = factory(
						tuiArg as unknown as PiCustomOverlayFactoryTui,
						theme,
						keys,
						done,
					) as PiCustomComponent;
					const origRender = created.render.bind(created);
					created.render = (width: number) => {
						lastLines = origRender(width);
						return lastLines;
					};
					sheet = created;
					return created as Component;
				},
				options as Parameters<typeof context.showExtensionCustom>[1],
			);
		const pending = openWorkflowsListing({ custom }, { runs: () => runs });
		await new Promise((resolve) => setImmediate(resolve));
		try {
			assert.ok(sheet);
			for (let step = 0; step <= labels.size; step++) {
				tui.renderNow();
				const frame = getLayoutFrame(tui);
				const lines = lastLines.map((line) => stripVTControlCharacters(line.replace(/\x1b_pi:[^\x07]*\x07/g, "")));
				const visible = lines.filter((line) => labels.has(line.trim().replace(/^❯\s+/, ""))).length;
				const chrome = lines.length - visible * 2;
				const transcriptRows = frame.root.children[0]?.rect.height ?? 0;
				const unusedRows = transcriptRows - transcriptRow;
				assert.ok(visible >= 8, `rows=${rows}, step ${step}: only ${visible} rows visible`);
				assert.ok(
					lines.length + externalRows <= rows,
					`rows=${rows}, step ${step}: content exceeds terminal height`,
				);
				assert.equal(
					visible,
					Math.floor((rows - externalRows - chrome) / 2),
					`rows=${rows}, step ${step}: unused row space`,
				);
				assert.ok(
					unusedRows <= (rows % 2 === 0 ? 1 : 0),
					`rows=${rows}, step ${step}: ${unusedRows} unused transcript rows`,
				);
				const screenText = frame.lines
					.map((line) => stripVTControlCharacters(line.replace(/\x1b_pi:[^\x07]*\x07/g, "")))
					.join("\n");
				assert.match(screenText, /Workflows.*Search…/);
				assert.match(screenText, /❯/);
				assert.doesNotMatch(screenText, /stage plan/);
				terminal.input("\x1b[B");
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
});

test("workflow sheet escapes pasted terminal commands in its search field (#5224)", async () => {
	let component: PiCustomComponent | undefined;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ terminal: { rows: 24 }, requestRender() {} }, undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{ runs: () => [] },
	);
	try {
		assert.ok(component);
		component.handleInput?.("\x1b[200~\x1b]52;c;QVVESVQ=\x07\x1b[201~");
		assert.equal(component.render(80).join("\n").includes("\x1b]52;"), false);
	} finally {
		component?.dispose?.();
		await pending;
	}
});
