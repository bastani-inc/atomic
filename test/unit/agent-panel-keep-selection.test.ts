import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, type TuiMouseEvent, type TuiMouseEventResult } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { OperationId, TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type AgentViewBridge,
	setAgentViewBridge,
} from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-bridge.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel, showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import type { TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { FakeOwnerTaskStore } from "../helpers/fake-owner-task-store.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

const ENTER = "\r";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const CTRL_C = "\x03";

beforeAll(() => initTheme("dark"));

let previousKeys: ReturnType<typeof getKeybindings>;
const disposers: Array<() => void> = [];

beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	setKeybindings(previousKeys);
});

const tick = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function agent(id: string, title: string, ordinal: number, opId?: string): TaskRecord {
	return {
		...taskRecord(id),
		agentName: "worker",
		title,
		launchOrdinal: ordinal,
		wasBackground: true,
		...(opId === undefined ? {} : { launchOperationId: opId as OperationId }),
	};
}

function done(task: TaskRecord): TaskRecord {
	return {
		...task,
		observation: { kind: "none", reason: "task-settled" },
		execution: {
			kind: "settled",
			result: { kind: "completed", output: task.output },
		},
	};
}

function asking(task: TaskRecord): TaskRecord {
	return {
		...task,
		attention: {
			kind: "input-needed",
			requestId: `ask-${task.ref.taskId}`,
			prompt: "Which branch?",
			route: { sessionId: `session-${task.ref.taskId}`, promptId: "p1" },
		},
	};
}

function fakeBridge(initialViewed?: string) {
	const requests: Array<string | undefined> = [];
	const listeners = new Set<() => void>();
	let shown = initialViewed as TaskId | undefined;
	const bridge: AgentViewBridge & { requests: typeof requests; show(id: string | undefined): void } = {
		requests,
		viewedTaskId: () => shown,
		requestView(taskId) {
			requests.push(taskId);
			shown = taskId;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		show(id) {
			shown = id as TaskId | undefined;
			for (const listener of [...listeners]) listener();
		},
	};
	return bridge;
}

function panelSession(tasks: TaskRecord[], initialViewed?: string) {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore(tasks);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge(initialViewed);
	setAgentViewBridge(session, bridge);
	return { session, store, bridge };
}

interface MountedPanel {
	render(width: number): string[];
	handleInput(data: string): boolean;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	dispose?(): void;
}

const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

function selectedLine(lines: readonly string[]): string {
	return lines.find((line) => line.startsWith("∀ ")) ?? "";
}

function panelUi(drive: (component: MountedPanel, rows: () => string[]) => Promise<void> | void): TaskInspectorUi {
	return {
		notify() {},
		async custom(factory) {
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const component = (await factory(
				{ requestRender() {}, terminal: { rows: 24, columns: 100 } } as never,
				theme,
				getKeybindings() as KeybindingsManager,
				finish as never,
			)) as MountedPanel;
			const rows = () => plain(component.render(100));
			await drive(component, rows);
			await finished;
			component.dispose?.();
			return undefined as never;
		},
	};
}

function clickRow(component: MountedPanel, lines: readonly string[], y: number): void {
	component.handleMouse?.({
		type: "click",
		button: "left",
		x: 6,
		y,
		screenX: 6,
		screenY: 30 + y,
		width: 100,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	});
}

test("focused agent panel remembers the selected subagent after Enter or click and restores it on reopen", async () => {
	const { session, bridge } = panelSession([
		agent("a1", "first alpha", 1, "op-a"),
		agent("a2", "second beta", 2, "op-b"),
		agent("a3", "third gamma", 3, "op-c"),
	]);

	// First open starts on row 0 (newest: a3 / third gamma); move down to a2 and open it with Enter.
	let firstOpenSelected = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			firstOpenSelected = selectedLine(rows());
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ENTER);
		}),
	);
	assert.match(firstOpenSelected, /third gamma/, "first open starts on row 0");
	assert.equal(bridge.viewedTaskId(), "a2");

	// Reopening via Down arrow restores a2; clicking a1 opens a1 and remembers a1.
	let afterEnterReopen = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			const lines = rows();
			afterEnterReopen = selectedLine(lines);
			const alphaRow = lines.findIndex((line) => line.includes("first alpha"));
			assert.notEqual(alphaRow, -1, lines.join("\n"));
			clickRow(component, lines, alphaRow);
		}),
	);
	assert.match(afterEnterReopen, /second beta/, "reopening restores the subagent opened with Enter");
	assert.equal(bridge.viewedTaskId(), "a1");

	// Reopening again restores the clicked subagent a1.
	let afterClickReopen = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			afterClickReopen = selectedLine(rows());
			component.handleInput(ESC);
		}),
	);
	assert.match(afterClickReopen, /first alpha/, "reopening restores the subagent opened by click");
});

