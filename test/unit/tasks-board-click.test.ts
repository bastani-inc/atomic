import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	launchedTaskViewSource,
	ownerTaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	TaskAgentTranscriptPage,
	themedChatHostStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import {
	getEditorTheme,
	getSettingsListTheme,
	initTheme,
	theme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { showTaskInspector, type TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { SessionListOverlay } from "../../packages/intercom/ui/session-list.ts";
import { FakeOwnerTaskStore } from "../helpers/fake-owner-task-store.js";
import { sleep } from "../helpers/runtime.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const LEFT = "\x1b[D";
const ESC = "\x1b";
const SPACE = " ";

type MouseComponent = Component & {
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	paintedRowKey?(row: number): string | undefined;
	handleInput?(data: string): boolean | undefined;
	dispose?(): void;
};

let previousKeys: ReturnType<typeof getKeybindings>;

beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(previousKeys);
});

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function mouse(y: number, extra: Partial<TuiMouseEvent> = {}, width = 100, height = 24): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 6,
		y,
		screenX: 6,
		screenY: 10 + y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
		...extra,
	};
}

class OutputFakeStore extends FakeOwnerTaskStore {
	readonly outputs = new Map<string, string>();
	constructor(records: TaskRecord[]) {
		super(records);
		const supervisor = this.supervisor as unknown as {
			readTaskOutput: (lease: { readonly fakeTaskId: string }) => Promise<unknown>;
		};
		supervisor.readTaskOutput = async (lease) => {
			const text = this.outputs.get(lease.fakeTaskId);
			if (text === undefined) {
				return {
					ok: false,
					error: { code: "OutputUnavailable", message: `no output kept for ${lease.fakeTaskId}` },
				};
			}
			const bytes = Buffer.from(text, "utf8");
			return {
				ok: true,
				value: {
					chunks: [{ offsets: { start: "0", end: String(bytes.length) }, bytes }],
					omittedRanges: [],
				},
			};
		};
	}
	emit(): void {
		this.set(this.ownerTasks);
	}
}

function shellRecord(id: string, title: string, ordinal: number, outputBytes = "64"): TaskRecord {
	const base = taskRecord(id, "command");
	return {
		...base,
		title,
		launchOrdinal: ordinal,
		wasBackground: true,
		output: { ...base.output, byteCount: outputBytes },
	};
}

function agentTaskRecord(id: string, title: string, ordinal: number): TaskRecord {
	return {
		...taskRecord(id, "agent"),
		agentName: "worker",
		title,
		launchOrdinal: ordinal,
		wasBackground: true,
	};
}

