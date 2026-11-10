import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type {
	AttemptId,
	Generation,
	OperationId,
	OwnerId,
	TaskId,
	TaskRecord,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	launchedTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { ChatTranscriptComponent } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	TaskAgentTranscriptPage,
	TaskCommandOutputPage,
	type TaskTranscriptEnvironment,
} from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const ENTER = "\r";
const OWNER = "owner-1" as OwnerId;

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const plain = (rows: readonly string[]) => rows.map((row) => stripVTControlCharacters(row));
const text = (rows: readonly string[]) => plain(rows).join("\n");
const labelRows = (rows: readonly string[]) => plain(rows).filter((row) => row.includes("[subagent:"));

function record(id: string, kind: TaskRecord["kind"], parent?: string, extra: Partial<TaskRecord> = {}): TaskRecord {
	const taskId = id as TaskId;
	return {
		ref: { ownerId: OWNER, taskId, attemptId: "1" as AttemptId, generation: "1" as Generation },
		launchOperationId: `op-${id}` as OperationId,
		...(parent === undefined ? {} : { parentTaskId: parent as TaskId }),
		launchOrdinal: 0,
		kind,
		title: `title-${id}`,
		...(kind === "agent" ? { agentName: `agent-${id}` } : {}),
		execution: { kind: "running" },
		observation: { kind: "background", reason: "explicit" },
		wasBackground: true,
		attention: { kind: "none" },
		cleanup: { kind: "active" },
		output: { ownerId: OWNER, taskId, artifactId: `output-${id}`, byteCount: "0", omittedRanges: [] },
		...extra,
	};
}

/**
 * The parent's own shell `parent-shell`; its subagent `child` with the shell `child-shell` and the subagent
 * `grandchild` it launched; and that subagent's shell `grandchild-shell`.
 */
const tree = (): TaskRecord[] => [
	record("parent-shell", "command"),
	record("child", "agent"),
	record("child-shell", "command", "child"),
	record("grandchild", "agent", "child"),
	record("grandchild-shell", "command", "grandchild"),
];

type Listener = (event: AgentSessionEvent) => void;

function session(id: string, intercomTarget?: string): TaskTranscriptSource & { listeners: Set<Listener> } {
	const listeners = new Set<Listener>();
	return {
		listeners,
		getSessionId: () => `session-${id}`,
		getEntries: () => [],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		...(intercomTarget === undefined ? {} : { completionSource: { runId: "aabcf28b", intercomTarget } }),
	};
}

function treeSource(
	tasks: TaskRecord[] = tree(),
	sessions: ReadonlyMap<string, TaskTranscriptSource> = new Map(),
	overrides: Partial<TaskViewSource> = {},
): TaskViewSource {
	const listeners = new Set<() => void>();
	return {
		tasks,
		backgroundTasks: tasks,
		settlementOrder: new Map(),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		foregroundTask: async () => ({ ok: true, value: { kind: "foreground" } }),
		cancelTask: async () => ({ ok: true, value: undefined }),
		stdinAvailable: () => false,
		writeTaskInput: async () => ({ ok: true, value: { acceptedBytes: 0 } }),
		readTaskOutput: async (id) => ({ ok: true, value: { text: `output of ${id}`, omitted: false } }),
		taskDetailText: () => ({}),
		readTaskTranscript: (id) => ({
			ok: true,
			value: { messages: [{ role: "user", content: `transcript of ${id}`, timestamp: 1 }] },
		}),
		followTaskTranscript: (id) => {
			const followed = sessions.get(id);
			return followed === undefined ? undefined : { historyOnly: false, session: followed };
		},
		extensionStatuses: () => new Map(),
		watchExtensionStatuses: () => () => {},
		sendTaskMessage: async () => {},
		...overrides,
	};
}

function environment(overrides: Partial<TaskTranscriptEnvironment> = {}): TaskTranscriptEnvironment {
	return taskTranscriptEnvironment({ tui: makeTestTui(40), keybindings: getKeybindings(), ...overrides });
}

function subagentPage(
	source: TaskViewSource,
	taskId = "child",
	env: TaskTranscriptEnvironment = environment(),
	requestRender: () => void = () => {},
): TaskAgentTranscriptPage {
	return new TaskAgentTranscriptPage(source, taskId as TaskId, env, requestRender);
}

