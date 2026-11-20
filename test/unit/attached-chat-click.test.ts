import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings, type TuiMouseEvent, type TuiMouseEventResult } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { heldPrompts } from "../../packages/coding-agent/src/core/extensions/held-prompts.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskCompletionEnvelope } from "../../packages/coding-agent/src/core/tasks/completion.js";
import { taskCompletionMessage } from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	type TaskTranscriptEnvironment,
	themedChatHostStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { renderIntercomCustomMessage } from "../../packages/intercom/ui/inline-message.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`).join("\n");

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	} satisfies AssistantMessage;
}

function click(x: number, y: number, width: number, height: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

/** The renderer's part after a click reached a view: once no second press made it a double-click, its action runs. */
function settled(result: TuiMouseEventResult | undefined): TuiMouseEventResult | undefined {
	result?.whenSingleClick?.();
	return result;
}

/** A task's open transcript in the task inspector, over `session`, with live events from `emit`. */
async function openTranscript(
	session: SessionManager,
	width = 100,
	height = 60,
	overrides: Partial<TaskTranscriptEnvironment> = {},
) {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const environment = taskTranscriptEnvironment(overrides);
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	await fixture.start();
	fixture.runners[0]!.context.bindTranscript({
		getSessionId: () => session.getSessionId(),
		getEntries: () => session.getEntries(),
		getStreamingMessage: () => undefined,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	inspector.handleInput("\r");
	await flush();
	inspector.handleInput("\r");
	await flush();
	const screen = () => inspector.renderViewport(width, height).map((line) => stripVTControlCharacters(line));
	const rowOf = (pattern: RegExp) => {
		const row = screen().findIndex((line) => pattern.test(line));
		assert.notEqual(row, -1, `no row matches ${pattern}:\n${screen().join("\n")}`);
		return row;
	};
	const clickOn = (pattern: RegExp, text: string) => {
		const row = rowOf(pattern);
		return settled(inspector.handleMouse(click(screen()[row]!.indexOf(text), row, width, height)));
	};
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const dispose = async () => {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(keys);
	};
	const press = (data: string) => inspector.handleInput(data);
	return { screen, rowOf, clickOn, emit, press, dispose };
}

test("Ctrl+O wins over an attached click still waiting to settle (#5562)", () => {
	initTheme("dark");
	let expanded = false;
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		editorTheme: getEditorTheme(),
		getChatRenderSettings: () => ({
			toolOutputExpanded: expanded,
			getCustomMessageRenderer:
				() =>
				(_message, { expanded }) => ({
					invalidate() {},
					render: () => ["Card title", ...(expanded ? ["Detail"] : [])],
				}),
		}),
	});
	try {
		host.replaceMessages([{ role: "custom", customType: "card", content: "sample", display: true, timestamp: 1 }]);
		const row = host.renderBody(100, 50).findIndex((line) => line.includes("Card title"));
		const pending = host.handleBodyClick(click(2, row, 100, 50));
		assert.ok(pending?.whenSingleClick);
		expanded = true;
		host.toolOutputToggled();
		host.renderBody(100, 50);
		settled(pending);
		assert.ok(host.renderBody(100, 50).some((line) => line.includes("Detail")));
	} finally {
		host.dispose();
	}
});

test("an attached click uses its block's width when the click settles (#5562)", () => {
	initTheme("dark");
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		editorTheme: getEditorTheme(),
		getChatRenderSettings: () => ({
			getCustomMessageRenderer:
				() =>
				(_message, { expanded }) => ({
					invalidate() {},
					render: (width) => ["Responsive title", ...(expanded && width < 80 ? ["Narrow detail"] : [])],
				}),
		}),
	});
	try {
		host.replaceMessages([
			{ role: "custom", customType: "responsive", content: "sample", display: true, timestamp: 1 },
		]);
		const wide = host.renderBody(105, 50);
		const row = wide.findIndex((line) => line.includes("Responsive title"));
		assert.notEqual(row, -1);
		const pending = host.handleBodyClick(click(2, row, 105, 50));
		assert.ok(pending?.whenSingleClick);
		host.renderBody(68, 50);
		settled(pending);
		assert.ok(host.renderBody(68, 50).some((line) => line.includes("Narrow detail")));
	} finally {
		host.dispose();
	}
});

