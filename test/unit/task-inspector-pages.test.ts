import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const down = "\x1b[<65;10;5M";
const up = "\x1b[<64;10;5M";

async function host(
	options: {
		environment?: boolean;
		source?: (owner: TaskViewSource) => TaskViewSource;
		keys?: KeybindingsManager;
	} = {},
) {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = options.keys ?? new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const owner = ownerTaskViewSource(fixture.store);
	const source = options.source?.(owner) ?? owner;
	const env = taskTranscriptEnvironment({ keybindings: keys });
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => (options.environment === false ? undefined : env),
	);
	const frame = (width = 110, rows = 24) => inspector.renderViewport(width, rows);
	return {
		inspector,
		fixture,
		frame,
		text: (width = 110, rows = 24) => plain(frame(width, rows)),
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		},
	};
}

async function drill(inspector: TaskInspector) {
	inspector.handleInput("\r");
	await flush();
	inspector.handleInput("\r");
	await flush();
}

test("task picker and detail show page-specific hints and wheel moves selection and scroll (#4521)", async () => {
	const h = await host();
	try {
		await h.fixture.start("First task");
		await h.fixture.start("Second task");
		assert.match(h.text(), /↑↓ select.*view.*Esc back/);
		const initial = h.inspector.navigation.selectedTaskId;
		h.inspector.handleInput(up);
		assert.notEqual(h.inspector.navigation.selectedTaskId, initial);
		h.inspector.handleInput(down);
		assert.equal(h.inspector.navigation.selectedTaskId, initial);
		for (let i = 0; i < 12; i++)
			h.fixture.runners[0].context.reportActivity({
				reportId: `a-${i}`,
				change: { kind: "action", tool: "read", text: `DETAIL-${i}` },
			});
		h.fixture.store.drain();
		h.inspector.handleInput("\r");
		await flush();
		assert.match(h.text(), /PgUp\/PgDn scroll · ↑↓ actions.*select.*stop.*Esc back/);
		const before = h.text(80, 10);
		h.inspector.handleInput(up);
		assert.equal(h.text(80, 10), before);
		h.inspector.handleInput(down);
		const after = h.text(80, 10);
		assert.notEqual(after, before);
		assert.equal(h.inspector.navigation.selectedTaskId, initial);
		h.inspector.handleInput(up);
		assert.equal(h.text(80, 10), before);
		await h.fixture.settle(0);
		await flush();
		assert.doesNotMatch(h.text(), /\b(?:x|ctrl\+x) stop/);
	} finally {
		await h.dispose();
	}
});

test("agent transcript footer offers messaging only when supported and fills the viewport (#4521)", async () => {
	for (const canSend of [true, false]) {
		const h = await host({
			source: (owner) =>
				canSend ? owner : Object.assign(Object.create(owner) as TaskViewSource, { sendTaskMessage: undefined }),
		});
		try {
			await h.fixture.start("Review chat");
			const session = SessionManager.inMemory();
			await session.appendMessage({ role: "user", content: "hello transcript", timestamp: 0 });
			h.fixture.runners[0].context.bindTranscript(session);
			await drill(h.inspector);
			const lines = h.frame(110, 30);
			const text = plain(lines);
			assert.match(text, /^Transcript/);
			assert.match(text, /hello transcript/);
			assert.match(text, /Esc back · .*top\/latest/);
			assert.equal(text.includes("Enter messages the agent"), canSend);
			assert.equal(lines.length, 30);
			assert.ok(lines.every((line) => visibleWidth(line) <= 110));
			h.inspector.invalidate();
			assert.match(h.text(), /hello transcript/);
		} finally {
			await h.dispose();
		}
	}
});