test("focused agent panel remembers the selected subagent across Esc, Left arrow, and Ctrl+C", async () => {
	for (const closeKey of [ESC, LEFT, CTRL_C]) {
		const { session } = panelSession([
			agent("a1", "first alpha", 1, "op-a"),
			agent("a2", "second beta", 2, "op-b"),
			agent("a3", "third gamma", 3, "op-c"),
		]);

		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				component.handleInput(DOWN);
				component.handleInput(DOWN);
				assert.match(selectedLine(rows()), /first alpha/);
				component.handleInput(closeKey);
			}),
		);

		let reopenedSelected = "";
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				reopenedSelected = selectedLine(rows());
				component.handleInput(ESC);
			}),
		);
		assert.match(reopenedSelected, /first alpha/, `close key ${JSON.stringify(closeKey)} remembers selected row`);
	}
});

test("switching back to main or closing from the main row keeps the most recently selected subagent row", async () => {
	const { session, bridge } = panelSession([
		agent("a1", "first alpha", 1, "op-a"),
		agent("a2", "second beta", 2, "op-b"),
		agent("a3", "third gamma", 3, "op-c"),
	]);

	// Select a2 (index 1) and open it with Enter.
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ENTER);
		}),
	);
	assert.equal(bridge.viewedTaskId(), "a2");

	// Reopen -> restores a2 -> walk Up through a3 to main -> Enter to return to main chat.
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(UP);
			assert.match(selectedLine(rows()), /third gamma/);
			component.handleInput(UP);
			assert.match(selectedLine(rows()), /\bmain$/);
			component.handleInput(ENTER);
		}),
	);
	assert.equal(bridge.viewedTaskId(), undefined);

	// Reopen again -> must still select a2 (neither main nor row 0 a3).
	let afterMainEnter = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			afterMainEnter = selectedLine(rows());
			// Walk up to main and close with Esc; must also keep a2.
			component.handleInput(UP);
			component.handleInput(UP);
			assert.match(selectedLine(rows()), /\bmain$/);
			component.handleInput(ESC);
		}),
	);
	assert.match(afterMainEnter, /second beta/, "Enter on main keeps the most recently selected subagent");

	// Reopen after closing via Esc on main -> still selects a2; Up from main also keeps a2.
	let afterMainEsc = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			afterMainEsc = selectedLine(rows());
			component.handleInput(UP);
			component.handleInput(UP);
			assert.match(selectedLine(rows()), /\bmain$/);
			component.handleInput(UP);
		}),
	);
	assert.match(afterMainEsc, /second beta/, "Esc on main keeps the most recently selected subagent");

	let afterMainUp = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			afterMainUp = selectedLine(rows());
			component.handleInput(ESC);
		}),
	);
	assert.match(afterMainUp, /second beta/, "Up from main keeps the most recently selected subagent");
});

test("reopening after the previously selected subagent disappears or is dismissed selects its nearest surviving neighbour", async () => {
	const { session, store } = panelSession([
		agent("a1", "first alpha", 1, "op-a"),
		agent("a2", "second beta", 2, "op-b"),
		agent("a3", "third gamma", 3, "op-c"),
	]);

	// Panel order: [a3 (gamma), a2 (beta), a1 (alpha)]. Select middle a2 and close.
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ESC);
		}),
	);

	// a2 finishes and disappears while closed -> reopening selects next neighbour a1 (not top a3).
	store.update("a2", done);
	let afterMiddleGone = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			afterMiddleGone = selectedLine(rows());
			component.handleInput(ESC);
		}),
	);
	assert.match(afterMiddleGone, /first alpha/, "missing middle row falls forward to next surviving neighbour");

	// a1 (now the last row) finishes while closed -> reopening falls back to previous surviving neighbour a3.
	store.update("a1", done);
	let afterLastGone = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			afterLastGone = selectedLine(rows());
			component.handleInput(ESC);
		}),
	);
	assert.match(afterLastGone, /third gamma/, "missing last row falls back to previous surviving neighbour");
});