test("/tasks shell rows render the bold accent Atomic logo ∀ cursor (and plain ∀ under NO_COLOR)", () => {
	const shell = shellRecord("shell-1", "npm test", 1);
	const selectedRaw = renderBoardRow({ id: shell.ref.taskId, kind: "task", task: shell }, true, 80);
	const unselectedRaw = renderBoardRow({ id: shell.ref.taskId, kind: "task", task: shell }, false, 80);
	assert.ok(selectedRaw.startsWith(theme.fg("accent", theme.bold("∀ "))), selectedRaw);
	assert.match(stripVTControlCharacters(selectedRaw), /^∀ ⧗ shell +npm test/);
	assert.match(stripVTControlCharacters(unselectedRaw), /^ {2}⧗ shell +npm test/);

	const prevNoColor = process.env.NO_COLOR;
	process.env.NO_COLOR = "1";
	try {
		const noColor = renderBoardRow({ id: shell.ref.taskId, kind: "task", task: shell }, true, 80);
		assert.doesNotMatch(noColor, /\x1b\[/);
		assert.match(noColor, /^∀ ⧗ shell +npm test/);
	} finally {
		if (prevNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prevNoColor;
	}

	assert.equal(stripVTControlCharacters(getSettingsListTheme().cursor), "∀ ");
	const overlay = new SessionListOverlay(
		theme,
		new KeybindingsManager(),
		{ id: "self", name: "planner", cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
		[{ id: "peer", name: "worker", cwd: "/repo", model: "m", pid: 2, startedAt: 1, lastActivity: 1 }],
		() => {},
	);
	assert.ok(
		plain(overlay.render(80)).some((line) => line.includes("∀ worker")),
		plain(overlay.render(80)).join("\n"),
	);
});

test("clicking a shell row in a shell-only /tasks list opens its shell viewer and ← returns with it selected", async () => {
	const shellA = shellRecord("shell-a", "echo alpha", 1);
	const shellB = shellRecord("shell-b", "echo beta", 2);
	const store = new OutputFakeStore([shellA, shellB]);
	store.outputs.set(shellA.ref.taskId, "alpha output line 1\nalpha output line 2\n");
	store.outputs.set(shellB.ref.taskId, "beta output line 1\n");

	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {},
	);
	try {
		const board = plain(inspector.renderPicker(100, 12));
		const alphaRow = board.findIndex((line) => line.includes("echo alpha"));
		const betaRow = board.findIndex((line) => line.includes("echo beta"));
		assert.notEqual(alphaRow, -1, board.join("\n"));
		assert.notEqual(betaRow, -1, board.join("\n"));
		assert.ok(board[betaRow]?.startsWith(" ∀ ⧗ shell"), `newest shell starts selected:\n${board.join("\n")}`);
		assert.equal(inspector.paintedRowKey(alphaRow), `board:${shellA.ref.taskId}`);
		assert.equal(inspector.paintedRowKey(betaRow), `board:${shellB.ref.taskId}`);
		assert.equal(inspector.paintedRowKey(0), undefined, "top edge is not a row");
		assert.equal(inspector.paintedRowKey(1), undefined, "header is not a row");
		assert.equal(inspector.paintedRowKey(board.length - 1), undefined, "hint line is not a row");

		assert.equal(inspector.handleMouse(mouse(0)), undefined, "header/edge click does nothing");
		assert.equal(inspector.handleMouse(mouse(alphaRow, { type: "press" })), undefined, "press stays with selection");
		assert.equal(inspector.handleMouse(mouse(alphaRow, { clickCount: 2 })), undefined, "double-click does not open");
		assert.equal(inspector.handleMouse(mouse(alphaRow, { button: "right" })), undefined, "right-click does not open");
		assert.equal(inspector.handleMouse(mouse(alphaRow, { shift: true })), undefined, "modified click does not open");
		assert.equal(inspector.fullscreen, false);

		const result = inspector.handleMouse(mouse(alphaRow));
		assert.equal(result?.handled, true);
		assert.equal(inspector.fullscreen, true, "clicking the non-selected shell row opened its fullscreen viewer");
		await flush();

		const viewer = plain(inspector.renderViewport(100, 24)).join("\n");
		assert.match(viewer, /echo alpha/);
		assert.match(viewer, /Command:\s+echo alpha/);
		assert.match(viewer, /alpha output line 1/);
		assert.match(viewer, /alpha output line 2/);
		assert.doesNotMatch(viewer, /beta output/);

		inspector.handleInput(LEFT);
		assert.equal(inspector.fullscreen, false);
		const returned = plain(inspector.renderPicker(100, 12));
		assert.ok(
			returned.some((line) => line.startsWith(" ∀ ⧗ shell") && line.includes("echo alpha")),
			`returning to /tasks keeps the clicked shell selected:\n${returned.join("\n")}`,
		);
	} finally {
		inspector.dispose();
	}
});

test("clicking a row works across subagents, extension items, open peek cards, active filters, and short viewports", async () => {
	const shell = shellRecord("shell-1", "npm run build", 1);
	const agent = agentTaskRecord("agent-1", "audit routing", 2);
	const store = new OutputFakeStore([shell, agent]);
	store.outputs.set(shell.ref.taskId, "build complete\n");

	const openedAgents: TaskId[] = [];
	const openedItems: string[] = [];
	let closed = 0;
	const item: AgentPanelItem = {
		id: "ext:job-1",
		kind: "agent",
		state: "running",
		name: "deploy",
		task: "rollout canary",
	};
	const boardSource: TaskBoardSource = {
		items: () => [item],
		subscribe: () => () => {},
		open: (id) => {
			openedItems.push(id);
			return true;
		},
	};

	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {
			closed++;
		},
	);
	inspector.setBoardSource(boardSource);
	inspector.setAgentView((id) => openedAgents.push(id));

	try {
		inspector.handleInput(SPACE);
		const withPeek = plain(inspector.renderPicker(100, 12));
		const peekBorderRow = withPeek.findIndex((line) => line.includes("╭─"));
		assert.notEqual(peekBorderRow, -1, withPeek.join("\n"));
		assert.equal(inspector.paintedRowKey(peekBorderRow), undefined, "peek card lines have no row key");
		assert.equal(inspector.handleMouse(mouse(peekBorderRow)), undefined, "clicking peek card does not open a row");

		const shellRow = withPeek.findIndex((line) => line.includes("npm run build"));
		assert.notEqual(shellRow, -1, withPeek.join("\n"));
		assert.equal(inspector.handleMouse(mouse(shellRow))?.handled, true);
		assert.equal(inspector.fullscreen, true);
		await flush();
		assert.match(plain(inspector.renderViewport(100, 24)).join("\n"), /build complete/);
		inspector.handleInput(LEFT);

		inspector.handleInput("/");
		for (const ch of "deploy") inspector.handleInput(ch);
		const filtered = plain(inspector.renderPicker(100, 12));
		const itemRow = filtered.findIndex((line) => line.includes("rollout canary"));
		assert.notEqual(itemRow, -1, filtered.join("\n"));
		assert.equal(inspector.handleMouse(mouse(itemRow))?.handled, true);
		assert.deepEqual(openedItems, ["ext:job-1"]);
		assert.equal(closed, 1);
	} finally {
		inspector.dispose();
	}

	const agentInspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {
			closed++;
		},
	);
	agentInspector.setAgentView((id) => openedAgents.push(id));
	try {
		const shortBoard = plain(agentInspector.renderViewport(100, 2));
		const agentRow = shortBoard.findIndex((line) => line.includes("audit routing"));
		assert.notEqual(agentRow, -1, shortBoard.join("\n"));
		assert.equal(agentInspector.paintedRowKey(agentRow), `board:${agent.ref.taskId}`);
		assert.equal(agentInspector.handleMouse(mouse(agentRow))?.handled, true);
		assert.deepEqual(openedAgents, [agent.ref.taskId]);
	} finally {
		agentInspector.dispose();
	}
});

