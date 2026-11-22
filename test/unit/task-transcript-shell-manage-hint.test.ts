import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, readHintSpans, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { launchedTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { openLocalAgentViewPort } from "../../packages/coding-agent/src/modes/interactive/agent-view/local-port.js";
import type {
	ChatRendererContext,
	ToolChatEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { runHintRoute } from "../../packages/coding-agent/src/modes/interactive/components/hint-routes.js";
import { keptTaskId } from "../../packages/coding-agent/src/modes/interactive/components/kept-task.js";
import { dismissedTasks } from "../../packages/coding-agent/src/modes/interactive/components/task-dismissal.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

const agent = "agent-1" as TaskId;
const savedKeys = getKeybindings();
const savedNoColor = process.env.NO_COLOR;
afterEach(() => {
	setKeybindings(savedKeys);
	if (savedNoColor === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = savedNoColor;
});
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function shell(id: string, command: string, parentTaskId?: TaskId): TaskRecord {
	return { ...taskRecord(id, "command"), title: command, ...(parentTaskId === undefined ? {} : { parentTaskId }) };
}

/** A turn that started each command with a short foreground wait, after which each kept running in the background. */
function transcript(
	commands: readonly { readonly callId: string; readonly command: string; readonly taskId: string }[],
) {
	return [
		{ role: "user" as const, content: "Build it", timestamp: 1 },
		{
			role: "assistant" as const,
			content: commands.map(({ callId, command }) => ({
				type: "toolCall" as const,
				id: callId,
				name: "bash",
				arguments: { command },
			})),
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude",
			usage,
			stopReason: "toolUse" as const,
			timestamp: 2,
		},
		...commands.map(({ callId, taskId }) => ({
			role: "toolResult" as const,
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text" as const, text: `(no output)\n\nCommand is still running (task ${taskId}).` }],
			details: { observation: { kind: "yielded", taskId, waitId: "wait", reason: "budget" } },
			isError: false,
			timestamp: 3,
		})),
	];
}

async function subagentChat(
	tasks: readonly TaskRecord[],
	commands: Parameters<typeof transcript>[0],
	createToolComponent?: (entry: ToolChatEntry, context?: ChatRendererContext) => Component,
	keptTasks?: "ownTasks" | "openWaited",
	readOnly?: string,
) {
	const source = transcriptOnlySource({
		tasks,
		ownerTasks: tasks,
		readTaskTranscript: () => ({ ok: true, value: { messages: transcript(commands) } }),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
		...(readOnly === undefined ? {} : { taskReadOnlyReason: () => readOnly }),
	});
	const env = taskTranscriptEnvironment({
		keybindings: new KeybindingsManager(),
		createChat: (options) => new ChatSessionHost(options),
		...(createToolComponent === undefined ? {} : { getChatRenderSettings: () => ({ createToolComponent }) }),
	});
	const page = new TaskAgentTranscriptPage(source, agent, env, () => {}, undefined, {
		...(keptTasks === undefined ? {} : { keptTasks }),
	});
	await page.load();
	return { page, source };
}

const plain = (rows: readonly string[]) => rows.map((row) => stripVTControlCharacters(readHintSpans(row).line));

test("a subagent's chat says /tasks manages a command it launched that keeps running, as the main chat does", async () => {
	initTheme("dark");
	const tasks = [
		{ ...taskRecord(agent), agentName: "worker" },
		shell("shell-own", "npm run build", agent),
		shell("shell-sibling", "npm run lint", "agent-2" as TaskId),
		shell("shell-main", "npm test"),
	];
	const { page } = await subagentChat(tasks, [
		{ callId: "call-own", command: "npm run build", taskId: "shell-own" },
		{ callId: "call-sibling", command: "npm run lint", taskId: "shell-sibling" },
		{ callId: "call-main", command: "npm test", taskId: "shell-main" },
	]);
	const raw = page.renderView(100, 30);
	const rows = plain(raw);
	const detailOf = (command: string) => rows[rows.findIndex((row) => row.includes(`Bash(${command})`)) + 1] ?? "";
	// Its own command is in its /tasks, as the main chat's own command is in the main chat's /tasks.
	assert.equal(detailOf("npm run build"), "   ⎿  Running in background · /tasks to manage", rows.join("\n"));
	// Typed into this chat, /tasks opens its own list; a click on the hint runs it through this chat's own route.
	const hint = raw[rows.findIndex((row) => row.includes("Bash(npm run build)")) + 1] ?? "";
	const [span] = readHintSpans(hint).spans;
	assert.ok(span?.action.kind === "command" && span.action.route !== undefined, hint);
	assert.equal(span.action.command, "/tasks");
	// Its /tasks does not list commands another subagent or the main chat launched.
	assert.equal(detailOf("npm run lint"), "   ⎿  Running in background", rows.join("\n"));
	assert.equal(detailOf("npm test"), "   ⎿  Running in background", rows.join("\n"));
	page.dispose();
});

test("a subagent's chat offers /tasks for a command only while its /tasks lists it", async () => {
	initTheme("dark");
	const tasks: TaskRecord[] = [
		{ ...taskRecord(agent), agentName: "worker" },
		shell("shell-own", "npm run build", agent),
	];
	const { page, source } = await subagentChat(tasks, [
		{ callId: "call-own", command: "npm run build", taskId: "shell-own" },
		{ callId: "call-late", command: "npm run e2e", taskId: "shell-late" },
	]);
	const detailOf = (command: string) => {
		const raw = page.renderView(100, 30);
		const rows = plain(raw);
		const index = rows.findIndex((row) => row.includes(`Bash(${command})`)) + 1;
		return { text: rows[index] ?? "", spans: readHintSpans(raw[index] ?? "").spans.length };
	};
	assert.deepEqual(detailOf("npm run build"), { text: "   ⎿  Running in background · /tasks to manage", spans: 1 });
	// The command is not listed yet when its result is drawn, then is.
	assert.deepEqual(detailOf("npm run e2e"), { text: "   ⎿  Running in background", spans: 0 });
	tasks.push(shell("shell-late", "npm run e2e", agent));
	assert.deepEqual(detailOf("npm run e2e"), { text: "   ⎿  Running in background · /tasks to manage", spans: 1 });
	// Dismissed from its /tasks, the command is no longer offered there.
	dismissedTasks(launchedTaskViewSource(source, agent)).add("shell-late" as TaskId);
	assert.deepEqual(detailOf("npm run e2e"), { text: "   ⎿  Running in background", spans: 0 });
	// Its /tasks no longer lists the first command once the session lets go of it.
	tasks.splice(1, 1);
	assert.deepEqual(detailOf("npm run build"), { text: "   ⎿  Running in background", spans: 0 });
	page.dispose();
});

test("a subagent's chat drawn by another process tells it which commands its /tasks lists", async () => {
	initTheme("dark");
	const contexts: (ChatRendererContext | undefined)[] = [];
	const tasks = [
		{ ...taskRecord(agent), agentName: "worker" },
		shell("shell-own", "npm run build", agent),
		shell("shell-sibling", "npm run lint", "agent-2" as TaskId),
	];
	const { page } = await subagentChat(
		tasks,
		[{ callId: "call-own", command: "npm run build", taskId: "shell-own" }],
		(_entry, context) => {
			contexts.push(context);
			return { render: () => [], invalidate: () => {} };
		},
	);
	page.renderView(100, 20);
	const keptTaskAction = contexts.at(-1)?.keptTaskAction;
	assert.ok(keptTaskAction);
	assert.equal(keptTaskAction("shell-own" as TaskId), "ownTasks");
	assert.equal(keptTaskAction("shell-sibling" as TaskId), undefined);
	page.dispose();
});

test("a subagent's chat on the screen whose /tasks is the main chat's offers its newest waited shell by its key", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const released: TaskRecord = {
		...taskRecord(agent),
		agentName: "worker",
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "call-wait", toolName: "bash" }] },
			},
		},
	};
	const older = { ...shell("shell-older", "npm run build", agent), launchOrdinal: 1 };
	const newest = { ...shell("shell-newest", "npm run e2e", agent), launchOrdinal: 2 };
	const commands = [
		{ callId: "call-older", command: "npm run build", taskId: "shell-older" },
		{ callId: "call-newest", command: "npm run e2e", taskId: "shell-newest" },
	];
	for (const noColor of [false, true]) {
		if (noColor) process.env.NO_COLOR = "1";
		else delete process.env.NO_COLOR;
		const { page } = await subagentChat([released, older, newest], commands, undefined, "openWaited");
		const raw = page.renderView(100, 40);
		const rows = plain(raw);
		const detailRow = (command: string) => rows.findIndex((row) => row.includes(`Bash(${command})`)) + 1;
		// The key opens the newest shell the released subagent waits on, so only that command's block names it.
		assert.equal(rows[detailRow("npm run e2e")], "   ⎿  Running in background · alt+w opens it", rows.join("\n"));
		// Its key runs from a click as the main chat's hints do: with colour; without it, the block is plain text.
		assert.deepEqual(
			readHintSpans(raw[detailRow("npm run e2e")] ?? "").spans.map((span) => span.action),
			noColor ? [] : [{ kind: "key", key: "alt+w" }],
		);
		assert.equal(rows[detailRow("npm run build")], "   ⎿  Running in background", rows.join("\n"));
		// Nothing here says /tasks: on this screen /tasks opens the main chat's list.
		assert.doesNotMatch(rows.join("\n"), /\/tasks to manage/);
		page.dispose();
	}
	delete process.env.NO_COLOR;
	// While the subagent runs, the key opens nothing, and the block names nothing.
	const { page } = await subagentChat(
		[{ ...taskRecord(agent), agentName: "worker" }, older, newest],
		commands,
		undefined,
		"openWaited",
	);
	const rows = plain(page.renderView(100, 40));
	assert.equal(rows[rows.findIndex((row) => row.includes("Bash(npm run e2e)")) + 1], "   ⎿  Running in background");
	page.dispose();
});