test("an attached click opens the group its call joined while the click was waiting (#5562)", () => {
	initTheme("dark");
	const host = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
	const finish = (id: string) => {
		host.applyAgentEvent({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } });
		host.applyAgentEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: { content: [{ type: "text", text: `${id} output` }] },
			isError: false,
		});
	};
	try {
		finish("first-call");
		const row = host.renderBody(100, 50).findIndex((line) => line.includes("first-call"));
		const pending = host.handleBodyClick(click(2, row, 100, 50));
		assert.ok(pending?.whenSingleClick);
		finish("second-call");
		assert.ok(!host.renderBody(100, 50).some((line) => line.includes("second-call output")));
		settled(pending);
		assert.ok(host.renderBody(100, 50).some((line) => line.includes("second-call output")));
	} finally {
		host.dispose();
	}
});

test("in an attached chat, calls that join a group after a click expanded its first call are drawn on their own, collapsed", () => {
	initTheme("dark");
	const host = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
	const finish = (id: string) => {
		host.applyAgentEvent({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } });
		host.applyAgentEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: { content: [{ type: "text", text: lines(20, id) }] },
			isError: false,
		});
	};
	const body = () => host.renderBody(100, 80).map((line) => stripVTControlCharacters(line).trimEnd());
	const shows = (pattern: RegExp) => body().some((line) => pattern.test(line));
	const clickOn = (text: string) => {
		const row = body().findIndex((line) => line.includes(text));
		return settled(host.handleBodyClick(click(2, row, 100, 80)));
	};
	try {
		finish("first-call");
		clickOn("first-call");
		assert.ok(shows(/first-call line 1$/), body().join("\n"));

		finish("second-call");
		finish("third-call");
		for (const call of ["second-call", "third-call"])
			assert.ok(shows(new RegExp(`${call} line 20$`)), `${call} is not drawn:\n${body().join("\n")}`);
		assert.ok(!shows(/second-call line 1$/) && !shows(/third-call line 1$/), body().join("\n"));
		assert.ok(shows(/first-call line 1$/), body().join("\n"));

		clickOn("second-call");
		assert.ok(shows(/second-call line 1$/), body().join("\n"));
		assert.ok(!shows(/third-call line 1$/), body().join("\n"));

		host.toolOutputToggled();
		assert.ok(shows(/Ran 3 shell commands/), body().join("\n"));
		assert.ok(!shows(/call line 20$/), body().join("\n"));
	} finally {
		host.dispose();
	}
});

test("a running tool block a click expanded stays expanded as its live output arrives", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Run it", timestamp: 0 });
	const chat = await openTranscript(session);
	try {
		chat.emit({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "live-cmd" } });
		const update = (count: number) =>
			chat.emit({
				type: "tool_execution_update",
				toolCallId: "live",
				toolName: "bash",
				args: { command: "live-cmd" },
				partialResult: { content: [{ type: "text", text: lines(count, "live") }] },
			});
		update(20);
		const expanded = () => chat.screen().some((line) => line.trimEnd().endsWith("live line 1"));
		assert.ok(!expanded(), chat.screen().join("\n"));
		assert.equal(chat.clickOn(/live-cmd/, "live-cmd")?.handled, true);
		assert.ok(expanded(), chat.screen().join("\n"));

		update(25);
		assert.ok(expanded(), `the next output collapsed the block:\n${chat.screen().join("\n")}`);
		assert.ok(chat.screen().some((line) => line.trimEnd().endsWith("live line 25")));
	} finally {
		await chat.dispose();
	}
});

