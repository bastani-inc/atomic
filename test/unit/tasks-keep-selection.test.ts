import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	getKeybindings,
	setKeybindings,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { OperationId, TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	type AgentViewBridge,
	setAgentViewBridge,
} from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-bridge.js";
import {
	AgentPanelFocus,
	type AgentPanelRow,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { dismissedTasks } from "../../packages/coding-agent/src/modes/interactive/components/task-dismissal.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { InteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { bindAgentPanel, showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import {
	handleSetViewedAgent,
	installEngineAgentViewBridge,
} from "../../packages/coding-agent/src/modes/rpc/agent-view-rpc-panel.js";
import {
	agentPanelBoardSource,
	openWaitedShellOf,
	showTaskInspector,
	type TaskInspectorUi,
} from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { FakeOwnerTaskStore } from "../helpers/fake-owner-task-store.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const ENTER = "\r";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";
const ESC = "\x1b";
const SPACE = " ";
const ALT_W = "\x1bw";

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

function shell(id: string, title: string, ordinal: number, parentTaskId?: string): TaskRecord {
	return {
		...taskRecord(id, "command"),
		title,
		launchOrdinal: ordinal,
		wasBackground: true,
		...(parentTaskId === undefined
			? {}
			: { parentTaskId: parentTaskId as TaskId, launchedBy: `session-${parentTaskId}` }),
	};
}

function done(task: TaskRecord): TaskRecord {
	return {
		...task,
		observation: { kind: "none", reason: "task-settled" },
		execution: { kind: "settled", result: { kind: "completed", output: task.output } },
	};
}

function waiting(task: TaskRecord): TaskRecord {
	return {
		...task,
		observation: { kind: "none", reason: "task-settled" },
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: `wait-${task.ref.taskId}`, toolName: "bash" }] },
			},
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

interface Mounted {
	render(width: number): string[];
	handleInput(data: string): boolean;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	dispose?(): void;
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

function selectedLine(lines: readonly string[]): string {
	return plain(lines).find((line) => /^\s*(?:❯|∀)\s/.test(line)) ?? "";
}

function mountUi(
	drive: (component: Mounted, rows: () => string[], mountIndex: number) => Promise<void> | void,
	terminalRows = 24,
) {
	let mountIndex = 0;
	const snapshots: string[][] = [];
	const ui: TaskInspectorUi = {
		notify() {},
		async custom(factory) {
			mountIndex++;
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const component = (await factory(
				{ requestRender() {}, terminal: { rows: terminalRows, columns: 100 } } as never,
				theme,
				getKeybindings() as KeybindingsManager,
				finish as never,
			)) as Mounted;
			const rows = () => plain(component.render(100));
			snapshots.push(rows());
			await drive(component, rows, mountIndex);
			await finished;
			component.dispose?.();
			return undefined as never;
		},
	};
	return { ui, snapshots };
}

function openTasks(session: object, store: FakeOwnerTaskStore, ui: TaskInspectorUi, taskId?: string) {
	return showTaskInspector(ui, store, taskId, { board: agentPanelBoardSource(session as never) });
}

test("re-entering /tasks after opening a subagent keeps selection on that subagent (while viewing and after returning to main)", async () => {
	for (const key of [ENTER, RIGHT]) {
		const session = { extensionRunner: {} };
		const store = new FakeOwnerTaskStore([
			agent("a1", "first alpha", 1),
			agent("a2", "second beta", 2),
			agent("a3", "third gamma", 3),
		]);
		bindOwnerTaskStore(session, store);
		const bridge = fakeBridge();
		setAgentViewBridge(session, bridge);

		// Open /tasks, move down to 2nd item (a2, since newest a3 is top), open it.
		let openedFrom = "";
		await openTasks(
			session,
			store,
			mountUi((component, rows) => {
				assert.match(selectedLine(rows()), /third gamma/, "starts on top item");
				component.handleInput(DOWN);
				openedFrom = selectedLine(rows());
				assert.match(openedFrom, /second beta/);
				component.handleInput(key);
			}).ui,
		);
		assert.equal(bridge.viewedTaskId(), "a2");

		// Re-open /tasks while viewing a2: selection must stay on a2 (not jump to top a3).
		let whileViewing = "";
		await openTasks(
			session,
			store,
			mountUi((component, rows) => {
				whileViewing = selectedLine(rows());
				component.handleInput(ESC);
			}).ui,
		);
		assert.match(whileViewing, /second beta/, `re-open while viewing a2 via ${JSON.stringify(key)}`);

		// Open a2 again from /tasks, then press <- back to main (bridge shows main), then re-open /tasks.
		await openTasks(
			session,
			store,
			mountUi((component, rows) => {
				assert.match(selectedLine(rows()), /second beta/);
				component.handleInput(key);
			}).ui,
		);
		bridge.show(undefined);

		let afterBackToMain = "";
		await openTasks(
			session,
			store,
			mountUi((component, rows) => {
				afterBackToMain = selectedLine(rows());
				component.handleInput(ESC);
			}).ui,
		);
		assert.match(afterBackToMain, /second beta/, `re-open after returning to main via ${JSON.stringify(key)}`);

		// Closing /tasks with Esc on main clears return memory; next fresh /tasks starts at top.
		let freshAfterEsc = "";
		await openTasks(
			session,
			store,
			mountUi((component, rows) => {
				freshAfterEsc = selectedLine(rows());
				component.handleInput(ESC);
			}).ui,
		);
		assert.match(freshAfterEsc, /third gamma/, "fresh /tasks after Esc dismissal on main starts at top");
	}
});

test("re-entering /tasks keeps selection when opened subagent finishes and re-sorts from Working to Done", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN); // a2
			component.handleInput(ENTER);
		}).ui,
	);
	assert.equal(bridge.viewedTaskId(), "a2");

	// a2 finishes while user is inside it -> moves to Done at bottom of /tasks.
	store.update("a2", done);

	let reentered = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			reentered = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(reentered, /second beta.*done/, "selection follows a2 into Done");
});