test("clicking a /tasks row opens the row that was painted there even if a newer task arrives before the next paint", async () => {
	const shellA = shellRecord("shell-a", "first shell", 1);
	const shellB = shellRecord("shell-b", "second shell", 2);
	const store = new OutputFakeStore([shellA]);
	store.outputs.set(shellA.ref.taskId, "output-from-first\n");
	store.outputs.set(shellB.ref.taskId, "output-from-second\n");

	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {},
	);
	try {
		const painted = plain(inspector.renderPicker(100, 12));
		const rowOfA = painted.findIndex((line) => line.includes("first shell"));
		assert.notEqual(rowOfA, -1, painted.join("\n"));

		// Before the next paint, shellB lands at the top of Working (displacing shellA downward).
		store.set([shellA, shellB]);
		assert.equal(inspector.handleMouse(mouse(rowOfA))?.handled, true);
		assert.equal(inspector.fullscreen, true);
		await flush();
		const viewer = plain(inspector.renderViewport(100, 24)).join("\n");
		assert.match(viewer, /output-from-first/, "opens the painted row, not the newly shifted one");
		assert.doesNotMatch(viewer, /output-from-second/);
	} finally {
		inspector.dispose();
	}

	// If the painted row was evicted before the click, nothing else is opened.
	const evictedStore = new OutputFakeStore([shellA]);
	const evictedInspector = new TaskInspector(
		ownerTaskViewSource(evictedStore),
		() => {},
		() => {},
	);
	try {
		const painted = plain(evictedInspector.renderPicker(100, 12));
		const rowOfA = painted.findIndex((line) => line.includes("first shell"));
		evictedStore.set([shellB]);
		assert.equal(evictedInspector.handleMouse(mouse(rowOfA))?.handled, true);
		assert.equal(evictedInspector.fullscreen, false, "evicted row click must not open replacement row");
	} finally {
		evictedInspector.dispose();
	}
});

test("help overlay and stdin sheet clear board click targets", () => {
	const shell = shellRecord("shell-1", "cat -", 1);
	const store = new OutputFakeStore([shell]);
	const inspector = new TaskInspector(
		ownerTaskViewSource(store),
		() => {},
		() => {},
	);
	try {
		const board = plain(inspector.renderPicker(100, 12));
		const shellRow = board.findIndex((line) => line.includes("cat -"));
		assert.notEqual(shellRow, -1);

		inspector.handleInput("?");
		inspector.renderPicker(100, 12);
		assert.equal(inspector.paintedRowKey(shellRow), undefined);
		assert.equal(inspector.handleMouse(mouse(shellRow)), undefined);
		inspector.handleInput(ESC);
		inspector.renderPicker(100, 12);
		assert.equal(inspector.paintedRowKey(shellRow), `board:${shell.ref.taskId}`);
	} finally {
		inspector.dispose();
	}
});

