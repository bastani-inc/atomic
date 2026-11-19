import assert from "node:assert/strict";
import { matchesKey } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	AgentPanelFocus,
	type AgentPanelRow,
	type AgentPanelStyle,
	formatPanelTokens,
	renderAgentPanelHint,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	AGENT_PANEL_REFRESH_WINDOW_MS,
	bindAgentPanel,
	setAgentPanelVisible,
	showAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { taskFixture } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

test("formatPanelTokens promotes rounded millions to billions at 999,950,000 (#5224)", () => {
	assert.equal(formatPanelTokens(999_949_999), "999.9M");
	assert.equal(formatPanelTokens(999_950_000), "1.0B");
	assert.equal(formatPanelTokens(999_999_999), "1.0B");
	assert.equal(formatPanelTokens(1_500_000_000), "1.5B");
});

test("focused panel scrolled into a long list shows ↑ N more above and only the rows below (#5224)", () => {
	const rows: AgentPanelRow[] = Array.from({ length: 20 }, (_, i) => ({
		id: `task:${i}`,
		kind: "agent",
		state: "running",
		name: `worker-${i}`,
		task: `job ${i}`,
	}));
	const lines = renderAgentPanelRows(rows, 100, plain, {
		selectedId: "task:10",
		scroll: 10,
	}).map((line) => stripVTControlCharacters(line).trimEnd());

	assert.equal(lines[0], "  ● main");
	assert.equal(lines[1], "  ↑ 10 more");
	assert.equal(lines.at(-1), "  +2 more");
});

test("focused panel disarms a pending stop when the row finishes, sanitizes stop hints, and requires acknowledgement before dismissing (#5224)", () => {
	const now = 0;
	const calls: string[] = [];
	const keys = new KeybindingsManager();
	const focus = new AgentPanelFocus(
		keys,
		{
			open: (row) => calls.push(`open ${row.id}`),
			stop: (row) => calls.push(`stop ${row.id}`),
			dismiss: (row) => calls.push(`dismiss ${row.id}`),
			close: () => calls.push("close"),
		},
		() => now,
	);
	const runningRow: AgentPanelRow = {
		id: "run:1",
		kind: "agent",
		state: "running",
		name: "deploy\x1b[2J\x1b]0;pwn\x07",
		task: "stage build",
	};
	focus.update([runningRow]);
	focus.enter();
	const press = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));

	press("x");
	const armedHint = stripVTControlCharacters(renderAgentPanelHint(focus, 120, plain, keys));
	assert.equal(armedHint.includes("\x1b"), false);
	assert.match(armedHint, /Press x again within 3s to stop deploy/);

	focus.update([{ ...runningRow, state: "done" }]);
	const finishedHint = stripVTControlCharacters(renderAgentPanelHint(focus, 120, plain, keys));
	assert.equal(finishedHint.includes("\x1b"), false);
	assert.match(finishedHint, /deploy.*finished · x to acknowledge/);

	press("x");
	assert.deepEqual(calls, [], "second x press only acknowledges that the row finished while armed");
	focus.notePainted([{ ...runningRow, state: "done" }]);

	press("x");
	assert.deepEqual(calls, ["dismiss run:1"], "third x press dismisses the finished row");
});