function select(component: { handleInput(data: string): boolean }, render: () => string[], pattern: RegExp): void {
	for (let attempt = 0; attempt < 10; attempt++) {
		const selected = plain(render()).find((row) => row.includes("│ › "));
		if (selected !== undefined && pattern.test(selected)) return;
		component.handleInput("\x1b[B");
	}
	assert.fail(`no task matches ${pattern}`);
}

async function type(page: { handleInput(data: string): boolean }, value: string): Promise<void> {
	for (const char of value) page.handleInput(char);
	await flush();
}

/** A chat host whose working status takes two rows, of which a short viewport keeps the last. */
class TwoRowWorkingChat extends ChatSessionHost {
	override renderPendingMessages(): string[] {
		return ["PENDING"];
	}
	override renderWorkingStatus(): string[] {
		return ["WORKING-1", "WORKING-2"];
	}
	override renderFooter(): string[] {
		return ["FOOTER"];
	}
}

/** A chat host whose status rows are named, so their order and budget are visible. */
class NamedRowsChat extends ChatSessionHost {
	override renderPendingMessages(): string[] {
		return ["PENDING"];
	}
	override renderWorkingStatus(): string[] {
		return ["WORKING"];
	}
	override renderUsage(): string[] {
		return ["USAGE"];
	}
	override renderFooter(): string[] {
		return ["FOOTER"];
	}
}

let previousKeybindings: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("a subagent's chat label (#4640)", () => {
	test("names the subagent's session on its editor's top rule, above the prompt (#4640)", async () => {
		const sessions = new Map([["child", session("child", "subagent-worker-aabcf28b-1")]]);
		const page = subagentPage(treeSource(tree(), sessions));
		await page.load();
		const rows = plain(page.render(80, 12));
		const top = rows.findIndex((row) => row.includes("[subagent:"));
		assert.equal(labelRows(rows).length, 1);
		assert.match(rows[top] ?? "", /^\[subagent: subagent-worker-aabcf28b-1\] ─+$/);
		assert.equal(visibleWidth(rows[top] ?? ""), 80);
		assert.ok(rows[top + 1]?.startsWith("❯"), "the prompt stays on the editor's content line");
		page.dispose();
	});

	test("falls back to the agent name, and shows no label without one (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		assert.deepEqual(
			labelRows(page.render(80, 12)).map((row) => row.replace(/─+$/, "")),
			["[subagent: agent-child] "],
		);
		page.dispose();
		const unnamed = subagentPage(treeSource([record("child", "agent", undefined, { agentName: undefined })]));
		await unnamed.load();
		assert.deepEqual(labelRows(unnamed.render(80, 12)), []);
		unnamed.dispose();
	});

	test("is left off below 40 columns and truncated with an ellipsis when the name does not fit (#4640)", async () => {
		const name = `subagent-${"reviewer".repeat(8)}-1`;
		const page = subagentPage(treeSource(tree(), new Map([["child", session("child", name)]])));
		await page.load();
		assert.deepEqual(labelRows(page.render(39, 12)), []);
		const [narrow] = labelRows(page.render(40, 12));
		assert.match(narrow ?? "", /^\[subagent: subagent-reviewer.*…\] ─*$/);
		assert.equal(visibleWidth(narrow ?? ""), 40);
		page.dispose();
	});

	test("stays on a scrolled draft's `↑ N more` top rule, once (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		page.chat.setInputText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
		const rows = plain(page.render(80, 30));
		const labeled = labelRows(rows);
		assert.equal(labeled.length, 1);
		assert.match(labeled[0] ?? "", /^\[subagent: agent-child\] ─+ ↑ \d+ more ─+$/);
		assert.equal(visibleWidth(labeled[0] ?? ""), 80);
		page.dispose();
	});
});

