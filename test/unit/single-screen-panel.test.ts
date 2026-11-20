import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type AgentViewBridge,
	setAgentViewBridge,
} from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-bridge.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel, showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import type { TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
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

/** The panel below the prompt, as the screen draws it. */
function idlePanel(session: object) {
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(
		session as never,
		{
			setWidget(_key: string, content: unknown) {
				widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
			},
			requestRender() {},
		} as never,
	);
	disposers.push(dispose);
	return {
		lines: (width = 100) => (widget?.render(width) ?? []).map((line) => stripVTControlCharacters(line).trimEnd()),
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
