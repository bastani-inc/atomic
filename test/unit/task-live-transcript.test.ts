import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AssistantMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.js";
import {
	chatEntriesFromAgentMessages,
	LiveChatEntriesController,
	renderChatMessageEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { TaskLiveTranscript } from "../../packages/coding-agent/src/modes/interactive/components/task-live-transcript.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
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
	stopReason: "stop",
	timestamp: 1,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("open agent transcript streams text and tool results without task activity or reopening", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Inspect streaming", timestamp: 0 });
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	let renders = 0;
	const inspector = new TaskInspector(
		fixture.store,
		() => {
			renders++;
		},
		() => {},
	);
	const text = () => stripVTControlCharacters(inspector.renderViewport(100, 100).join("\n"));
	try {
		await fixture.start();
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => session.getEntries(),
			getStreamingMessage: () => assistant("Already streaming"),
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		});
		inspector.handleInput("\r");
		await flush();
		inspector.handleInput("\r");
		await flush();
		assert.equal(listeners.size, 1);
		assert.match(text(), /Already streaming/);
		const before = renders;
		emit({
			type: "message_update",
			message: assistant(""),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " live delta", partial: assistant("") },
		});
		assert.ok(renders > before);
		assert.match(text(), /Already streaming live delta/);
		emit({ type: "message_end", message: assistant("Final response") });
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo test" } });
		emit({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "Partial tool output" }] },
		});
		assert.match(text(), /Partial tool output/);
		emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "Final tool output" }] },
			isError: false,
		});
		assert.match(text(), /Final tool output/);
		assert.doesNotMatch(text(), /Partial tool output/);
		assert.equal((text().match(/Final response/g) ?? []).length, 1);
		await fixture.settle();
		assert.match(text(), /Final tool output/);
		inspector.handleInput("\x1b");
		assert.equal(listeners.size, 0);
		const closedRenders = renders;
		emit({ type: "agent_end", messages: [] });
		assert.equal(renders, closedRenders);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(keys);
	}
});

test("live transcript keeps earlier pages and scroll position while new state arrives", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const session = SessionManager.inMemory();
	for (let i = 0; i < 120; i++)
		await session.appendMessage({ role: "user", content: `HISTORY-${String(i).padStart(3, "0")}`, timestamp: i });
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	const text = () => stripVTControlCharacters(inspector.renderViewport(80, 12).join("\n"));
	try {
		await fixture.start();
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => session.getEntries(),
			subscribe: (callback) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
		});
		inspector.handleInput("\r");
		await flush();
		inspector.handleInput("\r");
		await flush();
		inspector.handleInput("\x1b[5~");
		await flush();
		assert.match(text(), /HISTORY-000/);
		const before = text();
		listener?.({ type: "message_start", message: assistant("New live response") });
		assert.match(text(), /HISTORY-000/);
		assert.equal(text().split("Lines ")[0], before.split("Lines ")[0]);
		inspector.handleInput("\x1b[F");
		assert.match(text(), /New live response/);
		inspector.dispose();
		assert.equal(listener, undefined);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(keys);
	}
});

test("streaming rebuilds only changed message components and invalidation refreshes history", () => {
	initTheme("dark");
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let requests = 0;
	const history = Array.from({ length: 100 }, (_, index) => assistant(`HISTORY-${index} **retained**`));
	const updates = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
	const transcript = new TaskLiveTranscript(
		{
			getSessionId: () => "retention-test",
			getEntries: () => [],
			getStreamingMessage: () => assistant("Live"),
			subscribe: (callback) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
		},
		history,
		() => {
			requests++;
		},
	);
	try {
		const initial = transcript.render(80);
		assert.equal(updates.mock.calls.length, 101);
		for (let index = 0; index < 30; index++) {
			listener?.({
				type: "message_update",
				message: assistant(""),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: ` delta-${index}`,
					partial: assistant(""),
				},
			});
			transcript.render(80);
		}
		assert.equal(requests, 30);
		assert.equal(updates.mock.calls.length, 131, "historical Markdown must not be reconstructed per delta");
		const final = transcript.render(80);
		assert.deepEqual(final.slice(0, initial.length - 2), initial.slice(0, initial.length - 2));
		for (const width of [40, 100, 80]) {
			const text = stripVTControlCharacters(transcript.render(width).join("\n"));
			for (let index = 0; index < 100; index++) assert.equal(text.split(`HISTORY-${index} `).length - 1, 1);
		}
		assert.equal(updates.mock.calls.length, 131, "resize reuses components and their width-aware renderers");
		listener?.({ type: "agent_end", messages: [] });
		transcript.render(80);
		assert.equal(updates.mock.calls.length, 131);
		transcript.invalidate();
		assert.deepEqual(transcript.render(80), final);
		assert.equal(updates.mock.calls.length, 232);
	} finally {
		transcript.dispose();
		updates.mockRestore();
	}
	assert.equal(listener, undefined);
});

test("retained components match fresh rendering through tools, thinking, errors and theme changes", () => {
	initTheme("dark");
	const messages = [assistant("Duplicate"), assistant("Duplicate"), assistant("Unicode 界 👩‍💻 and **Markdown**")];
	const entries = chatEntriesFromAgentMessages(messages);
	const controller = new LiveChatEntriesController(entries);
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const transcript = new TaskLiveTranscript(
		{
			getSessionId: () => "parity",
			getEntries: () => [],
			subscribe: (callback) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
		},
		messages,
		() => {},
	);
	const compare = () => {
		for (const width of [80, 37, 100, 80]) {
			const expected = entries.flatMap((entry) =>
				renderChatMessageEntry(entry, {
					ui: { requestRender: () => {} },
					cwd: process.cwd(),
					hideThinkingBlock: true,
					toolOutputExpanded: true,
					showImages: false,
				}).render(width),
			);
			assert.deepEqual(transcript.render(width), expected);
		}
	};
	const emit = (event: AgentSessionEvent) => {
		// Separate controller state: text deltas mutate the streaming message in place.
		controller.applyEvent(structuredClone(event));
		listener?.(structuredClone(event));
		compare();
	};
	try {
		compare();
		emit({ type: "message_start", message: assistant("") });
		emit({
			type: "message_update",
			message: assistant(""),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "  live\n\n**raw** 界  ",
				partial: assistant(""),
			},
		});
		emit({
			type: "message_end",
			message: {
				...assistant("finished"),
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "finished" },
					{ type: "toolCall", id: "call", name: "bash", arguments: { command: "echo first" } },
				],
			},
		});
		emit({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "echo final" } });
		emit({
			type: "tool_execution_update",
			toolCallId: "call",
			toolName: "bash",
			args: {},
			partialResult: {
				content: [{ type: "text", text: "partial\noutput" }],
			},
		});
		emit({
			type: "tool_execution_end",
			toolCallId: "call",
			toolName: "bash",
			isError: false,
			result: {
				content: [{ type: "text", text: "complete\noutput" }],
			},
		});
		for (const stopReason of ["aborted", "error"] as const) {
			emit({ type: "message_start", message: assistant("") });
			emit({ type: "tool_execution_start", toolCallId: stopReason, toolName: "read", args: { path: "a.ts" } });
			emit({ type: "message_end", message: { ...assistant(""), stopReason, errorMessage: `test ${stopReason}` } });
		}
		initTheme("light");
		transcript.invalidate();
		compare();
	} finally {
		transcript.dispose();
		initTheme("dark");
	}
	assert.equal(listener, undefined);
});