test("re-entering /tasks selects nearest neighbour (next, else previous) when opened subagent is gone", async () => {
	// Case 1: middle item (a2 in [a3, a2, a1]) is dismissed while inside -> next neighbour a1 is selected.
	const session1 = { extensionRunner: {} };
	const store1 = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session1, store1);
	const bridge1 = fakeBridge();
	setAgentViewBridge(session1, bridge1);

	await openTasks(
		session1,
		store1,
		mountUi((component) => {
			component.handleInput(DOWN); // a2 (index 1 of [a3, a2, a1])
			component.handleInput(ENTER);
		}).ui,
	);
	store1.update("a2", done);
	dismissedTasks(ownerTaskViewSource(store1)).add("a2" as TaskId);
	bridge1.show(undefined);

	let middleGone = "";
	await openTasks(
		session1,
		store1,
		mountUi((component, rows) => {
			middleGone = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(middleGone, /first alpha/, "when middle item a2 is gone, selects next item a1 (not top a3)");

	// Case 2: last item (a1 in [a3, a2, a1]) is dismissed while inside -> previous neighbour a2 is selected.
	const session2 = { extensionRunner: {} };
	const store2 = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session2, store2);
	const bridge2 = fakeBridge();
	setAgentViewBridge(session2, bridge2);

	await openTasks(
		session2,
		store2,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(DOWN); // a1 (index 2 of [a3, a2, a1])
			component.handleInput(ENTER);
		}).ui,
	);
	store2.update("a1", done);
	dismissedTasks(ownerTaskViewSource(store2)).add("a1" as TaskId);
	bridge2.show(undefined);

	let lastGone = "";
	await openTasks(
		session2,
		store2,
		mountUi((component, rows) => {
			lastGone = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(lastGone, /second beta/, "when last item a1 is gone, selects previous item a2 (not top a3)");
});

test("isolated engine bridge: re-entering /tasks works both before and after set_viewed_agent arrives", async () => {
	const session = { extensionRunner: {} } as never as AgentSession;
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session, store);
	const sent: InteractiveEngineMessage[] = [];
	const context = { session, send: (message: InteractiveEngineMessage) => sent.push(message) } as never;
	disposers.push(installEngineAgentViewBridge(context));

	// Open /tasks, select a2, press Enter -> engine sends engine_view_agent(a2) and closes /tasks.
	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(ENTER);
		}).ui,
	);
	assert.equal(sent.at(-1)?.type, "engine_view_agent");

	// Even before set_viewed_agent arrives, re-opening /tasks selects a2 via engine return anchor.
	let beforeAck = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			beforeAck = selectedLine(rows());
			component.handleInput(ENTER);
		}).ui,
	);
	assert.match(beforeAck, /second beta/);

	// After set_viewed_agent(a1) arrives (e.g., user clicked a1 in panel), opening /tasks selects a1.
	await handleSetViewedAgent({ id: "v1", type: "set_viewed_agent", taskId: "a1" }, context);
	let afterPanelClick = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			afterPanelClick = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterPanelClick, /first alpha/);
});

