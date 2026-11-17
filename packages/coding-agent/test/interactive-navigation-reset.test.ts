import { stripVTControlCharacters } from "node:util";
import { type Component, Text, type TuiAltScreen } from "@bastani/atomic-tui";
import { afterEach, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type ProductionFullscreenContext,
} from "./helpers/interactive-fullscreen-layout.ts";

type NavigationHost = InteractiveMode & {
	navigationInlineCustomUiDepth: number;
	blockingInlineCustomUiDepth: number;
	extensionWidgetsBelow: Map<string, Component>;
	pendingMessagesContainer: { addChild(component: Component): void };
	showExtensionCustom<T>(
		factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
		options?: { overlay?: boolean; purpose?: "prompt" | "navigation" },
	): Promise<T>;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	resetExtensionUI(): void;
	updatePendingMessagesDisplay(): void;
	renderWidgets(): void;
};

const hosts: ProductionFullscreenContext[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) {
		host.resolveTheme();
		await host.initPromise;
		host.tui.stop();
		host.restoreOffline();
	}
});

function navigationHost(followUp: string[]): { context: NavigationHost; tui: TuiAltScreen } {
	const host = createProductionFullscreenContext({ rows: 30, columns: 100, transcriptLines: 4 });
	hosts.push(host);
	const noop = () => {};
	Object.assign(host.context, {
		navigationInlineCustomUiDepth: 0,
		blockingInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set(),
		widgetReleaseListeners: new Map(),
		extensionOverlays: new Set(),
		extensionTerminalInputSubscriptions: new Set(),
		tuiInputSubscriptions: new Set(),
		programStatus: { report: noop, setBlocked: noop },
		footerDataProvider: { clearExtensionStatuses: noop, onBranchChange: noop, setAvailableProviderCount: noop },
		autocompleteProviderWrappers: [],
		disposeActiveSelector: noop,
		setCustomEditorComponent: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		defaultWorkingMessage: "Working",
		keybindings: new KeybindingsManager(),
		pendingBashComponents: [],
		getAllQueuedMessages: () => ({ steering: [], followUp }),
	});
	Object.assign(host.context.footer, { invalidate: noop });
	Object.assign(host.context.editor, { getText: () => "", setText: noop });
	return { context: host.context as NavigationHost, tui: host.tui };
}

function frame(tui: TuiAltScreen): string {
	tui.renderNow();
	return getLayoutFrame(tui)
		.lines.map((line) => stripVTControlCharacters(line))
		.join("\n");
}

test("an invalidated screen redraws queued previews from their current state (#5224)", () => {
	const { context, tui } = navigationHost([]);
	let label = "Steering: first draft";
	let cached: string[] | undefined;
	const preview: Component = {
		render: () => {
			cached ??= [label];
			return cached;
		},
		invalidate: () => {
			cached = undefined;
		},
	};
	context.pendingMessagesContainer.addChild(preview);
	expect(frame(tui)).toContain("Steering: first draft");
	label = "Steering: restyled";
	tui.invalidate();
	expect(frame(tui)).toContain("Steering: restyled");
});

test("queued previews and widgets come back after a session reset drops an open navigation view (#5224)", async () => {
	const { context, tui } = navigationHost(["queued after reset"]);
	context.updatePendingMessagesDisplay();
	void context.showExtensionCustom(() => new Text("FOCUSED PANEL", 0, 0), { overlay: false, purpose: "navigation" });
	await new Promise((resolve) => setImmediate(resolve));
	expect(frame(tui)).toContain("FOCUSED PANEL");
	expect(frame(tui)).not.toContain("queued after reset");

	context.resetExtensionUI();
	context.extensionWidgetsBelow.set("agents", new Text("AGENT ROW", 0, 0));
	context.renderWidgets();
	context.updatePendingMessagesDisplay();

	const after = frame(tui);
	expect(after).not.toContain("FOCUSED PANEL");
	expect(after).toContain("Follow-up: queued after reset");
	expect(after).toContain("AGENT ROW");
});

test("a view whose cleanup fails still releases the screen it hid when a reset drops it (#5224)", async () => {
	const { context, tui } = navigationHost(["queued after reset"]);
	context.updatePendingMessagesDisplay();
	const failingView: Component = {
		render: () => ["FAILING VIEW"],
		invalidate: () => {},
		dispose: () => {
			throw new Error("dispose failed");
		},
	} as Component;
	void context.showExtensionCustom(() => failingView, { overlay: false, purpose: "navigation" });
	void context.showExtensionCustom(() => new Text("SECOND VIEW", 0, 0), { overlay: false, purpose: "navigation" });
	await new Promise((resolve) => setImmediate(resolve));
	expect(frame(tui)).toContain("SECOND VIEW");

	expect(() => context.resetExtensionUI()).not.toThrow();
	context.updatePendingMessagesDisplay();

	const after = frame(tui);
	expect(after).not.toContain("FAILING VIEW");
	expect(after).not.toContain("SECOND VIEW");
	expect(after).toContain("Follow-up: queued after reset");
});

test("a dialog opened while a reset tears down the old views stays on screen (#5224)", async () => {
	const { context, tui } = navigationHost([]);
	let confirmed: Promise<boolean> | undefined;
	const closingView: Component = {
		render: () => ["CLOSING VIEW"],
		invalidate: () => {},
		dispose: () => {
			confirmed = context.showExtensionConfirm("Keep changes?", "asked during reset");
		},
	} as Component;
	void context.showExtensionCustom(() => closingView, { overlay: false, purpose: "navigation" });
	await new Promise((resolve) => setImmediate(resolve));

	context.resetExtensionUI();

	expect(confirmed).toBeDefined();
	const after = frame(tui);
	expect(after).not.toContain("CLOSING VIEW");
	expect(after).toContain("Keep changes?");
});