test("clearing all panel rows resets the remembered anchor so a fresh batch starts at row 0", async () => {
	// Case 1: all rows vanish while the focused panel is open (via dismissal of the last row).
	{
		const { session, store } = panelSession([done(agent("a1", "first alpha", 1, "op-a"))], "a1");
		await showAgentPanel(
			session,
			panelUi(async (component, rows) => {
				assert.match(selectedLine(rows()), /first alpha/);
				component.handleInput("x");
				await tick();
			}),
		);

		// A fresh batch arrives where a1 resumes alongside a newer b1; panel order is [b1, a1r].
		store.set([agent("a1r", "first alpha resumed", 2, "op-a:resume:1"), agent("b1", "fresh bravo", 3, "op-b")]);
		let freshSelected = "";
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				freshSelected = selectedLine(rows());
				component.handleInput(ESC);
			}),
		);
		assert.match(freshSelected, /fresh bravo/, "dismissing the last open row clears anchor for the next batch");
	}

	// Case 2: all rows vanish on their own while the focused panel is open.
	{
		const { session, store } = panelSession([
			agent("a1", "first alpha", 1, "op-a"),
			agent("a2", "second beta", 2, "op-b"),
		]);
		await showAgentPanel(
			session,
			panelUi(async (component, rows) => {
				component.handleInput(DOWN);
				assert.match(selectedLine(rows()), /first alpha/);
				store.set([done(agent("a1", "first alpha", 1, "op-a")), done(agent("a2", "second beta", 2, "op-b"))]);
				await tick();
			}),
		);

		store.set([agent("a1r", "first alpha resumed", 3, "op-a:resume:1"), agent("b1", "fresh bravo", 4, "op-b")]);
		let freshSelected = "";
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				freshSelected = selectedLine(rows());
				component.handleInput(ESC);
			}),
		);
		assert.match(freshSelected, /fresh bravo/, "auto-closing on 0 rows clears anchor for the next batch");
	}

	// Case 3: all rows vanish while the focused panel is closed (observed by idle panel).
	{
		const { session, store } = panelSession([
			agent("a1", "first alpha", 1, "op-a"),
			agent("a2", "second beta", 2, "op-b"),
		]);
		disposers.push(
			bindAgentPanel(session as never, {
				setWidget() {},
				requestRender() {},
			}),
		);

		// Select second row a1 and close.
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				component.handleInput(DOWN);
				assert.match(selectedLine(rows()), /first alpha/);
				component.handleInput(ESC);
			}),
		);

		// Both subagents finish so the panel empties completely.
		store.set([done(agent("a1", "first alpha", 1, "op-a")), done(agent("a2", "second beta", 2, "op-b"))]);
		await tick();

		// Later a fresh batch starts containing a resumed a1 plus a newer b1; panel order is [b1, a1r].
		store.set([agent("a1r", "first alpha resumed", 3, "op-a:resume:1"), agent("b1", "fresh bravo", 4, "op-b")]);
		await tick();

		let freshSelected = "";
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				freshSelected = selectedLine(rows());
				component.handleInput(ESC);
			}),
		);
		assert.match(freshSelected, /fresh bravo/, "emptying the panel while closed clears anchor for the next batch");
	}
});

test("reopening follows a previously selected subagent that resumed under a new attempt taskId", async () => {
	const a1 = agent("a1", "first alpha", 1, "op-a");
	const a2 = agent("a2", "second beta", 2, "op-b");
	const a3 = agent("a3", "third gamma", 3, "op-c");
	const { session, store } = panelSession([a1, a2, a3]);

	// Select a2 (middle) and open it with Enter.
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ENTER);
		}),
	);

	// a2 resumes under a brand-new attempt id a2r (old attempt evicted), and another task a4 launches above it.
	const a2r = agent("a2r", "second beta resumed", 4, "op-b:resume:1");
	const a4 = agent("a4", "fourth delta", 5, "op-d");
	store.set([a1, a3, a2r, a4]);

	let reopenedSelected = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			reopenedSelected = selectedLine(rows());
			component.handleInput(ESC);
		}),
	);
	assert.match(reopenedSelected, /second beta resumed/, "stable child key selects the resumed attempt");
});