test("clicking a subagent in the idle agent panel selects it in /tasks while viewing, and clears stale /tasks anchor after returning to main", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// First open a2 from /tasks (records return anchor for a2).
	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(ENTER);
		}).ui,
	);
	bridge.show(undefined);

	// Now click a1 in the idle agent panel.
	let widget: Mounted | undefined;
	disposers.push(
		bindAgentPanel(
			session as never,
			{
				setWidget(_key: string, content: unknown) {
					widget = typeof content === "function" ? (content({} as never, {} as never) as Mounted) : undefined;
				},
				requestRender() {},
			} as never,
			undefined,
			{ custom: async () => undefined as never },
		),
	);
	const panelLines = plain(widget!.render(100));
	const a1Row = panelLines.findIndex((line) => line.includes("first alpha"));
	assert.notEqual(a1Row, -1, panelLines.join("\n"));
	widget!.handleMouse?.({
		type: "click",
		button: "left",
		x: 4,
		y: a1Row,
		screenX: 4,
		screenY: 30 + a1Row,
		width: 100,
		height: panelLines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	});
	await tick();
	assert.equal(bridge.viewedTaskId(), "a1");

	// Opening /tasks while viewing a1 selects a1.
	let viewingA1 = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			viewingA1 = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(viewingA1, /first alpha/);

	// After returning to main from a1 (which was opened via panel click, not /tasks), fresh /tasks starts at top (no stale a2).
	bridge.show(undefined);
	let afterMain = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			afterMain = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterMain, /third gamma/, "stale /tasks anchor cleared when user switched via panel click");
});

test("Alt+W waited shell from a viewed subagent does not clobber /tasks return selection", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		waiting(agent("a1", "waiting alpha", 1)),
		agent("a2", "running beta", 2),
		shell("s1", "alpha build", 3, "a1"),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// Open /tasks, select waiting alpha (index 1 under Waiting), press Enter.
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /waiting alpha/);
			component.handleInput(ENTER);
		}).ui,
	);
	assert.equal(bridge.viewedTaskId(), "a1");

	// Press Alt+W from viewed subagent (openWaitedShellOf), then <- back to subagent.
	await openWaitedShellOf(
		session,
		mountUi(async (component) => {
			await tick();
			component.handleInput(LEFT);
		}).ui,
		"a1",
	);

	// Return to main and re-open /tasks: selection must still be on waiting alpha.
	bridge.show(undefined);
	let reentered = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			reentered = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(reentered, /waiting alpha/);
});

