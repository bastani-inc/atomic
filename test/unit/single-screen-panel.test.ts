import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, type TuiMouseEvent, type TuiMouseEventResult } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	dismissedAgentPanelItems,
	subscribeAgentPanel,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type AgentViewBridge,
	setAgentViewBridge,
} from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-bridge.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.js";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
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

const ENTER = "\r";

beforeAll(() => initTheme("dark"));
let keys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	setKeybindings(keys);
});

function agent(id: string, name = "worker"): TaskRecord {
	return { ...taskRecord(id), agentName: name, title: `job ${id}`, wasBackground: true };
}

/** The screen's view as the panel reaches it: what it shows, and every view it was asked for. */
function fakeBridge(viewed?: string) {
	const requests: Array<string | undefined> = [];
	const listeners = new Set<() => void>();
	let shown = viewed as TaskId | undefined;
	const bridge: AgentViewBridge & { requests: typeof requests; show(id: string | undefined): void } = {
		requests,
		viewedTaskId: () => shown,
		requestView: (taskId) => {
			requests.push(taskId);
		},
		subscribe: (listener) => {
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

function panelSession(tasks: TaskRecord[], viewed?: string) {
	const session = { extensionRunner: {} };
	const store = new FakeOwnerTaskStore(tasks);
	bindOwnerTaskStore(session, store);
	const bridge = fakeBridge(viewed);
	setAgentViewBridge(session, bridge);
	return { session, store, bridge };
}

interface Mounted {
	render(width: number): string[];
	handleInput(data: string): boolean;
	dispose?(): void;
}

/** A host that mounts the focused panel (and records any other view it is asked to mount), driving it with `drive`. */
function hostUi(drive: (component: Mounted, mount: number) => Promise<void> | void) {
	const mounts: string[][] = [];
	const ui: TaskInspectorUi = {
		notify() {},
		async custom(factory) {
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const component = (await factory(
				{ requestRender() {}, terminal: { rows: 24 } } as never,
				theme,
				new KeybindingsManager(),
				finish as never,
			)) as Mounted;
			mounts.push(component.render(100).map((line) => stripVTControlCharacters(line).trimEnd()));
			// Any other view a step mounts is only recorded, and leaves at once.
			if (mounts.length > 1) finish();
			else await drive(component, mounts.length);
			await finished;
			component.dispose?.();
			return undefined as never;
		},
	};
	return { ui, mounts };
}

test("Enter on a subagent row of the focused panel shows that subagent on the screen instead of opening its page", async () => {
	const { session, bridge } = panelSession([agent("a1"), agent("a2", "explorer")]);
	const { ui, mounts } = hostUi((component) => {
		component.handleInput(ENTER);
	});
	await showAgentPanel(session, ui);
	// The newest subagent leads the panel, and ↓ focused it.
	assert.match(mounts[0]![1] ?? "", /^❯ .* explorer /, mounts[0]!.join("\n"));
	assert.deepEqual(bridge.requests, ["a2"]);
	assert.equal(mounts.length, 1, "no subagent page is mounted after the panel");
});

const UP = "\x1b[A";

test("Enter on the main row shows main again while a subagent is shown, and only closes the panel while main is", async () => {
	for (const viewed of ["a1", undefined]) {
		const { session, bridge } = panelSession([agent("a1")], viewed);
		const { ui, mounts } = hostUi((component) => {
			component.handleInput(UP);
			component.handleInput(ENTER);
		});
		await showAgentPanel(session, ui);
		assert.equal(mounts.length, 1);
		assert.deepEqual(bridge.requests, viewed === undefined ? [] : [undefined], `viewing ${viewed ?? "main"}`);
	}
});

function done(task: TaskRecord): TaskRecord {
	return {
		...task,
		observation: { kind: "none", reason: "task-settled" },
		execution: { kind: "settled", result: { kind: "completed", output: task.output } },
	} as TaskRecord;
}

/** A drawn row as its mark and name: `● w1` for the shown subagent's row, `  w2` for another; other lines as drawn. */
function rowName(line: string): string {
	if (/^ {2}(\+\d+|↑ \d+) more$/.test(line)) return line;
	return `${line.slice(0, 2)}${
		line
			.slice(4)
			.trimStart()
			.split(/\s{2,}/)[0]
	}`;
}

interface IdleWidget {
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/** The panel below the prompt, as the screen draws it; `inspector` is where its clicks open views. */
function idlePanel(session: object, inspector?: TaskInspectorUi) {
	let widget: IdleWidget | undefined;
	const dispose = bindAgentPanel(
		session as never,
		{
			setWidget(_key: string, content: unknown) {
				widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
			},
			requestRender() {},
		} as never,
		undefined,
		inspector,
	);
	disposers.push(dispose);
	return {
		lines: (width = 100) => (widget?.render(width) ?? []).map((line) => stripVTControlCharacters(line).trimEnd()),
		click(line: number) {
			return widget?.handleMouse?.({
				type: "click",
				button: "left",
				x: 4,
				y: line,
				screenX: 4,
				screenY: 30 + line,
				width: 100,
				height: 6,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
		},
	};
}

test("the shown subagent stays listed once it finished, marked, with main above it; shown main lists nothing finished", () => {
	const shown = panelSession([done(agent("a1"))], "a1");
	const lines = idlePanel(shown.session).lines();
	assert.equal(lines[0], "  ● main", lines.join("\n"));
	assert.match(lines[1] ?? "", /^● ✓ worker +job a1 +done$/, lines.join("\n"));
	assert.equal(lines.length, 2, lines.join("\n"));

	const main = panelSession([done(agent("a1"))]);
	assert.deepEqual(idlePanel(main.session).lines(), []);
});

test("the panel below the prompt always draws the shown subagent: past its four rows it takes the last place", () => {
	const tasks = ["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => agent(id, `w${id.slice(1)}`));
	const { session } = panelSession(tasks, "a1");
	const lines = idlePanel(session).lines();
	// Newest first: w6 w5 w4, then the shown w1 instead of w3; w3 and w2 are the two more.
	assert.deepEqual(lines.map(rowName), ["  main", "  w6", "  w5", "  w4", "● w1", "  +2 more"], lines.join("\n"));
});

/** A shell the subagent `parent` launched: it names the subagent's task and its session. */
function shellOf(id: string, parent: string, command = "npm test"): TaskRecord {
	return {
		...taskRecord(id, "command"),
		title: command,
		parentTaskId: parent as TaskId,
		launchedBy: `session-${parent}`,
		wasBackground: true,
	};
}

test("a subagent's own running shells are listed right under it, indented, and leave once they finish", () => {
	const { session, store } = panelSession([agent("a1"), agent("a2", "explorer"), shellOf("s1", "a1")]);
	const panel = idlePanel(session);
	let lines = panel.lines();
	assert.equal(lines[0], "  ● main", lines.join("\n"));
	assert.match(lines[1] ?? "", /^ {2}\S explorer {2}job a2/, lines.join("\n"));
	assert.match(lines[2] ?? "", /^ {2}\S worker {4}job a1/, lines.join("\n"));
	// The shell's name starts under its subagent's, and its command in the task column.
	assert.match(lines[3] ?? "", /^ {4}⧗ shell {3}npm test +\d+s$/, lines.join("\n"));
	assert.equal(lines.length, 4, lines.join("\n"));

	store.update("s1", done);
	lines = panel.lines();
	assert.equal(lines.length, 3, lines.join("\n"));
	assert.ok(!lines.some((line) => line.includes("npm test")), lines.join("\n"));
});

const DOWN = "\x1b[B";

const ESC = "\x1b";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("x twice on a subagent's shell row stops that shell only", async () => {
	const { session, store, bridge } = panelSession([agent("a1"), shellOf("s1", "a1")]);
	const { ui, mounts } = hostUi(async (component) => {
		// ↓ focused the subagent's row; the shell is the row under it.
		component.handleInput(DOWN);
		component.render(100);
		component.handleInput("x");
		assert.deepEqual(store.cancelled, [], "the first x only asks");
		component.handleInput("x");
		await tick();
		component.handleInput(ESC);
	});
	await showAgentPanel(session, ui);
	assert.deepEqual(store.cancelled, ["s1"], mounts[0]?.join("\n"));
	assert.equal(store.taskRecord("a1" as TaskId)?.execution.kind, "running", "its subagent still runs");
	assert.deepEqual(bridge.requests, []);
});

test("Enter on a subagent's shell row opens that shell's output, and never shows the shell on the screen", async () => {
	const { session, bridge } = panelSession([agent("a1"), shellOf("s1", "a1", "npm run watch")]);
	const { ui, mounts } = hostUi((component) => {
		component.handleInput(DOWN);
		component.render(100);
		component.handleInput(ENTER);
	});
	await showAgentPanel(session, ui);
	await tick();
	assert.deepEqual(bridge.requests, []);
	assert.equal(mounts.length, 2, mounts.map((lines) => lines.join("\n")).join("\n----\n"));
	// The shell's output page, whose ← goes back to the agent panel.
	assert.match(mounts[1]![0] ?? "", /^Transcript · bash/, mounts[1]!.join("\n"));
	assert.ok(
		mounts[1]!.some((line) => line.replace(/_pi:\/?h(:k:[^←\s]*)?/g, "").includes("← agents")),
		mounts[1]!.join("\n"),
	);
});

/** `/tasks` of the session, as the main chat opens it. */
function openTasks(session: object, store: FakeOwnerTaskStore, ui: TaskInspectorUi, taskId?: string) {
	return showTaskInspector(ui, store, taskId, { board: agentPanelBoardSource(session as never) });
}

test("Enter on a subagent in /tasks closes /tasks and shows that subagent on the screen", async () => {
	const { session, store, bridge } = panelSession([agent("a1"), agent("a2", "explorer")]);
	const { ui, mounts } = hostUi((component) => {
		component.handleInput(ENTER);
	});
	await openTasks(session, store, ui, "a1");
	assert.deepEqual(bridge.requests, ["a1"], mounts.map((lines) => lines.join("\n")).join("\n----\n"));
	assert.equal(mounts.length, 1, "no subagent page");
});

test("Enter on a subagent in /tasks asks for it before /tasks closes, keeping the screen until it is shown", async () => {
	const { session, store, bridge } = panelSession([agent("a1"), agent("a2", "explorer")]);
	const events: string[] = [];
	bridge.requestView = (taskId, options) => {
		events.push(`show ${taskId} keepScreen=${options?.keepScreen === true}`);
	};
	const { ui } = hostUi((component) => {
		component.handleInput(ENTER);
	});
	const custom = ui.custom.bind(ui);
	ui.custom = (factory, options) =>
		custom(
			(tui, styles, keybindings, done) =>
				factory(tui, styles, keybindings, (result) => {
					events.push("close /tasks");
					done(result);
				}),
			options,
		);
	await openTasks(session, store, ui, "a1");
	assert.deepEqual(events, ["show a1 keepScreen=true", "close /tasks"]);

	// In the engine the request reaches the host ahead of the close, on the same ordered line.
	const engineSession = { extensionRunner: {} } as never as AgentSession;
	const engineStore = new FakeOwnerTaskStore([agent("a1")]);
	bindOwnerTaskStore(engineSession, engineStore);
	const sent: InteractiveEngineMessage[] = [];
	disposers.push(
		installEngineAgentViewBridge({
			session: engineSession,
			send: (message: InteractiveEngineMessage) => sent.push(message),
		} as never),
	);
	const engineUi = hostUi((component) => {
		component.handleInput(ENTER);
	}).ui;
	await openTasks(engineSession, engineStore, engineUi, "a1");
	assert.deepEqual(sent, [{ type: "engine_view_agent", taskId: "a1", keepScreen: true }]);
});

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

test("a subagent's detail page in /tasks shows it on the screen from its transcript and its question actions", async () => {
	for (const action of ["transcript", "question"] as const) {
		const { session, store, bridge } = panelSession([agent("a1")]);
		const { ui, mounts } = hostUi(async (component) => {
			// Space peeks at the row, Enter on the empty peek opens its detail page.
			component.handleInput(" ");
			component.handleInput(ENTER);
			const label = action === "question" ? "› Open question" : "› Inspect transcript";
			const page = () => component.render(100).map((line) => stripVTControlCharacters(line));
			if (action === "question") {
				store.update("a1", asking);
				await tick();
				// The question is the last of the page's actions.
				for (let press = 0; press < 3 && !page().some((line) => line.includes(label)); press++)
					component.handleInput(DOWN);
			}
			assert.ok(
				page().some((line) => line.includes(label)),
				page().join("\n"),
			);
			component.handleInput(ENTER);
		});
		await openTasks(session, store, ui, "a1");
		assert.deepEqual(bridge.requests, ["a1"], action);
		assert.equal(mounts.length, 1, action);
	}
});

test("Enter on a subagent that needs input in /tasks shows it on the screen, where its question waits", async () => {
	const { session, store, bridge } = panelSession([asking(agent("a1"))]);
	const { ui } = hostUi((component) => {
		component.handleInput(ENTER);
	});
	await openTasks(session, store, ui, "a1");
	assert.deepEqual(bridge.requests, ["a1"]);
});

test("a click on a subagent row below the prompt shows it, and a click on main shows main again", () => {
	for (const viewed of [undefined, "a1"]) {
		const { session, bridge } = panelSession([agent("a1"), agent("a2", "explorer")], viewed);
		const { ui, mounts } = hostUi(() => {});
		const panel = idlePanel(session, ui);
		const lines = panel.lines();
		assert.equal(panel.click(0)?.handled, true, "the main row takes the click");
		assert.deepEqual(bridge.requests, viewed === undefined ? [] : [undefined], `viewing ${viewed ?? "main"}`);
		const explorer = lines.findIndex((line) => line.includes("explorer"));
		assert.equal(panel.click(explorer)?.handled, true);
		assert.deepEqual(bridge.requests.at(-1), "a2");
		assert.equal(mounts.length, 0, "no page opens");
	}
});

test("pinned below the prompt, the shown subagent keeps its shells under it, and +N more counts every row left out", () => {
	const tasks = ["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => agent(id, `w${id.slice(1)}`));
	const { session } = panelSession([...tasks, shellOf("s1", "a1")], "a1");
	const lines = idlePanel(session).lines();
	assert.deepEqual(lines.map(rowName), ["  main", "  w6", "  w5", "● w1", "  ⧗ shell", "  +3 more"], lines.join("\n"));
});

test("a dismissed subagent is not kept, even while the screen still shows it", () => {
	const { session } = panelSession([done(agent("a1"))], "a1");
	dismissedAgentPanelItems(session).add("task:a1");
	assert.deepEqual(idlePanel(session).lines(), []);
});

test("in the engine, set_viewed_agent marks the shown subagent in its panel, and Enter there asks the host to show one", async () => {
	const session = { extensionRunner: {} } as never as AgentSession;
	const store = new FakeOwnerTaskStore([agent("a1"), agent("a2", "explorer")]);
	bindOwnerTaskStore(session, store);
	const sent: InteractiveEngineMessage[] = [];
	const context = { session, send: (message: InteractiveEngineMessage) => sent.push(message) } as never;
	disposers.push(installEngineAgentViewBridge(context));
	const panel = idlePanel(session);
	assert.ok(!panel.lines().some((line) => line.startsWith("●")), "main is shown");

	const answer = await handleSetViewedAgent({ id: "v1", type: "set_viewed_agent", taskId: "a1" }, context);
	assert.equal(answer.success, true);
	await tick();
	assert.match(panel.lines().find((line) => line.startsWith("●")) ?? "", /^● \S worker /, panel.lines().join("\n"));

	const { ui } = hostUi((component) => {
		component.handleInput(ENTER);
	});
	await showAgentPanel(session, ui);
	// ↓ focused the newest row, explorer; the host decides, so the engine's mark waits for its answer.
	assert.deepEqual(sent, [{ type: "engine_view_agent", taskId: "a2" }]);
	assert.match(panel.lines().find((line) => line.startsWith("●")) ?? "", /worker/);

	await handleSetViewedAgent({ type: "set_viewed_agent" }, context);
	await tick();
	assert.ok(!panel.lines().some((line) => line.startsWith("●")), "main is shown again");
});

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
	} as TaskRecord;
}

test("the waited-shell key of a shown subagent that waits opens /tasks at the newest shell it waits on", async () => {
	const { session, store } = panelSession([
		waiting(agent("a1")),
		{ ...shellOf("s1", "a1", "npm run build"), launchOrdinal: 1 },
		{ ...shellOf("s2", "a1", "npm test"), launchOrdinal: 2 },
	]);
	let page: string[] = [];
	const { ui, mounts } = hostUi(async (component) => {
		await tick();
		page = component.render(100).map((line) => stripVTControlCharacters(line).trimEnd());
		component.handleInput("\x1b[D");
	});
	await openWaitedShellOf(session, ui, "a1");
	assert.equal(mounts.length, 1);
	assert.match(page[0] ?? "", /^Transcript · bash/, page.join("\n"));
	assert.ok(
		page.some((line) => line.includes("no output kept for s2")),
		page.join("\n"),
	);
	assert.deepEqual(store.cancelled, []);
});

/** The main screen's key listeners over an isolated engine, with what the screen shows and what has the focus. */
async function screenKeys(viewed: { state: string; taskId: string } | undefined, focusOnPrompt = true) {
	const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const editor = { getText: () => "", onAction() {} };
	const calls: unknown[][] = [];
	const mode = Object.create(InteractiveModeBase.prototype) as InteractiveModeBase;
	mode.addTuiInputListener = (listener) => {
		listeners.push(listener);
		return () => {};
	};
	mode.footerDataProvider = { setExtensionStatus() {} } as never;
	const slot = {};
	mode.ui = {
		hasOverlay: () => false,
		requestRender() {},
		getFocusedComponent: () => (focusOnPrompt ? editor : slot),
	} as never;
	mode.keybindings = new KeybindingsManager();
	mode.editor = editor as never;
	mode.editorContainer = { children: [editor] } as never;
	mode.isBashMode = false;
	mode.defaultEditor = editor as never;
	mode.showWarning = () => {};
	const runtime = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
	runtime.openTaskInspector = async (...args: unknown[]) => {
		calls.push(["openTaskInspector", ...args]);
	};
	runtime.openAgentPanel = async () => {
		calls.push(["openAgentPanel"]);
	};
	mode.runtimeHost = runtime as never;
	mode.agentView = (
		viewed === undefined
			? { viewed: { kind: "main" } }
			: { viewed: { kind: "agent", port: { status: () => ({ ...viewed, name: "worker" }) } } }
	) as never;
	await mode.setupKeyHandlers();
	return {
		calls,
		press(data: string) {
			return listeners.map((listener) => listener(data)).some((result) => result?.consume === true);
		},
	};
}

const ALT_W = "\x1bw";

test("the waited-shell key opens the shown subagent's newest waited shell, and does nothing otherwise", async () => {
	const waitingShown = await screenKeys({ state: "waiting", taskId: "a1" });
	assert.equal(waitingShown.press(ALT_W), true);
	assert.deepEqual(waitingShown.calls, [["openTaskInspector", undefined, { waitedShellOf: "a1" }]]);

	for (const screen of [await screenKeys(undefined), await screenKeys({ state: "running", taskId: "a1" })]) {
		assert.equal(screen.press(ALT_W), false);
		assert.deepEqual(screen.calls, []);
	}
});

test("↓ focuses the panel from the prompt, but not while a shown subagent's question form has the keys", async () => {
	const prompt = await screenKeys({ state: "input", taskId: "a1" });
	assert.equal(prompt.press(DOWN), true);
	assert.deepEqual(prompt.calls, [["openAgentPanel"]]);

	const form = await screenKeys({ state: "input", taskId: "a1" }, false);
	assert.equal(form.press(DOWN), false);
	assert.deepEqual(form.calls, []);
});

test("x on the shown subagent's finished row dismisses it and tells the panel's watchers, so the screen leaves it", async () => {
	const { session } = panelSession([done(agent("a1"))], "a1");
	let told = 0;
	disposers.push(subscribeAgentPanel(session as never, () => told++));
	const { ui } = hostUi(async (component) => {
		component.render(100);
		component.handleInput("x");
		await tick();
	});
	await showAgentPanel(session, ui);
	assert.ok(dismissedAgentPanelItems(session).has("task:a1"));
	assert.ok(told > 0, "the dismissal is told");
});

test("a resumed subagent is one row: the mark and its pin follow its latest attempt, whichever attempt the screen names", () => {
	const first = { ...done(agent("a1")), launchOperationId: "op-a1", launchOrdinal: 1 } as TaskRecord;
	const resumed = { ...agent("a1-r", "worker"), launchOperationId: "op-a1:resume:1", launchOrdinal: 2 } as TaskRecord;
	const others = ["b1", "b2", "b3", "b4"].map((id, index) => ({ ...agent(id, `w${id}`), launchOrdinal: 3 + index }));
	for (const named of ["a1", "a1-r"]) {
		const { session } = panelSession([first, resumed, ...others], named);
		const lines = idlePanel(session).lines();
		const marked = lines.filter((line) => line.startsWith("●"));
		assert.equal(marked.length, 1, lines.join("\n"));
		assert.match(marked[0]!, /^● \S worker +job a1-r/, lines.join("\n"));
	}
});

test("while no subagent shell runs, a panel pass reads the owner's tasks no more often than without the single screen", () => {
	const finishedShell: TaskRecord = {
		...shellOf("s1", "a1"),
		execution: { kind: "settled", result: { kind: "cancelled", cause: "user" } },
	};
	const { session, store } = panelSession([agent("a1"), agent("a2", "explorer"), finishedShell]);
	let ownerReads = 0;
	const read = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(FakeOwnerTaskStore.prototype),
		"ownerBackgroundTasks",
	);
	Object.defineProperty(store, "ownerBackgroundTasks", {
		get() {
			ownerReads++;
			return read?.get?.call(store);
		},
	});
	idlePanel(session).lines();
	assert.equal(ownerReads, 0);

	store.set([agent("a1"), agent("a2", "explorer"), shellOf("s1", "a1")]);
	const lines = idlePanel(session).lines();
	assert.ok(ownerReads > 0, "a running subagent shell is read to be listed");
	assert.ok(
		lines.some((line) => line.includes("npm test")),
		lines.join("\n"),
	);
});