test("scrolled focused panel preserves scroll window, clocks visible rows on first frame, and handles input before render", async () => {
	const fixture = taskFixture();
	try {
		for (let i = 0; i < 12; i++) {
			await fixture.start(`job-${String(i).padStart(2, "0")}`);
			taskValue(
				fixture.runners[i]!.context.reportActivity({
					reportId: `elapsed-${i}`,
					change: { kind: "metrics", elapsedMs: (i + 1) * 10_000 },
				}),
			);
		}
		fixture.store.drain();
		const session = { extensionRunner: {} };
		bindOwnerTaskStore(session, fixture.store);
		const bridge = fakeBridge();
		setAgentViewBridge(session, bridge);

		// Panel order is newest first: job-11 .. job-00.
		// Scroll down 10 steps to job-01 (index 10, scroll = 3, visible: job-08 .. job-01), then press Enter.
		let beforeLines: string[] = [];
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				rows();
				for (let step = 0; step < 10; step++) {
					component.handleInput(DOWN);
					rows();
				}
				beforeLines = rows();
				assert.match(selectedLine(beforeLines), /job-01\b/, beforeLines.join("\n"));
				assert.ok(
					beforeLines.some((line) => line.includes("↑ 3 more")),
					beforeLines.join("\n"),
				);
				assert.ok(
					beforeLines.some((line) => line.includes("+1 more")),
					beforeLines.join("\n"),
				);
				component.handleInput(ENTER);
			}),
		);

		// Reopen via Down arrow -> restores job-01 at the exact same scroll offset (↑ 3 more / +1 more) with live elapsed time on first paint.
		let afterLines: string[] = [];
		await showAgentPanel(
			session,
			panelUi((component, rows) => {
				afterLines = rows();
				component.handleInput(ESC);
			}),
		);
		assert.match(selectedLine(afterLines), /job-01\b.*20s$/, afterLines.join("\n"));
		assert.ok(
			afterLines.some((line) => line.includes("↑ 3 more")),
			afterLines.join("\n"),
		);
		assert.ok(
			afterLines.some((line) => line.includes("+1 more")),
			afterLines.join("\n"),
		);

		// Verify handleInput before first render still acts on the restored scrolled row cleanly.
		bridge.show(undefined);
		await showAgentPanel(
			session,
			panelUi((component) => {
				component.handleInput(ENTER);
			}),
		);
		assert.equal(
			bridge.viewedTaskId(),
			fixture.store.tasks[1]!.ref.taskId,
			"Enter before first render opens restored scrolled row job-01",
		);
	} finally {
		await fixture.dispose();
	}
});

test("reopening a scrolled panel when the remembered row re-sorts to the top materializes the new window on first paint and input", async () => {
	const tasks = Array.from({ length: 12 }, (_, i) =>
		agent(`a${i}`, `item-${String(i).padStart(2, "0")}`, i + 1, `op-${i}`),
	);
	const { session, store, bridge } = panelSession(tasks);

	// Scroll to item-01 (index 10, scroll = 3) and close with Esc.
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			rows();
			for (let step = 0; step < 10; step++) {
				component.handleInput(DOWN);
				rows();
			}
			assert.match(selectedLine(rows()), /item-01\b/);
			component.handleInput(ESC);
		}),
	);

	// item-01 now needs input, re-sorting it to index 0 (scroll shifts from 3 -> 0).
	store.update("a1", asking);

	// First verify handleInput before first render handles the scroll shift cleanly.
	await showAgentPanel(
		session,
		panelUi((component) => {
			component.handleInput(ENTER);
		}),
	);
	assert.equal(bridge.viewedTaskId(), "a1");

	// Move item-01 back to the bottom; reopening follows it back to scroll = 3.
	store.update("a1", (task) => ({ ...task, attention: { kind: "none" } }));
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			const lines = rows();
			assert.match(selectedLine(lines), /item-01\b/, lines.join("\n"));
			assert.ok(
				lines.some((line) => line.includes("↑ 3 more")),
				lines.join("\n"),
			);
			component.handleInput(ESC);
		}),
	);
	store.update("a1", asking);

	let linesAfterResort: string[] = [];
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			linesAfterResort = rows();
			assert.match(selectedLine(linesAfterResort), /item-01\b.*needs input/, linesAfterResort.join("\n"));
			assert.ok(
				!linesAfterResort.some((line) => line.includes("↑ ")),
				`scrolled back to top:\n${linesAfterResort.join("\n")}`,
			);
			component.handleInput(ESC);
		}),
	);
});

test("explicit selectId overrides the remembered selection anchor", async () => {
	const { session } = panelSession([
		agent("a1", "first alpha", 1, "op-a"),
		agent("a2", "second beta", 2, "op-b"),
		agent("a3", "third gamma", 3, "op-c"),
	]);

	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ESC);
		}),
	);

	let explicitSelected = "";
	await showAgentPanel(
		session,
		panelUi((component, rows) => {
			explicitSelected = selectedLine(rows());
			component.handleInput(ESC);
		}),
		"task:a1",
	);
	assert.match(explicitSelected, /first alpha/, "explicit selectId takes precedence over remembered anchor");
});