test("extension item opened from /tasks via onReturn selects nearest neighbour when the item disappears", async () => {
	let items: AgentPanelItem[] = [
		{ id: "run:1", kind: "agent", state: "running", name: "first", task: "one" },
		{ id: "run:2", kind: "agent", state: "running", name: "second", task: "two" },
		{ id: "run:3", kind: "agent", state: "running", name: "third", task: "three" },
	];
	let returnCb: (() => void) | undefined;
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => items,
		subscribe: () => () => {},
		open: (_id, opts) => {
			returnCb = opts?.onReturn;
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const store = new FakeOwnerTaskStore([]);
	bindOwnerTaskStore(session, store);

	let secondMountSelected = "";
	let reopenDone: (() => void) | undefined;
	const reopened = new Promise<void>((resolve) => {
		reopenDone = resolve;
	});
	const { ui } = mountUi((component, rows, mountIndex) => {
		if (mountIndex === 1) {
			// Order is [run:1, run:2, run:3]; move to middle (run:2) and open it.
			component.handleInput(DOWN);
			assert.match(selectedLine(rows()), /second/);
			component.handleInput(ENTER);
		} else {
			secondMountSelected = selectedLine(rows());
			component.handleInput(ESC);
			reopenDone?.();
		}
	});
	await openTasks(session, store, ui);
	assert.ok(returnCb, "extension open received onReturn");
	// Remove middle item run:2 before returning.
	items = [items[0]!, items[2]!];
	returnCb();
	await reopened;
	assert.match(
		secondMountSelected,
		/third/,
		"middle extension item gone -> selects next neighbour (third, not first)",
	);
});

test("subagent resumed while inside /tasks detail or waited shell is not clobbered by store ticks before returning", async () => {
	const a = agent("a1", "first alpha", 1, "op-a");
	const b1 = waiting(agent("b1", "second beta", 2, "op-b"));
	const c = agent("c1", "third gamma", 3, "op-c");
	const bShell = shell("bs1", "beta build", 4, "b1");
	const store = new FakeOwnerTaskStore([a, b1, c, bShell]);
	const env = taskTranscriptEnvironment({
		tui: { requestRender() {}, terminal: { rows: 24, columns: 100 } } as unknown as TUI,
		keybindings: getKeybindings(),
	});
	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {},
		undefined,
		() => env,
	);
	try {
		// Board order: Working [c1, a1], Waiting [b1]. Select b1 (index 2).
		inspector.handleInput(DOWN);
		inspector.handleInput(DOWN);
		assert.equal(inspector.navigation.selectedId, "b1");

		// Open waited shell via Alt+W.
		inspector.handleInput(ALT_W);
		await tick();
		assert.equal(inspector.navigation.focus.kind, "detail");

		// While inside waited shell, b1 wakes / resumes as b2 (superseding and replacing b1) and multiple store ticks fire!
		const b2 = agent("b2", "second beta resumed", 5, "op-b:resume:1");
		store.set([a, c, b2, bShell]);
		store.update("c1", (task) => ({ ...task, metrics: { ...task.metrics, tokenCount: 500 } }));
		store.update("a1", (task) => ({ ...task, metrics: { ...task.metrics, tokenCount: 600 } }));

		// Press <- to return to /tasks list: must select b2 (the resumed attempt), NOT jump to c1!
		inspector.handleInput(LEFT);
		const lines = plain(inspector.renderPicker(100, 12));
		assert.equal(inspector.navigation.selectedId, "b2", lines.join("\n"));
		assert.match(selectedLine(lines), /second beta resumed/, lines.join("\n"));
	} finally {
		inspector.dispose();
	}
});

test("/tasks keeps scroll steady without jumping when returning from detail or re-opening a deep subagent in a short viewport", async () => {
	// Part 1: 20 subagents; select the 14th, open it via Enter, re-open /tasks in a 10-row picker -> selected row is visible and scroll is preserved.
	const session = { extensionRunner: {} };
	const subagents = Array.from({ length: 20 }, (_, i) => agent(`a${i}`, `subagent-${i}`, i + 1));
	const store = new FakeOwnerTaskStore(subagents);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	let beforeLeave: string[] = [];
	let chosenTitle = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			for (let i = 0; i < 13; i++) component.handleInput(DOWN);
			beforeLeave = rows();
			const sel = selectedLine(beforeLeave);
			assert.match(sel, /subagent-6\b/);
			chosenTitle = sel;
			component.handleInput(ENTER);
		}, 10).ui,
	);
	assert.equal(bridge.viewedTaskId(), "a6");

	let afterReturn: string[] = [];
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			afterReturn = rows();
			component.handleInput(ESC);
		}, 10).ui,
	);
	assert.equal(selectedLine(afterReturn), chosenTitle, "selected subagent stays selected and visible");
	assert.deepEqual(afterReturn, beforeLeave, "scroll window matches before leaving");

	// Part 2: shell output & TaskDetail round-trips keep selection across re-sort and removal (<- and Esc).
	const shells = Array.from({ length: 14 }, (_, i) => shell(`s${i}`, `cmd-${i}`, i + 1));
	const shellStore = new FakeOwnerTaskStore(shells);
	const env = taskTranscriptEnvironment({
		tui: { requestRender() {}, terminal: { rows: 24, columns: 100 } } as unknown as TUI,
		keybindings: getKeybindings(),
	});
	const inspector = new TaskInspector(
		ownerTaskViewSource(shellStore),
		() => {},
		() => {},
		undefined,
		() => env,
	);
	try {
		// Move to index 10 (cmd-3), move up 2 to index 8 (cmd-5) so selection sits inside the visible window.
		for (let i = 0; i < 10; i++) {
			inspector.handleInput(DOWN);
			inspector.renderPicker(100, 10);
		}
		inspector.handleInput(UP);
		inspector.renderPicker(100, 10);
		inspector.handleInput(UP);
		const before = plain(inspector.renderPicker(100, 10));
		const chosen = inspector.navigation.selectedId!;
		assert.match(selectedLine(before), new RegExp(`cmd-${chosen.slice(1)}\\b`));

		// Open shell output (Enter) -> return (<-): exact window preserved.
		inspector.handleInput(ENTER);
		await tick();
		inspector.handleInput(LEFT);
		assert.deepEqual(plain(inspector.renderPicker(100, 10)), before);

		// Open TaskDetail (Space -> Enter) -> finish shell (re-sorts to Done at bottom) -> Esc back to list: selected row visible!
		inspector.handleInput(SPACE);
		inspector.handleInput(ENTER);
		await tick();
		assert.equal(inspector.navigation.focus.kind, "detail");
		shellStore.update(chosen, done);
		inspector.handleInput(ESC);
		const afterDetailEsc = plain(inspector.renderPicker(100, 10));
		assert.equal(inspector.navigation.selectedId, chosen);
		assert.match(
			selectedLine(afterDetailEsc),
			new RegExp(`cmd-${chosen.slice(1)}\\b.*done`),
			afterDetailEsc.join("\n"),
		);
	} finally {
		inspector.dispose();
	}
});