test("the screen that shows a subagent in place of the main chat offers its waited shell by its key, never /tasks", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const released: TaskRecord = {
		...taskRecord(agent),
		agentName: "worker",
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "w", toolName: "bash" }] },
			},
		},
	};
	const tasks = [released, shell("shell-own", "npm run build", agent)];
	const source = transcriptOnlySource({
		tasks,
		ownerTasks: tasks,
		readTaskTranscript: () => ({
			ok: true,
			value: { messages: transcript([{ callId: "call-own", command: "npm run build", taskId: "shell-own" }]) },
		}),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
	});
	const port = await openLocalAgentViewPort({
		source,
		taskId: agent,
		env: taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
		requestRender: () => {},
	});
	assert.ok(port);
	const release = port.retain();
	try {
		const rows = plain(port.transcript.renderSized(100, 40));
		const detail = rows[rows.findIndex((row) => row.includes("Bash(npm run build)")) + 1];
		assert.equal(detail, "   ⎿  Running in background · alt+w opens it", rows.join("\n"));
	} finally {
		release();
	}
});

test("only a finished shell launch that left its command running names a kept task", () => {
	const yielded = { details: { observation: { kind: "yielded", taskId: "shell-1" } } };
	assert.equal(keptTaskId({ toolName: "bash", args: { command: "make" }, result: yielded }), "shell-1");
	assert.equal(keptTaskId({ toolName: "powershell", args: { command: "make" }, result: yielded }), "shell-1");
	assert.equal(
		keptTaskId({ toolName: "bash", args: { command: "make" }, result: yielded, isPartial: true }),
		undefined,
	);
	assert.equal(keptTaskId({ toolName: "bash", args: { action: "wait", id: "shell-1" }, result: yielded }), undefined);
	const settled = { details: { observation: { kind: "settled", taskId: "shell-1" } } };
	assert.equal(keptTaskId({ toolName: "bash", args: { command: "make" }, result: settled }), undefined);
	// Another tool's result is never read.
	const unread = {
		get details(): never {
			throw new Error("read");
		},
	};
	assert.equal(keptTaskId({ toolName: "probe", args: {}, result: unread }), undefined);
});