describe("a subagent's chat box rows (#4640)", () => {
	function namedRowsPage(): TaskAgentTranscriptPage {
		return subagentPage(treeSource(), "child", environment({ createChat: (opts) => new NamedRowsChat(opts) }));
	}

	test("renders the transcript, pending messages, working line, usage, editor and footer in that order (#4640)", async () => {
		const page = namedRowsPage();
		await page.load();
		const rows = plain(page.render(80, 20));
		assert.equal(rows.length, 20);
		const at = (name: string) => rows.indexOf(name);
		const transcript = rows.findIndex((row) => row.includes("transcript of child"));
		const label = rows.findIndex((row) => row.includes("[subagent: agent-child]"));
		assert.ok(transcript >= 0 && transcript < at("PENDING"));
		assert.deepEqual(
			[at("PENDING"), at("WORKING"), at("USAGE"), label, at("FOOTER")],
			[13, 14, 15, 16, 19],
			"pending, working and usage sit right above the editor, and the footer is the last row",
		);
		assert.ok(rows[17]?.startsWith("❯"));
		page.dispose();
	});

	test("keeps the editor, then the footer, then the status rows when the viewport shrinks (#4640)", async () => {
		const page = namedRowsPage();
		await page.load();
		const kept = (rows: number) =>
			plain(page.render(80, rows)).map((row) =>
				row.includes("[subagent:") ? "LABEL" : row.startsWith("❯") ? "PROMPT" : row,
			);
		assert.deepEqual(kept(1), ["LABEL"]);
		assert.deepEqual(kept(0), ["LABEL"]);
		assert.deepEqual(kept(3), ["LABEL", "PROMPT", "─".repeat(80)]);
		assert.deepEqual(kept(4), ["LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		assert.deepEqual(kept(5), ["PENDING", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		assert.deepEqual(kept(6), ["PENDING", "WORKING", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		assert.deepEqual(kept(7), ["PENDING", "WORKING", "USAGE", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		const roomy = kept(8);
		assert.equal(roomy.length, 8, "the transcript takes the one row left");
		assert.deepEqual(roomy.slice(1), ["PENDING", "WORKING", "USAGE", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		page.dispose();
	});

	test("keeps the last row of a working status that does not fit (#4640)", async () => {
		const page = subagentPage(
			treeSource(),
			"child",
			environment({ createChat: (opts) => new TwoRowWorkingChat(opts) }),
		);
		await page.load();
		assert.deepEqual(plain(page.render(80, 6)).slice(0, 2), ["PENDING", "WORKING-2"]);
		assert.deepEqual(plain(page.render(80, 7)).slice(0, 3), ["PENDING", "WORKING-1", "WORKING-2"]);
		page.dispose();
	});

	test("counts only the subagent's own running tasks in its footer (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		const rows = plain(page.render(80, 12));
		assert.equal(rows.at(-1), "Tasks  2 background tasks running · /tasks");
		page.dispose();
		const grandchild = subagentPage(treeSource(), "grandchild");
		await grandchild.load();
		assert.equal(plain(grandchild.render(80, 12)).at(-1), "Tasks  1 shell running · /tasks");
		grandchild.dispose();
	});
});

test("repaints its footer as its parent's tasks change without rebuilding its transcript (#4640)", async () => {
	const tasks = tree();
	const listeners = new Set<() => void>();
	const root = treeSource(tasks, new Map(), {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const page = subagentPage(root);
	await page.load();
	page.render(80, 12);
	const rebuilds = vi.spyOn(ChatTranscriptComponent.prototype, "invalidate");
	try {
		const changes = 5;
		for (let change = 0; change < changes; change++) {
			tasks.push(record(`child-late-${change}`, "command", "child"));
			for (const listener of listeners) listener();
			page.render(80, 12);
		}
		assert.equal(rebuilds.mock.calls.length, 0, "a task change rebuilds none of the transcript's rows");
		assert.equal(plain(page.render(80, 12)).at(-1), "Tasks  7 background tasks running · /tasks");
	} finally {
		rebuilds.mockRestore();
		page.dispose();
	}
});

describe("/tasks in a subagent's chat (#4640)", () => {
	test("lists the subagent's own shells and the subagents it launched, not its parent's (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		assert.equal(page.handlesBack(), false);
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		assert.equal(page.handlesBack(), true);
		assert.equal(
			page.chat.statusText(),
			"",
			"the subagent's view does not report that task inspection is unavailable",
		);
		const list = text(page.render(80, 24));
		assert.match(list, /title-child-shell/);
		assert.match(list, /title-grandchild(?!-)/);
		assert.doesNotMatch(list, /title-parent-shell|title-grandchild-shell/);
		assert.equal(page.chat.inputText(), "", "/tasks is not left in the composer or sent to the subagent");
		page.dispose();
	});

	test("the subagent's open list takes the chat box's rows, with its footer under it (#4640)", async () => {
		let renders = 0;
		const page = subagentPage(treeSource(), "child", environment(), () => {
			renders++;
		});
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		const rows = plain(page.render(80, 24));
		assert.equal(rows.length, 24);
		assert.deepEqual(labelRows(rows), [], "the composer is hidden while the list is open");
		assert.equal(rows.at(-1), "Tasks  2 background tasks running · /tasks");
		assert.match(rows.at(-2) ?? "", /Esc back/);
		const [only, ...rest] = plain(page.render(80, 1));
		assert.deepEqual(rest, []);
		assert.notEqual(only, "Tasks  2 background tasks running · /tasks", "one row goes to the list, not the footer");
		const before = renders;
		page.handleInput("\x1b[B");
		assert.ok(renders > before, "a key on the list repaints");
		page.dispose();
	});

	test("/tasks with a task id selects that task of the subagent, whose own page has no chat footer (#4640)", async () => {
		for (const [command, selected] of [
			["/tasks", "title-grandchild"],
			["/tasks child-shell", "title-child-shell"],
			["/tasks  child-shell", "title-child-shell"],
		] as const) {
			const page = subagentPage(treeSource());
			await page.load();
			await type(page, command);
			page.handleInput(ENTER);
			await flush();
			const list = plain(page.render(80, 24));
			assert.match(list.find((row) => row.includes("│ › ")) ?? "", new RegExp(`│ › ${selected} `));
			page.handleInput(ENTER);
			await flush();
			const detail = plain(page.render(80, 24));
			assert.match(detail.join("\n"), new RegExp(`› ${selected}\\b`));
			assert.doesNotMatch(detail.at(-1) ?? "", /^Tasks |Stryker/, "a task's own page has no chat footer");
			page.dispose();
		}
	});

	test("Escape on the subagent's list returns to its chat, and Left or Escape on a task returns to the list (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		page.handleInput(ENTER);
		await flush();
		assert.match(text(page.render(80, 24)), /title-child-shell|title-grandchild/);
		assert.doesNotMatch(text(page.render(80, 24)), /Background tasks/, "a task's detail page replaced the list");
		page.handleInput(LEFT);
		assert.match(text(page.render(80, 24)), /Background tasks/);
		page.handleInput(ENTER);
		page.handleInput(ESCAPE);
		assert.match(text(page.render(80, 24)), /Background tasks/);
		page.handleInput(ESCAPE);
		assert.equal(page.handlesBack(), false);
		const chat = text(page.render(80, 24));
		assert.doesNotMatch(chat, /Background tasks/);
		assert.match(chat, /\[subagent: agent-child\]/);
		page.dispose();
	});

	test("in a nested subagent lists that subagent's own tasks, and back returns to it (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		select(page, () => page.render(80, 24), /title-grandchild(?!-)/);
		page.handleInput(ENTER);
		await flush();
		page.handleInput(ENTER);
		await flush();
		assert.match(text(page.render(80, 24)), /Transcript · agent-grandchild[\s\S]*transcript of grandchild/);
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		const nested = text(page.render(80, 24));
		assert.match(nested, /title-grandchild-shell/);
		assert.doesNotMatch(nested, /title-child-shell|title-parent-shell/);
		page.handleInput(ESCAPE);
		const grandchildChat = text(page.render(80, 24));
		assert.match(grandchildChat, /\[subagent: agent-grandchild\]/);
		assert.match(grandchildChat, /transcript of grandchild/);
		assert.equal(page.handlesBack(), true, "the child's own task pages are still open");
		page.dispose();
	});

	test("keeps the subagent's list open while its session publishes events (#4640)", async () => {
		const live = session("child", "subagent-worker-aabcf28b-1");
		const page = subagentPage(treeSource(tree(), new Map([["child", live]])));
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		assert.equal(live.listeners.size, 1);
		for (const listener of live.listeners) listener({ type: "agent_start" } as AgentSessionEvent);
		assert.equal(page.handlesBack(), true);
		assert.match(text(page.render(80, 24)), /title-child-shell/);
		page.dispose();
	});

	test("keeps Ctrl+O and the host's thinking key while the subagent's list is open (#4640)", async () => {
		let expanded = false;
		const page = subagentPage(
			treeSource(),
			"child",
			environment({
				getToolsExpanded: () => expanded,
				setToolsExpanded: (value) => {
					expanded = value;
				},
			}),
		);
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		assert.equal(page.handleInput("\x0f"), true);
		assert.equal(expanded, true);
		assert.equal(page.handleInput("\x14"), false);
		assert.equal(page.handlesBack(), true);
		page.dispose();
	});

	test("the task pages leave a subagent's chat only once its own list is closed (#4640)", async () => {
		const root = treeSource();
		let environmentForInspector: TaskTranscriptEnvironment | undefined;
		const inspector = new TaskInspector(
			root,
			() => {},
			() => {},
			undefined,
			() => environmentForInspector,
		);
		environmentForInspector = environment();
		const all = text(inspector.renderViewport(80, 24));
		for (const id of ["parent-shell", "child", "child-shell", "grandchild", "grandchild-shell"])
			assert.match(all, new RegExp(`title-${id}\\b`), "the main session's /tasks lists every task");
		select(inspector, () => inspector.renderViewport(80, 24), /title-child(?!-)/);
		inspector.handleInput(ENTER);
		await flush();
		inspector.handleInput(ENTER);
		await flush();
		assert.match(text(inspector.renderViewport(80, 24)), /Transcript · agent-child(?!-)/);
		for (const back of [LEFT, ESCAPE]) {
			await type(inspector, "/tasks");
			inspector.handleInput(ENTER);
			await flush();
			assert.match(text(inspector.renderViewport(80, 24)), /Background tasks/);
			inspector.handleInput(back);
			const chat = text(inspector.renderViewport(80, 24));
			assert.match(chat, /Transcript · agent-child(?!-)/, "the key closed the subagent's list, not its chat");
			assert.match(chat, /\[subagent: agent-child\]/);
			assert.doesNotMatch(chat, /Background tasks/);
		}
		inspector.handleInput(ESCAPE);
		assert.doesNotMatch(text(inspector.renderViewport(80, 24)), /Transcript ·/);
		inspector.dispose();
	});

	test("shell output pages never take back keys (#4640)", () => {
		const page = new TaskCommandOutputPage(
			treeSource(),
			"child-shell" as TaskId,
			() => 0n,
			undefined,
			() => {},
		);
		assert.equal(page.handlesBack(), false);
		page.dispose();
	});
});

describe("a subagent's task view (#4640)", () => {
	test("shows the tasks the subagent launched, read from its parent's view (#4640)", async () => {
		const root = treeSource();
		const child = launchedTaskViewSource(root, "child" as TaskId);
		const ids = (tasks: readonly TaskRecord[]) => tasks.map((task) => task.ref.taskId);
		assert.deepEqual(ids(child.tasks), ["child-shell", "grandchild"]);
		assert.deepEqual(ids(child.backgroundTasks), ["child-shell", "grandchild"]);
		assert.equal(child.settlementOrder, root.settlementOrder);
		const page = await child.readTaskOutput("child-shell" as TaskId, { start: "0", maximumBytes: 10 });
		assert.deepEqual(page, { ok: true, value: { text: "output of child-shell", omitted: false } });
		assert.equal(launchedTaskViewSource(root, "child" as TaskId), child, "one view per task keeps an open list");
		const grandchild = launchedTaskViewSource(child, "grandchild" as TaskId);
		assert.equal(grandchild, launchedTaskViewSource(root, "grandchild" as TaskId));
		assert.deepEqual(ids(grandchild.tasks), ["grandchild-shell"]);
		assert.notEqual(launchedTaskViewSource(treeSource(), "child" as TaskId), child);
	});

	test("filters background tasks and the live task list separately, as they change (#4640)", () => {
		const tasks = tree();
		const background = tasks.filter((task) => task.ref.taskId !== "child-shell");
		const root = treeSource(tasks, new Map(), { backgroundTasks: background });
		const child = launchedTaskViewSource(root, "child" as TaskId);
		assert.deepEqual(
			child.backgroundTasks.map((task) => task.ref.taskId),
			["grandchild"],
		);
		tasks.push(record("child-late", "command", "child"));
		assert.deepEqual(
			child.tasks.map((task) => task.ref.taskId),
			["child-shell", "grandchild", "child-late"],
		);
	});

	test("forwards every task action to its parent's view (#4640)", async () => {
		const calls: string[] = [];
		const note =
			<T>(name: string, value: T) =>
			(...args: readonly unknown[]): T => {
				calls.push(`${name}:${args.map(String).join(",")}`);
				return value;
			};
		const root = treeSource(tree(), new Map(), {
			recentActivity: note("recentActivity", []),
			activityOmitted: note("activityOmitted", true),
			subscribe: note("subscribe", () => {}),
			foregroundTask: note("foregroundTask", Promise.resolve({ ok: true as const, value: { kind: "fg" } })),
			cancelTask: note("cancelTask", Promise.resolve({ ok: true as const, value: undefined })),
			stdinAvailable: note("stdinAvailable", true),
			writeTaskInput: note("writeTaskInput", Promise.resolve({ ok: true as const, value: { acceptedBytes: 3 } })),
			taskDetailText: note("taskDetailText", { prompt: "p" }),
			readTaskTranscript: note("readTaskTranscript", { ok: false as const, error: { message: "gone" } }),
			followTaskTranscript: note("followTaskTranscript", { historyOnly: true }),
			extensionStatuses: note("extensionStatuses", new Map([["k", "v"]])),
			watchExtensionStatuses: note("watchExtensionStatuses", () => {}),
			sendTaskMessage: note("sendTaskMessage", Promise.resolve()),
		});
		const child = launchedTaskViewSource(root, "child" as TaskId);
		const id = "child-shell" as TaskId;
		assert.deepEqual(child.recentActivity(id), []);
		assert.equal(child.activityOmitted(id), true);
		const listener = () => {};
		assert.equal(typeof child.subscribe(listener), "function");
		assert.deepEqual(await child.foregroundTask(id), { ok: true, value: { kind: "fg" } });
		assert.deepEqual(await child.cancelTask(id), { ok: true, value: undefined });
		assert.equal(child.stdinAvailable(id), true);
		assert.deepEqual(await child.writeTaskInput(id, "abc"), { ok: true, value: { acceptedBytes: 3 } });
		assert.deepEqual(child.taskDetailText(id), { prompt: "p" });
		assert.deepEqual(child.readTaskTranscript(id, "cursor"), { ok: false, error: { message: "gone" } });
		assert.deepEqual(child.followTaskTranscript(id), { historyOnly: true });
		assert.deepEqual([...child.extensionStatuses(id)], [["k", "v"]]);
		assert.equal(typeof child.watchExtensionStatuses(id, listener), "function");
		await child.sendTaskMessage?.(id, "hello");
		assert.deepEqual(calls, [
			"recentActivity:child-shell",
			"activityOmitted:child-shell",
			`subscribe:${String(listener)}`,
			"foregroundTask:child-shell",
			"cancelTask:child-shell",
			"stdinAvailable:child-shell",
			"writeTaskInput:child-shell,abc",
			"taskDetailText:child-shell",
			"readTaskTranscript:child-shell,cursor",
			"followTaskTranscript:child-shell",
			"extensionStatuses:child-shell",
			`watchExtensionStatuses:child-shell,${String(listener)}`,
			"sendTaskMessage:child-shell,hello",
		]);
		const readOnly = launchedTaskViewSource(
			treeSource(tree(), new Map(), { sendTaskMessage: undefined }),
			"child" as TaskId,
		);
		assert.equal(
			readOnly.sendTaskMessage,
			undefined,
			"a parent that cannot message tasks keeps its subagents read-only",
		);
	});
});