test("agent panel returning from a nested shell that finished selects its nearest neighbour instead of jumping to top", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		shell("s1", "alpha build", 3, "a1"),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// Panel order: [a2 (beta), a1 (alpha), s1 (alpha build)].
	// Focus panel -> Down x2 to s1 -> Enter (opens shell output) -> s1 finishes -> <- returns to panel -> should select a1 (not a2!).
	let returnedSelected = "";
	const { ui } = mountUi(async (component, rows, mountIndex) => {
		if (mountIndex === 1) {
			component.handleInput(DOWN); // a1
			component.handleInput(DOWN); // s1
			assert.match(selectedLine(rows()), /alpha build/);
			component.handleInput(ENTER);
		} else if (mountIndex === 2) {
			await tick();
			store.update("s1", done);
			component.handleInput(LEFT);
		} else {
			returnedSelected = selectedLine(rows());
			component.handleInput(ESC);
		}
	});
	await showAgentPanel(session, ui);
	assert.match(returnedSelected, /first alpha/, "when nested shell s1 leaves, selects neighbour a1 instead of top a2");
});

test("AgentPanelFocus live update selects next surviving neighbour when selected row leaves and a new row prepends", () => {
	const row = (id: string): AgentPanelRow => ({
		id,
		kind: "agent",
		state: "running",
		name: id,
		task: id,
	});
	const focus = new AgentPanelFocus(getKeybindings(), {
		open() {},
		stop() {},
		dismiss() {},
		close() {},
	});
	focus.update([row("r1"), row("r2"), row("r3")]);
	focus.enter("r2");
	assert.equal(focus.selectedId, "r2");

	// r2 leaves and r0 is prepended at index 0 -> nearest neighbour after r2 is r3 (NOT r1 at index 1!).
	focus.update([row("r0"), row("r1"), row("r3")]);
	assert.equal(focus.selectedId, "r3");
});

test("TaskDetail dismiss (x) and stdin sheet (i -> <-) preserve selection or pick nearest neighbour", async () => {
	setKeybindings(new KeybindingsManager({ "app.tasks.input": "i" }));
	const s1 = shell("s1", "cmd-one", 1);
	const s2 = shell("s2", "cmd-two", 2);
	const s3 = shell("s3", "cmd-three", 3);
	const store = new FakeOwnerTaskStore([s1, s2, s3]);
	const source = ownerTaskViewSource(store);
	const stdinSource = Object.create(source, {
		stdinAvailable: { value: () => true },
		writeTaskInput: { value: async () => ({ ok: true as const, value: { acceptedBytes: 0 } }) },
	}) as typeof source;
	const inspector = new TaskInspector(
		stdinSource,
		() => {},
		() => {},
	);
	const focusKind = () => inspector.navigation.focus.kind;
	try {
		// Order is [s3, s2, s1]. Select middle s2.
		inspector.handleInput(DOWN);
		assert.equal(inspector.navigation.selectedId, "s2");

		// Open stdin sheet via i -> finish s2 (re-sorts to Done at bottom) -> <- returns to list on s2.
		inspector.handleInput("i");
		assert.equal(focusKind(), "stdin");
		store.update("s2", done);
		inspector.handleInput(LEFT);
		assert.equal(focusKind(), "tasks");
		assert.equal(inspector.navigation.selectedId, "s2");

		// Open TaskDetail via Space -> Enter, paint it, then dismiss s2 via x -> returns to list on previous neighbour s1 (since s2 was last in Done).
		inspector.handleInput(SPACE);
		inspector.handleInput(ENTER);
		await tick();
		assert.equal(focusKind(), "detail");
		inspector.renderViewport(100, 24);
		inspector.handleInput("x");
		assert.equal(focusKind(), "tasks");
		assert.equal(
			inspector.navigation.selectedId,
			"s1",
			"dismissing last item s2 from detail selects previous neighbour s1",
		);
	} finally {
		inspector.dispose();
	}
});