test("a subagent's task page names /tasks only while typing it there opens the subagent's own list", async () => {
	initTheme("dark");
	const tasks = [
		{ ...taskRecord(agent), agentName: "worker" },
		shell("shell-own", "npm run build", agent),
		shell("shell-sibling", "npm run lint", "agent-2" as TaskId),
	];
	const commands = [{ callId: "call-own", command: "npm run build", taskId: "shell-own" }];
	const { page } = await subagentChat(tasks, commands);
	const rows = plain(page.renderView(100, 30));
	assert.equal(
		rows[rows.findIndex((row) => row.includes("Bash(npm run build)")) + 1],
		"   ⎿  Running in background · /tasks to manage",
	);
	for (const char of "/tasks") page.handleInput(char);
	page.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const list = plain(page.render(100, 24)).join("\n");
	assert.match(list, /npm run build/);
	assert.doesNotMatch(list, /npm run lint/);
	page.dispose();
	// A chat that no longer takes what is typed cannot run /tasks, so its blocks do not name it.
	const readOnly = await subagentChat(tasks, commands, undefined, undefined, "This subagent is no longer kept.");
	const readOnlyRows = plain(readOnly.page.renderView(100, 30));
	assert.equal(
		readOnlyRows[readOnlyRows.findIndex((row) => row.includes("Bash(npm run build)")) + 1],
		"   ⎿  Running in background",
	);
	readOnly.page.dispose();
});