test("a finished-agent card in a task transcript expands on a click on its header and collapses on a click on its result", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Check the release", timestamp: 0 });
	const envelope = {
		completionId: "completion-1",
		ownerId: "owner",
		taskId: "task-1",
		terminalSequence: "7",
		result: {
			kind: "completed",
			output: { ownerId: "owner", taskId: "task-1", artifactId: "out", byteCount: "0", omittedRanges: [] },
		},
		display: false,
	} as unknown as TaskCompletionEnvelope;
	const message = taskCompletionMessage(
		envelope,
		{ kind: "agent", title: "check the release", agentName: "worker" } as never,
		lines(3, "worker result"),
	);
	await session.appendCustomMessageEntry(message.customType, message.content, true, message.details);
	const chat = await openTranscript(session);
	try {
		const shown = () => chat.screen().some((line) => line.trimEnd().endsWith("worker result line 3"));
		assert.ok(!shown(), chat.screen().join("\n"));
		assert.equal(chat.clickOn(/worker finished/, "worker")?.handled, true);
		assert.ok(shown(), chat.screen().join("\n"));
		assert.equal(chat.clickOn(/worker result line 2$/, "result")?.handled, true);
		assert.ok(!shown(), chat.screen().join("\n"));
	} finally {
		await chat.dispose();
	}
});

test("a user shell block in an attached chat expands on a click on its output", () => {
	initTheme("dark");
	const host = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
	try {
		host.replaceMessages([
			{
				role: "bashExecution",
				command: "user-cmd",
				output: lines(30, "shell"),
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 0,
			},
		]);
		const screen = () => host.renderBody(100, 50).map((line) => stripVTControlCharacters(line));
		const expanded = () => screen().some((line) => line.trimEnd().endsWith("shell line 1"));
		assert.ok(!expanded(), screen().join("\n"));
		const row = screen().findIndex((line) => line.trimEnd().endsWith("shell line 28"));
		assert.notEqual(row, -1, screen().join("\n"));
		assert.equal(settled(host.handleBodyClick(click(screen()[row]!.indexOf("shell"), row, 100, 50)))?.handled, true);
		assert.ok(expanded(), screen().join("\n"));
	} finally {
		host.dispose();
	}
});

/** A child task's session: one finished bash call, `child-cmd`, with 20 lines of output. */
async function childSession(): Promise<SessionManager> {
	const child = SessionManager.inMemory();
	await child.appendMessage({ role: "user", content: "Child work", timestamp: 0 });
	await child.appendMessage(
		assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "child-cmd" } }], "toolUse"),
	);
	await child.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: lines(20, "child") }],
		isError: false,
		timestamp: 2,
	});
	return child;
}

test("pressing Ctrl+O twice before the next paint collapses a block a click expanded in a task transcript", async () => {
	let toolsExpanded = false;
	const chat = await openTranscript(await childSession(), 100, 60, {
		getToolsExpanded: () => toolsExpanded,
		setToolsExpanded: (expanded) => {
			toolsExpanded = expanded;
		},
		getChatRenderSettings: () => ({ toolOutputExpanded: toolsExpanded }),
	});
	try {
		const expanded = () => chat.screen().some((line) => line.trimEnd().endsWith("child line 1"));
		assert.equal(chat.clickOn(/child-cmd/, "child-cmd")?.handled, true);
		assert.ok(expanded(), chat.screen().join("\n"));

		chat.press("\x0f");
		chat.press("\x0f");
		assert.equal(toolsExpanded, false);
		assert.ok(!expanded(), chat.screen().join("\n"));
	} finally {
		await chat.dispose();
	}
});

test("a click on a block header in a task's transcript does nothing while the task's held question owns input", async () => {
	const session = await childSession();
	const chat = await openTranscript(session);
	const controller = new AbortController();
	const held = heldPrompts()
		.hold(
			{
				sessionId: session.getSessionId(),
				promptId: "confirm-1",
				kind: "confirm",
				question: "Ship it?",
				title: "Ship it?",
			},
			controller.signal,
			false,
		)
		.catch(() => undefined);
	try {
		await flush();
		const expanded = () => chat.screen().some((line) => line.trimEnd().endsWith("child line 1"));
		assert.match(chat.screen().join("\n"), /Ship it\?/, "the question is shown below the transcript");
		assert.equal(chat.clickOn(/child-cmd/, "child-cmd"), undefined);
		assert.ok(!expanded(), chat.screen().join("\n"));
	} finally {
		controller.abort();
		await held;
		await chat.dispose();
	}
});