test("clicking a nested shell in the focused or idle agent panel returns to its nearest neighbour when it finishes", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		shell("s1", "alpha build", 3, "a1"),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	let returnedSelected = "";
	const { ui } = mountUi(async (component, rows, mountIndex) => {
		if (mountIndex === 1) {
			const lines = rows();
			const shellRow = lines.findIndex((line) => line.includes("alpha build"));
			assert.notEqual(shellRow, -1, lines.join("\n"));
			component.handleMouse?.({
				type: "click",
				button: "left",
				x: 6,
				y: shellRow,
				screenX: 6,
				screenY: 30 + shellRow,
				width: 100,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
		} else if (mountIndex === 2) {
			await tick();
			store.update("s1", done);
			component.handleInput(LEFT);
		} else {
			returnedSelected = selectedLine(rows());
			component.handleInput(ESC);
		}
	});
	await showAgentPanel(session, ui);
	assert.match(returnedSelected, /first alpha/, "click on nested shell -> finishes -> <- returns to neighbour a1");
});

test("closing /tasks with Esc while still viewing a subagent preserves its departure order for later return or dismissal", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// Open /tasks -> select a2 (middle of [a3, a2, a1]) -> Enter -> viewing a2.
	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(ENTER);
		}).ui,
	);
	assert.equal(bridge.viewedTaskId(), "a2");

	// Glance at /tasks while still viewing a2, then press Esc back to a2.
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ESC);
		}).ui,
	);
	assert.equal(bridge.viewedTaskId(), "a2");

	// Now a2 finishes and is dismissed (returning screen to main); reopening /tasks must pick next neighbour a1 (NOT top a3!).
	store.update("a2", done);
	dismissedTasks(ownerTaskViewSource(store)).add("a2" as TaskId);
	bridge.show(undefined);

	let afterDismiss = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			afterDismiss = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterDismiss, /first alpha/, "departure order survived Esc while viewing a2");
});

test("resumed subagent opened from TaskDetail keeps original departure neighbours if the resumed attempt is also dismissed", async () => {
	const session = { extensionRunner: {} };
	const a1 = agent("a1", "first alpha", 1, "op-a");
	const b1 = agent("b1", "second beta", 2, "op-b");
	const c1 = agent("c1", "third gamma", 3, "op-c");
	const store = new FakeOwnerTaskStore([a1, b1, c1]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// Open /tasks -> select middle b1 -> Space -> Enter (TaskDetail) -> b1 resumes as b2 -> Enter (Inspect transcript -> showAgent(b2)).
	await openTasks(
		session,
		store,
		mountUi(async (component, rows, mountIndex) => {
			if (mountIndex === 1) {
				component.handleInput(DOWN); // b1
				assert.match(selectedLine(rows()), /second beta/);
				component.handleInput(SPACE);
				component.handleInput(ENTER);
			} else {
				const b2 = agent("b2", "second beta resumed", 4, "op-b:resume:1");
				store.set([a1, done(b1), c1, b2]);
				await tick();
				component.handleInput(ENTER); // Inspect transcript -> showAgent(b2)
			}
		}).ui,
	);
	assert.equal(bridge.viewedTaskId(), "b2");

	// Now dismiss b2 too and return to main -> reopening /tasks must select original next neighbour a1 (not top c1!).
	store.update("b2", done);
	dismissedTasks(ownerTaskViewSource(store)).add("b2" as TaskId);
	bridge.show(undefined);

	let afterBothGone = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			afterBothGone = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterBothGone, /first alpha/, "resumed attempt replacement kept departure neighbour a1");
});