test("a click on a subagent's /tasks hint opens its own list while its chat takes typing, and nothing after", async () => {
	initTheme("dark");
	const tasks = [
		{ ...taskRecord(agent), agentName: "worker" },
		shell("shell-own", "npm run build", agent),
		shell("shell-sibling", "npm run lint", "agent-2" as TaskId),
	];
	let readOnly: string | undefined;
	const source = transcriptOnlySource({
		tasks,
		ownerTasks: tasks,
		readTaskTranscript: () => ({
			ok: true,
			value: { messages: transcript([{ callId: "call-own", command: "npm run build", taskId: "shell-own" }]) },
		}),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
		taskReadOnlyReason: () => readOnly,
	});
	const env = taskTranscriptEnvironment({
		keybindings: new KeybindingsManager(),
		createChat: (options) => new ChatSessionHost(options),
	});
	const page = new TaskAgentTranscriptPage(source, agent, env, () => {});
	await page.load();
	const routeOf = (rows: readonly string[]) => {
		const row = rows[plain(rows).findIndex((line) => line.includes("Bash(npm run build)")) + 1] ?? "";
		const action = readHintSpans(row).spans[0]?.action;
		return action?.kind === "command" ? action.route : undefined;
	};
	const route = routeOf(page.renderView(100, 30));
	assert.ok(route);

	// The chat has stopped taking typing since the hint was drawn: a click on it opens nothing, here or in the main chat.
	readOnly = "This subagent is no longer kept.";
	assert.equal(runHintRoute(route, "/tasks"), false);
	assert.doesNotMatch(plain(page.render(100, 24)).join("\n"), /npm run lint|shell-own/);
	// Only /tasks runs there.
	readOnly = undefined;
	assert.equal(runHintRoute(route, "/model"), false);

	assert.equal(runHintRoute(route, "/tasks"), true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const list = plain(page.render(100, 24)).join("\n");
	assert.match(list, /npm run build/);
	assert.doesNotMatch(list, /npm run lint/);

	// A page that is gone leaves its route leading nowhere.
	page.dispose();
	assert.equal(runHintRoute(route, "/tasks"), false);
});

test("without colour a subagent's /tasks hint is text, as the main chat's hints are", async () => {
	initTheme("dark");
	process.env.NO_COLOR = "1";
	const tasks = [{ ...taskRecord(agent), agentName: "worker" }, shell("shell-own", "npm run build", agent)];
	const { page } = await subagentChat(tasks, [{ callId: "call-own", command: "npm run build", taskId: "shell-own" }]);
	const raw = page.renderView(100, 30);
	const row = plain(raw).findIndex((line) => line.includes("Bash(npm run build)")) + 1;
	assert.equal(plain(raw)[row], "   ⎿  Running in background · /tasks to manage");
	assert.deepEqual(readHintSpans(raw[row] ?? "").spans, []);
	page.dispose();
});

test("a subagent's chat reads its task list as often for many background commands as for one", async () => {
	initTheme("dark");
	/** Task-list reads in a frame that changed nothing, for a chat showing `receipts` background commands. */
	const readsPerFrame = async (receipts: number) => {
		const shells = Array.from({ length: receipts }, (_, index) => shell(`shell-${index}`, `job ${index}`, agent));
		const tasks = [{ ...taskRecord(agent), agentName: "worker" }, ...shells];
		const commands = shells.map((task, index) => ({
			callId: `call-${index}`,
			command: `job ${index}`,
			taskId: task.ref.taskId,
		}));
		const byId = new Map(tasks.map((task) => [task.ref.taskId, task]));
		let reads = 0;
		const source = transcriptOnlySource({
			readTaskTranscript: () => ({ ok: true, value: { messages: transcript(commands) } }),
			followTaskTranscript: () => undefined,
			sendTaskMessage: async () => {},
			taskReadOnlyReason: () => {
				reads++;
				return undefined;
			},
			// One task by its id, as a session's task store answers it.
			taskRecord: (id) => byId.get(id),
		});
		for (const name of ["tasks", "ownerTasks"])
			Object.defineProperty(source, name, {
				get: () => {
					reads++;
					return tasks;
				},
			});
		const page = new TaskAgentTranscriptPage(
			source,
			agent,
			taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
			() => {},
		);
		await page.load();
		page.renderView(100, 40);
		const rows = plain(page.renderView(100, 40));
		assert.ok(
			rows.some((row) => row.includes("/tasks to manage")),
			rows.join("\n"),
		);
		reads = 0;
		page.renderView(100, 40);
		const counted = reads;
		page.dispose();
		return counted;
	};
	assert.equal(await readsPerFrame(16), await readsPerFrame(1));
});

test("the main chat's Bash block draws a clickable route-less /tasks hint for a managed background command", () => {
	initTheme("dark");
	const managed = shell("shell-main", "npm test");
	const renderMain = () => {
		const env = taskTranscriptEnvironment({ keybindings: new KeybindingsManager() });
		const chat = env.createChat({
			style: env.style,
			keybindings: env.keybindings,
			editorTheme: env.editorTheme,
			getChatRenderSettings: () => ({
				getTaskRecord: (id) => (id === managed.ref.taskId ? managed : undefined),
			}),
		});
		chat.replaceMessages(
			transcript([
				{ callId: "call-main", command: "npm test", taskId: "shell-main" },
				{ callId: "call-gone", command: "npm run old", taskId: "shell-gone" },
			]),
		);
		const raw = chat.renderBody(100, 30);
		chat.dispose();
		return raw;
	};
	for (const noColor of [false, true]) {
		if (noColor) process.env.NO_COLOR = "1";
		else delete process.env.NO_COLOR;
		const raw = renderMain();
		const rows = plain(raw);
		const managedRow = rows.findIndex((row) => row.includes("Bash(npm test)")) + 1;
		const goneRow = rows.findIndex((row) => row.includes("Bash(npm run old)")) + 1;
		assert.equal(rows[managedRow], "   ⎿  Running in background · /tasks to manage", rows.join("\n"));
		assert.equal(rows[goneRow], "   ⎿  Running in background", rows.join("\n"));
		const { spans } = readHintSpans(raw[managedRow] ?? "");
		if (noColor) {
			assert.deepEqual(spans, []);
		} else {
			assert.equal(spans.length, 1, raw[managedRow]);
			assert.deepEqual(spans[0]?.action, { kind: "command", command: "/tasks" });
			assert.equal(rows[managedRow]?.slice(spans[0]!.start, spans[0]!.end), "/tasks to manage");
		}
		assert.deepEqual(readHintSpans(raw[goneRow] ?? "").spans, []);
	}
});

test("disposing a subagent's task page unregisters its /tasks hint route so the page is collected", async () => {
	initTheme("dark");
	const tasks = [{ ...taskRecord(agent), agentName: "worker" }, shell("shell-own", "npm run build", agent)];
	const source = transcriptOnlySource({
		tasks,
		ownerTasks: tasks,
		readTaskTranscript: () => ({
			ok: true,
			value: { messages: transcript([{ callId: "call-own", command: "npm run build", taskId: "shell-own" }]) },
		}),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
	});
	const tracked = trackCollection();
	const routes: string[] = [];
	const openAndDispose = async () => {
		const env = taskTranscriptEnvironment({
			keybindings: new KeybindingsManager(),
			createChat: (options) => new ChatSessionHost(options),
		});
		const page = new TaskAgentTranscriptPage(source, agent, env, () => {});
		await page.load();
		const raw = page.renderView(100, 30);
		const row = raw[plain(raw).findIndex((line) => line.includes("Bash(npm run build)")) + 1] ?? "";
		const action = readHintSpans(row).spans[0]?.action;
		assert.ok(action?.kind === "command" && action.route !== undefined, row);
		routes.push(action.route);
		tracked.track(page);
		page.dispose();
	};
	for (let index = 0; index < 8; index += 1) await openAndDispose();
	await collectEverythingTracked(tracked);
	assert.deepEqual(
		tracked.uncollected(),
		[],
		`disposed pages remained retained by their hint routes: ${tracked.uncollected().join(", ")}`,
	);
	for (const route of routes) assert.equal(runHintRoute(route, "/tasks"), false);
});