test("showTaskInspector mounts inline board clicking and transitions cleanly into fullscreen shell viewer and back", async () => {
	const shell = shellRecord("shell-only", "printf hi", 1);
	const store = new OutputFakeStore([shell]);
	store.outputs.set(shell.ref.taskId, "hi from shell\n");

	const mounts: Array<{
		readonly overlay: boolean;
		readonly component: MouseComponent;
		readonly finish: () => void;
	}> = [];
	const ui: TaskInspectorUi = {
		custom: <T>(
			factory: Parameters<TaskInspectorUi["custom"]>[0],
			options?: Parameters<TaskInspectorUi["custom"]>[1],
		): Promise<T> =>
			new Promise<T>((resolve) => {
				const tui = {
					terminal: { rows: 24, columns: 100 },
					requestRender: () => {},
				} as unknown as TUI;
				const component = factory(tui, theme, new KeybindingsManager(), (result) =>
					resolve(result as T),
				) as MouseComponent;
				mounts.push({ overlay: options?.overlay === true, component, finish: () => resolve(undefined as T) });
			}),
	};

	const run = showTaskInspector(ui, store as never);
	await flush();
	assert.equal(mounts.length, 1);
	assert.equal(mounts[0]?.overlay, false, "board mounts inline");

	const boardLines = plain(mounts[0]!.component.render(100));
	const shellRow = boardLines.findIndex((line) => line.includes("printf hi"));
	assert.notEqual(shellRow, -1, boardLines.join("\n"));
	assert.equal(mounts[0]!.component.paintedRowKey?.(shellRow), `board:${shell.ref.taskId}`);

	assert.equal(mounts[0]!.component.handleMouse?.(mouse(shellRow))?.handled, true);
	// While the inline mount is unwinding into fullscreen, further clicks on the stale inline mount are fenced off.
	assert.equal(mounts[0]!.component.handleMouse?.(mouse(shellRow)), undefined);
	assert.equal(mounts[0]!.component.paintedRowKey?.(shellRow), undefined);

	await flush();
	assert.equal(mounts.length, 2, "clicking a shell row remounts as fullscreen shell viewer");
	assert.equal(mounts[1]?.overlay, true);

	const viewer = plain(mounts[1]!.component.render(100)).join("\n");
	assert.match(viewer, /printf hi/);
	assert.match(viewer, /hi from shell/);

	// Raw SGR mouse press/release on the fullscreen shell viewer does not disarm a two-press stop confirmation.
	mounts[1]!.component.handleInput?.("x");
	assert.match(plain(mounts[1]!.component.render(100)).join("\n"), /Press x again/);
	mounts[1]!.component.handleInput?.("\x1b[<0;10;23M");
	mounts[1]!.component.handleInput?.("\x1b[<0;10;23m");
	assert.match(
		plain(mounts[1]!.component.render(100)).join("\n"),
		/Press x again/,
		"raw mouse press/release must not disarm stop confirmation",
	);

	mounts[1]!.component.handleInput?.(LEFT);
	await flush();
	assert.equal(mounts.length, 3, "← returns to inline /tasks board");
	assert.equal(mounts[2]?.overlay, false);
	const backBoard = plain(mounts[2]!.component.render(100));
	assert.ok(backBoard.some((line) => line.startsWith(" ∀ ⧗ shell") && line.includes("printf hi")));

	mounts[2]!.component.handleInput?.(ESC);
	await run;
});