test("focused agent panel follows a selected subagent that resumes under a new attempt id, and ? help leaves /tasks selection unchanged", async () => {
	const session = { extensionRunner: {} };
	const a1 = agent("a1", "first alpha", 1, "op-a");
	const b1 = agent("b1", "second beta", 2, "op-b");
	const c1 = agent("c1", "third gamma", 3, "op-c");
	const store = new FakeOwnerTaskStore([a1, b1, c1]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	let afterResumeSelected = "";
	await showAgentPanel(
		session,
		mountUi(async (component, rows) => {
			component.handleInput(DOWN); // b1
			assert.match(selectedLine(rows()), /second beta/);
			const b2 = agent("b2", "second beta resumed", 4, "op-b:resume:1");
			store.set([a1, done(b1), c1, b2]);
			await tick();
			afterResumeSelected = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterResumeSelected, /second beta resumed/, "focused panel follows resumed attempt");

	// ? help overlay on /tasks list and detail leaves selection & scroll unchanged.
	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {},
	);
	try {
		inspector.handleInput(DOWN); // second row
		const beforeId = inspector.navigation.selectedId;
		inspector.handleInput("?");
		inspector.handleInput(DOWN); // swallowed by help
		inspector.handleInput(ESC); // closes help only
		assert.equal(inspector.navigation.selectedId, beforeId, "? help did not move selection");
	} finally {
		inspector.dispose();
	}
});

test("V1: Home on TaskDetail after the viewed task was removed keeps the new selection when returning to /tasks", async () => {
	const a1 = agent("a1", "first alpha", 1);
	const a2 = agent("a2", "second beta", 2);
	const a3 = agent("a3", "third gamma", 3);
	const store = new FakeOwnerTaskStore([a1, a2, a3]);
	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {},
	);
	try {
		// Board order: [a3, a2, a1]. Select middle a2 and open TaskDetail (Space -> Enter).
		inspector.handleInput(DOWN);
		assert.equal(inspector.navigation.selectedId, "a2");
		inspector.handleInput(SPACE);
		inspector.handleInput(ENTER);
		await tick();
		assert.equal(inspector.navigation.focus.kind, "detail");

		// Remove viewed task a2 while in TaskDetail, then press Home -> jumps to a3.
		store.set([a1, a3]);
		inspector.handleInput(HOME);
		assert.equal(inspector.navigation.focus.kind, "detail");
		assert.equal(inspector.navigation.selectedId, "a3");

		// Return to /tasks via Esc (and also verify <-): must stay on a3, not snap back to stale neighbour a1.
		inspector.handleInput(ESC);
		assert.equal(inspector.navigation.focus.kind, "tasks");
		assert.equal(inspector.navigation.selectedId, "a3");
	} finally {
		inspector.dispose();
	}
});

test("V2: focused agent panel follows a resumed subagent even when the previous attempt is evicted from backgroundTasks", async () => {
	const session = { extensionRunner: {} };
	const a1 = agent("a1", "first alpha", 1, "op-1");
	const a2 = agent("a2", "second beta", 2, "op-2");
	const a3 = agent("a3", "third gamma", 3, "op-3");
	const store = new FakeOwnerTaskStore([a1, a2, a3]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	let afterResume = "";
	await showAgentPanel(
		session,
		mountUi(async (component, rows) => {
			component.handleInput(DOWN); // select middle a2
			assert.match(selectedLine(rows()), /second beta/);
			// a2 resumes as a2r AND a2 is evicted from backgroundTasks.
			const a2r = agent("a2r", "second beta resumed", 4, "op-2:resume:1");
			store.set([a1, a2r, a3]);
			await tick();
			afterResume = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterResume, /second beta resumed/, "evicted old attempt still resolves to resumed attempt a2r");
});

test("V3: re-entering /tasks after an opened subagent resumed and its resumed attempt was evicted selects original nearest neighbour", async () => {
	const session = { extensionRunner: {} };
	const a1 = agent("a1", "first alpha", 1, "op-1");
	const a2 = agent("a2", "second beta", 2, "op-2");
	const a3 = agent("a3", "third gamma", 3, "op-3");
	const store = new FakeOwnerTaskStore([a1, a2, a3]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// Open middle a2 from /tasks ([a3, a2, a1]).
	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(ENTER);
		}).ui,
	);
	assert.equal(bridge.viewedTaskId(), "a2");

	// a2 resumes to a2r (bridge now names a2r), then both a2 and a2r are evicted before the bridge clears.
	bridge.show("a2r");
	store.set([a1, a3]);

	let reentered = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			reentered = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(reentered, /first alpha/, "evicted resumed attempt falls back to departure neighbour a1, not top a3");
});

test("V4: isolated engine Esc on /tasks before set_viewed_agent arrives keeps the return anchor alive across the pending view", async () => {
	const session = { extensionRunner: {} } as never as AgentSession;
	const store = new FakeOwnerTaskStore([
		agent("a1", "first alpha", 1),
		agent("a2", "second beta", 2),
		agent("a3", "third gamma", 3),
	]);
	bindOwnerTaskStore(session, store);
	const sent: InteractiveEngineMessage[] = [];
	const context = { session, send: (message: InteractiveEngineMessage) => sent.push(message) } as never;
	disposers.push(installEngineAgentViewBridge(context));

	// Open /tasks, select a2, press Enter -> engine sends engine_view_agent(a2) (pending, not acked yet).
	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(ENTER);
		}).ui,
	);
	assert.equal(sent.at(-1)?.type, "engine_view_agent");

	// Re-open /tasks BEFORE set_viewed_agent(a2) arrives, then press Esc.
	let beforeAck = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			beforeAck = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(beforeAck, /second beta/);

	// Now host delivers set_viewed_agent(a2), then user goes back to main (set_viewed_agent(undefined)).
	await handleSetViewedAgent({ id: "v1", type: "set_viewed_agent", taskId: "a2" }, context);
	await handleSetViewedAgent({ id: "v2", type: "set_viewed_agent" }, context);

	// Re-open /tasks on main: must STILL restore a2 (anchor survived the in-flight Esc!).
	let afterReturn = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			afterReturn = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(afterReturn, /second beta/, "return anchor survived Esc during in-flight view request");

	// And dismissing /tasks on settled main (no pending view) still clears the anchor for the next fresh /tasks.
	let freshOnMain = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			freshOnMain = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(freshOnMain, /third gamma/, "Esc on settled main clears anchor so fresh /tasks starts at top");

	// Also verify failed open recovery: Enter a2 (pending) -> host fails and sends set_viewed_agent(undefined) ->
	// bridge settles back to main, so a subsequent /tasks -> Esc clears the anchor cleanly.
	await openTasks(
		session,
		store,
		mountUi((component) => {
			component.handleInput(DOWN);
			component.handleInput(ENTER);
		}).ui,
	);
	await handleSetViewedAgent({ id: "v3", type: "set_viewed_agent" }, context);
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			assert.match(selectedLine(rows()), /second beta/);
			component.handleInput(ESC);
		}).ui,
	);
	let freshAfterFailedOpen = "";
	await openTasks(
		session,
		store,
		mountUi((component, rows) => {
			freshAfterFailedOpen = selectedLine(rows());
			component.handleInput(ESC);
		}).ui,
	);
	assert.match(freshAfterFailedOpen, /third gamma/, "failed open settled to main so Esc cleared the anchor");
});

