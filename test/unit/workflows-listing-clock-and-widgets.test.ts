import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings, Text } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelRow,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { BashExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/bash-execution.js";
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
import { openWorkflowsListing } from "../../packages/workflows/src/tui/workflows-listing.js";
import { fakeFooterAgentSession } from "./stage-chat-view-helpers.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const T0 = 60_000_000;
const DOWN = "\x1b[B";
const STATUS = "MCP  1 server · 3 tools";

function run(overrides: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "name" | "status">): RunSnapshot {
	return { inputs: {}, stages: [], toolNodes: [], startedAt: 0, ...overrides } as RunSnapshot;
}

function cleanScreen(lines: readonly string[]): string {
	return lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_pi:[^\x07]*\x07/g, ""))).join("\n");
}

test("a clock tick whose Date.now delta reads 999 ms still repaints the elapsed text (#5224)", () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	vi.setSystemTime(T0);
	let component: PiCustomComponent | undefined;
	let renders = 0;
	let shownSeconds = 0;
	const readSeconds = (target: PiCustomComponent): number => {
		const text = cleanScreen(target.render(100));
		return Number(/running · (\d+)s/.exec(text)?.[1]);
	};
	void openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory(
						{
							requestRender: () => {
								renders += 1;
								shownSeconds = readSeconds(component!);
							},
							terminal: { rows: 24 },
						},
						undefined,
						undefined,
						() => resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{
			runs: () => [run({ id: "aaaaaaaa", name: "wf", status: "running", startedAt: T0 - 2_000 })],
		},
	);
	assert.ok(component);
	shownSeconds = readSeconds(component);
	assert.equal(shownSeconds, 2);
	vi.advanceTimersByTime(999);
	vi.setSystemTime(Date.now() - 1);
	vi.advanceTimersByTime(1);
	assert.equal(renders, 1);
	assert.equal(shownSeconds, 3);
	component.dispose?.();
});

test("the clock tick does not request a frame when only an off-page run changes (#5224)", () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	vi.setSystemTime(T0);
	let component: PiCustomComponent | undefined;
	let renders = 0;
	const runs: RunSnapshot[] = Array.from({ length: 20 }, (_, index) =>
		run({
			id: `completed-${String(index).padStart(2, "0")}`,
			name: `wf-${index}`,
			status: "completed",
			startedAt: T0 - 2_000 - index * 10,
			endedAt: T0 - 1_000 - index * 10,
		}),
	);
	runs.push(run({ id: "offpage-live", name: "live-wf", status: "running", startedAt: T0 - 5_000 }));
	void openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory(
						{
							requestRender: () => {
								renders += 1;
							},
							terminal: { rows: 24 },
						},
						undefined,
						undefined,
						() => resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{ runs: () => runs },
	);
	assert.ok(component);
	component.render(100);
	renders = 0;
	vi.advanceTimersByTime(5_000);
	assert.equal(renders, 0);
	for (let step = 0; step < 20; step++) component.handleInput?.(DOWN);
	component.render(100);
	renders = 0;
	vi.advanceTimersByTime(1_000);
	assert.equal(renders, 1);
	component.dispose?.();
});

