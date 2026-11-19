/**
 * The agent panel in the real fullscreen dock: ported from the retired workflow widget's dock tests (#3015, #5224).
 */
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, expect, test, vi } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type ProductionFullscreenContext,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";

let active: ProductionFullscreenContext | undefined;
afterEach(async () => {
	if (!active) return;
	active.resolveTheme();
	await active.initPromise;
	active.tui.stop();
	active.restoreOffline();
	active = undefined;
});

function panelSession(items: () => AgentPanelItem[]) {
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	hub.register({
		items,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	return {
		session: { extensionRunner: { getAgentPanelSourceHub: () => hub } },
		changed: async () => {
			for (const listener of listeners) listener();
			await Promise.resolve();
		},
	};
}

const run = (index: number): AgentPanelItem => ({
	id: `run:dock-${index}`,
	kind: "agent",
	state: "running",
	name: `dummy-${index}`,
	task: "stage build",
	elapsedMs: index * 1000,
});

test("the agent panel sits in the sticky dock below the footer and updates in place (#5224)", async () => {
	active = createProductionFullscreenContext();
	const { context, terminal, tui } = active;
	let items: AgentPanelItem[] = [];
	let refreshTime = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => refreshTime);
	const { session, changed } = panelSession(() => {
		if (items.length > 0) refreshTime += 10;
		return items;
	});
	const dispose = bindAgentPanel(session, context.createExtensionUIContext());
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		items = [run(1)];
		await changed();
		await expect
			.poll(() => {
				tui.renderNow();
				return getLayoutFrame(tui).lines.some((line) => line.includes("dummy-1"));
			})
			.toBe(true);
		const panel = context.extensionWidgetsBelow.get("atomic.agent-panel");
		if (!panel) throw new Error("the agent panel did not mount in the dock");
		const frame = getLayoutFrame(tui);
		const dock = frame.root.children[1]!;
		expect(dock.rect.y + dock.rect.height).toBe(terminal.rows);
		const dockLines = frame.lines.slice(dock.rect.y, dock.rect.y + dock.rect.height);
		const footer = dockLines.findIndex((line) => line.includes("footer"));
		const row = dockLines.findIndex((line) => line.includes("dummy-1"));
		expect(footer).toBeGreaterThanOrEqual(0);
		expect(row).toBeGreaterThan(footer);
		items = [{ ...run(1), elapsedMs: 42_000 }];
		await changed();
		await expect
			.poll(() => {
				tui.renderNow();
				return getLayoutFrame(tui).lines.some((line) => line.includes("42s"));
			})
			.toBe(true);
		expect(context.extensionWidgetsBelow.get("atomic.agent-panel")).toBe(panel);
	} finally {
		dispose();
		clock.mockRestore();
	}
});

test("many rows leave the editor usable through narrow and short resizes (#3015, #5224)", async () => {
	active = createProductionFullscreenContext();
	const { context, terminal, tui } = active;
	const { session, changed } = panelSession(() => Array.from({ length: 15 }, (_, index) => run(index)));
	const dispose = bindAgentPanel(session, context.createExtensionUIContext());
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await changed();
		tui.renderNow();
		const mounted = context.extensionWidgetsBelow.get("atomic.agent-panel");
		expect(mounted).toBeDefined();
		context.editor.setText("editor input retained");
		for (const [width, rows] of [
			[120, 40],
			[27, 12],
			[80, 12],
			[79, 16],
			[81, 24],
			[27, 8],
			[120, 40],
		] as const) {
			terminal.resize(width, rows);
			tui.renderNow();
			const frame = getLayoutFrame(tui);
			expect(frame.lines.length).toBeLessThanOrEqual(rows);
			expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(frame.lines.some((line) => line.includes("editor input retained"))).toBe(true);
			expect(context.extensionWidgetsBelow.get("atomic.agent-panel")).toBe(mounted);
		}
	} finally {
		dispose();
	}
});