test("bindAgentPanel renders cached rows without per-frame source reads and defers expensive >=13ms bursts (#4009, #5224)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	try {
		await fixture.start("Background worker");
		let sourceReads = 0;
		let now = 1_000;
		let costMs = 0;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const hub = new AgentPanelSourceHub();
		const extListeners = new Set<() => void>();
		hub.register({
			items: () => {
				sourceReads++;
				now += costMs;
				return [{ id: "run:r1", kind: "agent", state: "running", name: "ralph", task: "stage build" }];
			},
			subscribe: (listener) => {
				extListeners.add(listener);
				return () => extListeners.delete(listener);
			},
		});
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		bindOwnerTaskStore(session, fixture.store);
		let widget: { render(width: number): string[] } | undefined;
		const dispose = bindAgentPanel(session, {
			setWidget(_key, factory) {
				widget = typeof factory === "function" ? (factory({} as never, {} as never) as never) : undefined;
			},
			requestRender() {},
		});
		try {
			assert.ok(widget);
			const afterMount = sourceReads;
			widget.render(80);
			widget.render(120);
			assert.equal(sourceReads, afterMount, "widget.render must reuse cached rows from update()");

			setAgentPanelVisible(session, false);
			setAgentPanelVisible(fixture.store, false);
			setAgentPanelVisible(session, true);
			assert.equal(widget, undefined, "panel remains hidden while nesting counter > 0");
			setAgentPanelVisible(fixture.store, true);
			assert.ok(widget, "panel restores visibility when nesting counter reaches 0");

			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			costMs = 13;
			const beforeExpensive = sourceReads;
			for (let turn = 0; turn < 6; turn++) {
				for (let i = 0; i < 50; i++) {
					for (const listener of extListeners) listener();
				}
				await Promise.resolve();
			}
			const immediate = sourceReads - beforeExpensive;
			assert.ok(
				immediate < 6,
				`when refreshes exceed the 8ms budget, later bursts defer instead of refreshing each turn (${immediate})`,
			);
			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			vi.advanceTimersByTime(AGENT_PANEL_REFRESH_WINDOW_MS);
			assert.equal(
				sourceReads - beforeExpensive,
				immediate + 1,
				"coalesced trailing refresh runs once at window end",
			);
		} finally {
			dispose();
		}
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
		await fixture.dispose();
	}
});

test("a panel bound after an inspector hides it keeps the existing visibility hold (#5224)", () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [{ id: "run:held", kind: "agent", state: "running", name: "held", task: "build" }],
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let mounted = false;
	setAgentPanelVisible(session, false);
	const dispose = bindAgentPanel(session, {
		setWidget(_key, content) {
			mounted = typeof content === "function";
		},
		requestRender() {},
	});
	try {
		assert.equal(mounted, false);
		setAgentPanelVisible(session, true);
		assert.equal(mounted, true);
	} finally {
		dispose();
	}
});

test("showAgentPanel sanitizes failure notifications and catches rejecting onReturn reopen via ui.notify (#5224)", async () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	let onReturn: (() => void) | undefined;
	hub.register({
		items: () => [
			{
				id: "run:1",
				kind: "agent",
				state: "running",
				name: "bad\x1b[2Jname",
				task: "stage 1",
			} satisfies AgentPanelItem,
		],
		subscribe: () => () => {},
		open: (_id, options) => {
			onReturn = options?.onReturn;
		},
		stop: async () => ({ ok: false, reason: "boom\x1b]0;pwn\x07" }),
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const notices: string[] = [];
	let failCustom = false;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await showAgentPanel(session, {
			notify: (msg) => notices.push(msg),
			custom: async (factory) => {
				if (failCustom) throw new Error("host closed\x1b[2J");
				let finish = () => {};
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const component = await factory({ requestRender() {} } as never, theme, new KeybindingsManager(), finish);
				component.handleInput?.("x");
				component.handleInput?.("x");
				setImmediate(() => component.handleInput?.("\r"));
				await finished;
				component.dispose?.();
				return undefined as never;
			},
		});
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.includes("\x1b"), false);
		assert.match(notices[0]!, /Could not stop badname: boom/);

		assert.ok(onReturn);
		failCustom = true;
		onReturn();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(unhandled.length, 0, "failed reopen must not become an unhandled rejection");
		assert.equal(notices.length, 2);
		assert.equal(notices[1]?.includes("\x1b"), false);
		assert.match(notices[1]!, /host closed/);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("renderAgentPanelRows only reads names in the visible window (#5224)", () => {
	let hiddenNameReads = 0;
	const rows: AgentPanelRow[] = Array.from({ length: 100 }, (_, index) => {
		const row: AgentPanelRow = {
			id: `task:${index}`,
			kind: "agent",
			state: "running",
			name: `w-${index}`,
			task: "work",
		};
		if (index >= 10) {
			Object.defineProperty(row, "name", {
				get() {
					hiddenNameReads++;
					return `w-${index}`;
				},
			});
		}
		return row;
	});
	renderAgentPanelRows(rows, 100, plain);
	renderAgentPanelRows(rows, 100, plain, { selectedId: "task:0", scroll: 0 });
	assert.equal(hiddenNameReads, 0);
});