test("a click in a chat's open task transcript reaches the blocks of that transcript", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const child = await childSession();
	const source = ownerTaskViewSource(fixture.store);
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		editorTheme: getEditorTheme(),
		getTaskSource: () => source,
	});
	try {
		await fixture.start("Child");
		fixture.runners[0]!.context.bindTranscript(Object.assign(child, { subscribe: () => () => {} }));
		assert.equal(host.openTasks(), true);
		host.handleTaskInput("\r");
		await flush();
		host.handleTaskInput("\r");
		await flush();
		const screen = () => host.renderBody(100, 50).map((line) => stripVTControlCharacters(line));
		const expanded = () => screen().some((line) => line.trimEnd().endsWith("child line 1"));
		assert.ok(!expanded(), screen().join("\n"));
		const shown = screen().findIndex((line) => line.trimEnd().endsWith("child line 19"));
		assert.notEqual(shown, -1, screen().join("\n"));
		assert.equal(
			settled(host.handleBodyClick(click(screen()[shown]!.indexOf("child"), shown, 100, 50)))?.handled,
			true,
		);
		assert.ok(expanded(), screen().join("\n"));
	} finally {
		host.dispose();
		await fixture.dispose();
		setKeybindings(keys);
	}
});

/** An Intercom message as a task's session records it, from a peer session. */
async function appendIntercomMessage(session: SessionManager, text: string): Promise<void> {
	const from = {
		id: "peer-1",
		name: "worker-2",
		cwd: "/workspace",
		model: "fixture/model",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	await session.appendCustomMessageEntry("intercom_message", text, true, {
		from,
		message: { id: "intercom-1", timestamp: 1, content: { text } },
		bodyText: text,
	});
}

test("an Intercom message card in a task transcript expands on a click on its collapsed-lines row and collapses on a click on its body", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Coordinate", timestamp: 0 });
	await appendIntercomMessage(session, lines(12, "peer"));
	const chat = await openTranscript(session, 100, 60, {
		getChatRenderSettings: () => ({
			getCustomMessageRenderer: (customType: string) =>
				customType === "intercom_message" ? renderIntercomCustomMessage : undefined,
		}),
	});
	try {
		const shown = () => chat.screen().some((line) => line.trimEnd().endsWith("peer line 12"));
		assert.ok(!shown(), chat.screen().join("\n"));
		assert.equal(chat.clickOn(/… \+9 lines/, "+9")?.handled, true);
		assert.ok(shown(), chat.screen().join("\n"));
		assert.equal(chat.clickOn(/peer line 6$/, "peer")?.handled, true);
		assert.ok(!shown(), chat.screen().join("\n"));
		assert.equal(chat.clickOn(/Message from worker-2/, "worker-2")?.handled, true);
		assert.ok(shown(), chat.screen().join("\n"));
	} finally {
		await chat.dispose();
	}
});

test("an Intercom message card in a subagent's chat expands on a click on its body", () => {
	initTheme("dark");
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		editorTheme: getEditorTheme(),
		getChatRenderSettings: () => ({
			getCustomMessageRenderer: (customType: string) =>
				customType === "intercom_message" ? renderIntercomCustomMessage : undefined,
		}),
	});
	try {
		const text = lines(12, "peer");
		host.replaceMessages([
			{
				role: "custom",
				customType: "intercom_message",
				content: text,
				display: true,
				details: {
					from: {
						id: "peer-1",
						name: "worker-2",
						cwd: "/workspace",
						model: "m",
						pid: 1,
						startedAt: 1,
						lastActivity: 1,
					},
					message: { id: "intercom-1", timestamp: 1, content: { text } },
					bodyText: text,
				},
				timestamp: 1,
			},
		]);
		const screen = () => host.renderBody(100, 50).map((line) => stripVTControlCharacters(line));
		const shown = () => screen().some((line) => line.trimEnd().endsWith("peer line 12"));
		assert.ok(!shown(), screen().join("\n"));
		const row = screen().findIndex((line) => line.trimEnd().endsWith("peer line 2"));
		assert.notEqual(row, -1, screen().join("\n"));
		assert.equal(settled(host.handleBodyClick(click(screen()[row]!.indexOf("peer"), row, 100, 50)))?.handled, true);
		assert.ok(shown(), screen().join("\n"));
	} finally {
		host.dispose();
	}
});