test("clicking a nested shell on the 4th row of a >4-row idle agent panel returns to the next full-panel neighbour when it finishes", async () => {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore([
		agent("a1", "row-1", 1),
		agent("a2", "row-2", 2),
		agent("a3", "row-3", 3),
		agent("a4", "row-4", 4),
		agent("a5", "row-5", 5),
		shell("s3", "shell-3", 6, "a3"),
	]);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge();
	setAgentViewBridge(session, bridge);

	// Full panel order: [a5, a4, a3, s3, a2, a1]. Idle cap (4 rows) shows [main, a5, a4, a3, s3, +2 more].
	// Click s3 -> s3 finishes -> <- opens focused panel: next surviving neighbour after s3 is a2 (row-2), not a3 or a5!
	let returnedSelected = "";
	const { ui } = mountUi(async (component, rows, mountIndex) => {
		if (mountIndex === 1) {
			await tick();
			store.update("s3", done);
			component.handleInput(LEFT);
		} else {
			returnedSelected = selectedLine(rows());
			component.handleInput(ESC);
		}
	});
	let widget: Mounted | undefined;
	disposers.push(
		bindAgentPanel(
			session as never,
			{
				setWidget(_key: string, content: unknown) {
					widget = typeof content === "function" ? (content({} as never, {} as never) as Mounted) : undefined;
				},
				requestRender() {},
			} as never,
			undefined,
			ui,
		),
	);
	const idleLines = plain(widget!.render(100));
	const s3Row = idleLines.findIndex((line) => line.includes("shell-3"));
	assert.notEqual(s3Row, -1, idleLines.join("\n"));
	widget!.handleMouse?.({
		type: "click",
		button: "left",
		x: 6,
		y: s3Row,
		screenX: 6,
		screenY: 30 + s3Row,
		width: 100,
		height: idleLines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	});
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match(returnedSelected, /row-2/, "next neighbour below the 4-row idle cap is selected");
});