test("missing transcript environment explains why an agent cannot be inspected (#4521)", async () => {
	const h = await host({ environment: false });
	try {
		await h.fixture.start("Agent without host");
		h.inspector.invalidate();
		await drill(h.inspector);
		assert.match(h.text(), /Transcript inspection is unavailable in this host\./);
		assert.match(h.text(), /Inspect transcript/);
		assert.doesNotMatch(h.text(), /^Transcript/);
	} finally {
		await h.dispose();
	}
});

test("shell transcript uses selected task's current output tail and refreshes it without a host (#4521)", async () => {
	const shell = taskRecord("shell", "command");
	shell.output.byteCount = "10000";
	const other = taskRecord("other", "command");
	other.output.byteCount = "50000";
	const reads: Array<{ id: TaskId; start: string }> = [];
	let changed = () => {};
	const h = await host({
		environment: false,
		source: (owner) => ({
			...owner,
			tasks: [other, shell],
			backgroundTasks: [shell],
			subscribe: (listener: () => void) => {
				changed = listener;
				return () => {};
			},
			readTaskOutput: async (id: TaskId, range: { start: string }) => {
				reads.push({ id, start: range.start });
				return { ok: true as const, value: { text: `OUTPUT FROM ${range.start}`, omitted: false } };
			},
		}),
	});
	try {
		await drill(h.inspector);
		assert.equal(reads.at(-1)?.id, shell.ref.taskId);
		assert.equal(reads.at(-1)?.start, "1808");
		assert.match(h.text(), /OUTPUT FROM 1808/);
		assert.match(h.text(), /Earlier output omitted · showing retained 8 KiB tail/);
		assert.match(h.text(), /Esc back · .*top\/latest/);
		assert.doesNotMatch(h.text(), /Enter messages the agent/);
		const frame = h.frame(110, 24);
		assert.equal(frame.length, 24);
		assert.equal(plain(frame).split("\n").at(-1)?.includes("Esc back"), true);
		shell.output.byteCount = "12000";
		changed();
		await flush();
		assert.equal(reads.at(-1)?.start, "3808");
		assert.match(h.text(), /OUTPUT FROM 3808/);
	} finally {
		await h.dispose();
	}
});

test("store updates reload only the focused detail, and closing transcript reloads its latest content (#4521)", async () => {
	let detail = "Initial prompt";
	let changed = () => {};
	let reads = 0;
	const h = await host({
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				subscribe: (listener: () => void) => {
					changed = listener;
					return owner.subscribe(listener);
				},
				taskDetailText: () => {
					reads++;
					return { prompt: detail };
				},
			}),
	});
	try {
		await h.fixture.start("Refresh task");
		reads = 0;
		changed();
		assert.equal(reads, 0);
		h.inspector.handleInput("\r");
		await flush();
		assert.match(h.text(), /Initial prompt/);
		detail = "Updated prompt";
		changed();
		await flush();
		assert.match(h.text(), /Updated prompt/);
		h.inspector.handleInput("\r");
		await flush();
		assert.match(h.text(), /^Transcript/);
		detail = "Returned prompt";
		assert.equal(h.inspector.handleInput("\x1b"), true);
		await flush();
		assert.match(h.text(), /Returned prompt/);
		assert.match(h.text(), /Inspect transcript/);
	} finally {
		await h.dispose();
	}
});

test("a delayed stop failure remains visible below an open transcript (#4521)", async () => {
	const result = Promise.withResolvers<{ ok: false; error: { message: string } }>();
	const h = await host({
		source: (owner) => Object.assign(Object.create(owner) as TaskViewSource, { cancelTask: () => result.promise }),
	});
	try {
		await h.fixture.start("Stop failure");
		h.inspector.handleInput("\r");
		await flush();
		h.inspector.handleInput("x");
		h.inspector.handleInput("y");
		await flush();
		h.inspector.handleInput("\r");
		await flush();
		result.resolve({ ok: false, error: { message: "stop refused" } });
		await flush();
		const lines = h.frame(110, 24);
		assert.equal(lines.length, 24);
		assert.match(plain(lines), /Esc back.*top\/latest\nCould not stop the task: stop refused/);
	} finally {
		result.resolve({ ok: false, error: { message: "stop refused" } });
		await h.dispose();
	}
});