test("isolated /tasks inline board forwards shell row clicks across RemoteComponent and survives tick repaints", async () => {
	const shell = shellRecord("shell-rpc", "echo isolated-ok", 1);
	const store = new OutputFakeStore([shell]);
	store.outputs.set(shell.ref.taskId, "isolated shell output\n");

	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const commands: InteractiveEngineCommand[] = [];
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			commands.push(command);
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;

	const hostMounts: Array<{ readonly overlay: boolean; readonly component: MouseComponent }> = [];
	const hostUi = {
		requestRender: () => {},
		setWidget: () => {},
		custom: (
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => MouseComponent,
			options?: { overlay?: boolean },
		) =>
			new Promise((resolve) => {
				const component = factory(
					{ terminal: { rows: 24, columns: 100 }, requestRender: () => {}, requestImmediateRender: () => {} },
					{},
					{},
					resolve,
				);
				hostMounts.push({ overlay: options?.overlay === true, component });
			}),
	} as unknown as ExtensionUIContext;
	new RemoteComponentController(runtime, hostUi, { isFullscreen: () => true, onRendererReplaced: () => () => {} });

	const run = showTaskInspector({ custom: (factory, options) => child.custom(factory, options) }, store as never);
	try {
		for (let attempt = 0; attempt < 100 && hostMounts.length === 0; attempt++) await sleep(5);
		assert.equal(hostMounts.length, 1);
		assert.equal(hostMounts[0]?.overlay, false);

		const inlineHost = hostMounts[0]!.component;
		inlineHost.render(100);
		await flush();
		const painted = plain(inlineHost.render(100));
		const shellRow = painted.findIndex((line) => line.includes("echo isolated-ok"));
		assert.notEqual(shellRow, -1, painted.join("\n"));
		assert.equal(inlineHost.paintedRowKey?.(shellRow), `board:${shell.ref.taskId}`);

		// Simulate a store tick (e.g. elapsed time update) that increments the engine frame without changing the row.
		store.emit();
		await flush();
		assert.equal(inlineHost.handleMouse?.(mouse(shellRow))?.handled, true);

		for (let attempt = 0; attempt < 100 && hostMounts.length < 2; attempt++) await sleep(5);
		assert.equal(hostMounts.length, 2, "isolated host remounted fullscreen shell output viewer on row click");
		assert.equal(hostMounts[1]?.overlay, true);

		const viewerHost = hostMounts[1]!.component;
		viewerHost.render(100);
		await flush();
		const viewerText = plain(viewerHost.render(100)).join("\n");
		assert.match(viewerText, /echo isolated-ok/);
		assert.match(viewerText, /isolated shell output/);
	} finally {
		child.dispose();
		await run;
	}
});

test("clicking a shell row in a subagent chat's own /tasks picker accounts for the spacer gap above the picker", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("Parent worker");
		const parent = fixture.store.tasks[0]!;
		const childShell = shellRecord("child-shell-1", "echo from-child", 2);
		const childShellOwned: TaskRecord = {
			...childShell,
			parentTaskId: parent.ref.taskId,
			launchedBy: `session-${parent.ref.taskId}`,
		};
		const store = new OutputFakeStore([parent, childShellOwned]);
		store.outputs.set(childShellOwned.ref.taskId, "child shell output\n");

		const source = launchedTaskViewSource(ownerTaskViewSource(store), parent.ref.taskId);
		const env = taskTranscriptEnvironment();
		const host = new ChatSessionHost({
			style: themedChatHostStyle(),
			editorTheme: getEditorTheme(),
			keybindings: env.keybindings,
			getTaskSource: () => source,
		});
		const page = new TaskAgentTranscriptPage(
			ownerTaskViewSource(store),
			parent.ref.taskId,
			env,
			() => {},
			() => {},
		);
		try {
			assert.equal(host.openTasks(), true);
			const lines = plain(host.renderBody(100, 24));
			const shellRow = lines.findIndex((line) => line.includes("∀ ⧗ shell") && line.includes("echo from-child"));
			assert.notEqual(shellRow, -1, lines.join("\n"));
			assert.equal(host.bodyRowKey(shellRow), `board:${childShellOwned.ref.taskId}`);
			const pickerTop = lines.findIndex((line) => /^▔+$/.test(line));
			assert.ok(pickerTop > 1, lines.join("\n"));
			assert.equal(host.bodyRowKey(pickerTop - 1), undefined, "gap row above picker has no row key");

			assert.equal(host.handleBodyClick(mouse(shellRow))?.handled, true);
			assert.equal(host.taskInspectorFullscreen, true);
			await flush();
			const viewer = plain(host.renderBody(100, 24)).join("\n");
			assert.match(viewer, /echo from-child/);
			assert.match(viewer, /child shell output/);
		} finally {
			host.dispose();
			page.dispose();
		}
	} finally {
		await fixture.dispose();
	}
});