for (const [columns, rows, widgetRows, followUpCount, shellRows, working] of [
	[80, 24, 1, 0, 0, false],
	[80, 24, 8, 0, 0, false],
	[100, 30, 8, 0, 0, false],
	[80, 24, 1, 6, 0, false],
	[80, 24, 1, 0, 8, false],
	[100, 30, 1, 6, 0, false],
	[120, 40, 1, 6, 0, false],
	[100, 30, 1, 0, 8, false],
	[120, 40, 1, 0, 8, false],
	[100, 30, 1, 6, 8, true],
	[120, 40, 1, 6, 8, true],
] as const) {
	test(`/workflows keeps its hint visible with ${widgetRows}-row widgets, ${followUpCount} queued follow-ups and ${shellRows} shell rows at ${columns}x${rows}, working=${working} (#5224)`, async () => {
		const runs: RunSnapshot[] = Array.from({ length: 20 }, (_, index) =>
			run({
				id: `run-${String(index + 1).padStart(2, "0")}-0000`,
				name: "ralph",
				status: "running",
				inputs: { objective: `task ${index + 1}` },
				startedAt: T0 - index * 60_000,
			}),
		);
		const panelRows: AgentPanelRow[] = runs.map((entry) => ({
			id: `workflow:${entry.id}`,
			kind: "workflow",
			state: "running",
			name: entry.name,
			task: "stage plan",
			elapsedMs: 1_000,
			progress: { done: 0, total: 3 },
		}));
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
			compactionQueuedMessages: [],
			pendingBashComponents: [],
		});
		const followUps = Array.from({ length: followUpCount }, (_, index) => `queued-follow-up-${index}`);
		Object.assign(context.session, {
			getSteeringMessages: () => [],
			getFollowUpMessages: () => followUps,
		});
		const shell = new BashExecutionComponent("echo pending-shell", tui);
		if (shellRows > 0) {
			shell.appendOutput(
				Array.from({ length: shellRows }, (_, index) => `pending-shell-output-${index}`).join("\n"),
			);
			context.pendingBashComponents.push(shell);
		}
		context.updatePendingMessagesDisplay();
		if (working) context.statusContainer.addChild(new Text("Working…", 0, 0));
		const editor = context.editor as unknown as { getText(): string; setText(text: string): void };
		editor.getText = () => "";
		editor.setText = () => {};
		const footerData = new FooterDataProvider(tmpdir());
		footerData.setExtensionStatus("mcp", STATUS);
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
		context.setExtensionWidget(
			"extra.above",
			() => ({
				invalidate() {},
				render: () => Array.from({ length: widgetRows }, (_, row) => `above-widget-${row}`),
			}),
			{ placement: "aboveEditor" },
		);
		context.setExtensionWidget(
			"extra.below",
			() => ({
				invalidate() {},
				render: () => ["below-widget"],
			}),
			{ placement: "belowEditor" },
		);
		let sheet: PiCustomComponent | undefined;
		const custom: PiCustomOverlayFunction = (factory, options) =>
			context.showExtensionCustom<unknown>(
				(tuiArg, theme, keys, done) => {
					sheet = factory(tuiArg as unknown as PiCustomOverlayFactoryTui, theme, keys, done) as PiCustomComponent;
					return sheet as Component;
				},
				options as Parameters<typeof context.showExtensionCustom>[1],
			);
		const pending = openWorkflowsListing({ custom }, { runs: () => runs });
		await new Promise((resolve) => setImmediate(resolve));
		try {
			assert.ok(sheet);
			for (let step = 0; step <= runs.length; step++) {
				if (step === 1 && shellRows > 0) {
					shell.appendOutput("\npending-shell-live-update");
					context.pendingMessagesContainer.addChild(new Text("pending-shell-added-while-open", 0, 0));
				}
				if (step === 2 && followUpCount > 0) {
					followUps.push("queued-follow-up-added-while-open");
					context.updatePendingMessagesDisplay();
				}
				tui.renderNow();
				const text = cleanScreen(getLayoutFrame(tui).lines);
				assert.match(text, /Workflows/, `title hidden at step ${step}\n${text}`);
				assert.match(text, /Search…/, `search hidden at step ${step}\n${text}`);
				assert.match(text, /❯/, `selection hidden at step ${step}\n${text}`);
				assert.match(text, /enter open/, `hint hidden at step ${step}\n${text}`);
				assert.doesNotMatch(text, /above-widget|below-widget|queued-follow-up|pending-shell/);
				terminal.input(DOWN);
			}
			sheet.dispose?.();
			sheet = undefined;
			await pending;
			if (followUpCount > 0 || shellRows > 0) terminal.resize(columns, 60);
			tui.renderNow();
			if (shellRows > 0) {
				assert.match(cleanScreen(getLayoutFrame(tui).lines), /pending-shell-output-0/);
				terminal.resize(columns, 60);
				tui.renderNow();
			}
			const afterClose = cleanScreen(getLayoutFrame(tui).lines);
			assert.match(afterClose, /below-widget/);
			assert.match(afterClose, /above-widget-0/);
			const pendingPreview = cleanScreen(context.pendingMessagesContainer.render(columns));
			if (followUpCount > 0) {
				assert.match(afterClose, /queued-follow-up-0/);
				assert.match(pendingPreview, /queued-follow-up-added-while-open/);
				assert.equal(context.getAllQueuedMessages().followUp.length, followUps.length);
			}
			if (shellRows > 0) {
				assert.match(afterClose, /pending-shell/);
				assert.match(pendingPreview, /pending-shell-live-update/);
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
	});
}