test("only the default physical thinking key is handed back to its host (#4521)", async () => {
	for (const [keys, physical, remapped] of [
		[new KeybindingsManager(), false, true],
		[new KeybindingsManager({ "app.thinking.toggle": "ctrl+y" }), true, true],
	] as const) {
		const h = await host({ keys });
		try {
			await h.fixture.start("Keyboard ownership");
			assert.equal(h.inspector.handleInput("\x14"), physical);
			assert.equal(h.inspector.handleInput("\x19"), remapped);
		} finally {
			await h.dispose();
		}
	}
});

test("mounted inspector inherits render settings and toggles only the host tool output (#4521)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) messages.push(message);
	}, keys);
	let expanded = false;
	let settingsReads = 0;
	let gets = 0;
	const sets: boolean[] = [];
	let completion: Promise<void> | undefined;
	try {
		await fixture.start("Bridge chat");
		const session = SessionManager.inMemory();
		await session.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "BRIDGE THINKING" },
				{ type: "toolCall", id: "call", name: "bash", arguments: { command: "seq" } },
			],
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
			stopReason: "toolUse",
			timestamp: 1,
		} as AssistantMessage);
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "bash",
			content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `OUTPUT-${i}`).join("\n") }],
			isError: false,
			timestamp: 2,
		});
		fixture.runners[0].context.bindTranscript(session);
		completion = showTaskInspector(
			{
				custom: service.custom.bind(service),
				getChatRenderSettings: () => {
					settingsReads++;
					return {
						hideThinkingBlock: true,
						hiddenThinkingLabel: "Thinking...",
						toolOutputExpanded: expanded,
						showImages: false,
						imageWidthCells: 80,
						markdownTransformers: [],
						getToolDefinition: () => undefined,
						getCustomMessageRenderer: () => undefined,
					};
				},
				getToolsExpanded: () => {
					gets++;
					return expanded;
				},
				setToolsExpanded: (value) => {
					sets.push(value);
					expanded = value;
				},
			},
			fixture.store,
		);
		await flush();
		const send = async (data: string) => {
			const open = messages.findLast((m) => m.type === "engine_custom_open");
			assert.ok(open && open.type === "engine_custom_open");
			service.handleLine(
				serializeInteractiveEngineFrame({
					type: "engine_custom_input",
					componentId: open.componentId,
					requestId: messages.length,
					data,
				}),
			);
			await flush();
		};
		const render = async () => {
			const open = messages.findLast((m) => m.type === "engine_custom_open");
			assert.ok(open && open.type === "engine_custom_open");
			service.handleLine(
				serializeInteractiveEngineFrame({
					type: "engine_custom_render",
					componentId: open.componentId,
					requestId: messages.length,
					width: 110,
					rows: 80,
				}),
			);
			await flush();
			const frame = messages.findLast((m) => m.type === "engine_custom_frame");
			assert.ok(frame && frame.type === "engine_custom_frame");
			return plain(frame.lines);
		};
		await send("\r");
		await send("\r");
		const collapsed = await render();
		assert.doesNotMatch(collapsed, /BRIDGE THINKING|OUTPUT-0\b/);
		assert.match(collapsed, /OUTPUT-39/);
		assert.ok(settingsReads > 0);
		await send("\x0f");
		assert.ok(gets > 0);
		assert.deepEqual(sets, [true]);
		assert.match(await render(), /OUTPUT-0\b/);
		await send("\x0f");
		assert.deepEqual(sets, [true, false]);
		assert.doesNotMatch(await render(), /OUTPUT-0\b/);
		await send("\x03");
		await completion;
	} finally {
		service.dispose();
		await completion;
		await fixture.dispose();
		setKeybindings(previous);
	}
});
