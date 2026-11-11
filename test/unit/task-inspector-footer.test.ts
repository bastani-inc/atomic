import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
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
import { showTaskInspector, type TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function host(source?: (owner: TaskViewSource) => TaskViewSource, keys = new KeybindingsManager()) {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(keys);
	const fixture = taskFixture();
	const owner = ownerTaskViewSource(fixture.store);
	const environment = taskTranscriptEnvironment({ keybindings: keys });
	const inspector = new TaskInspector(
		source?.(owner) ?? owner,
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	return {
		fixture,
		inspector,
		lines: (width = 110, rows = 24) =>
			inspector.renderViewport(width, rows).map((line) => stripVTControlCharacters(line).trimEnd()),
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		},
	};
}

async function enter(inspector: TaskInspector) {
	inspector.handleInput("\r");
	await flush();
}

test("task picker and detail show exact navigation hints and action rows (#4521)", async () => {
	const h = await host();
	try {
		await h.fixture.start("Footer task");
		assert.match(h.lines().join("\n"), /↑↓ select · enter view · Esc back/i);
		assert.doesNotMatch(h.lines().join("\n"), /x stop|› Inspect transcript/);
		await enter(h.inspector);
		assert.match(h.lines().join("\n"), /› Inspect transcript/);
		assert.match(h.lines().join("\n"), /PgUp\/PgDn scroll · ↑↓ actions · enter select · x stop · Esc back/i);
		h.inspector.handleInput("x");
		assert.match(h.lines().join("\n"), /y confirm · n\/Esc keep running/);
		assert.doesNotMatch(h.lines().join("\n"), /› Inspect transcript/);
	} finally {
		await h.dispose();
	}
});

test("detail wheel scrolls its activity without changing the selected task (#4521)", async () => {
	const h = await host();
	try {
		await h.fixture.start("Scroll task");
		for (let i = 0; i < 16; i++)
			h.fixture.runners[0].context.reportActivity({
				reportId: `r-${i}`,
				change: { kind: "action", tool: "read", text: `ROW-${i}` },
			});
		h.fixture.store.drain();
		await enter(h.inspector);
		const selected = h.lines(80, 10)[0];
		const before = h.lines(80, 10).join("\n");
		h.inspector.handleInput("\x1b[<65;10;5M");
		assert.notEqual(h.lines(80, 10).join("\n"), before);
		assert.equal(h.lines(80, 10)[0], selected);
		h.inspector.handleInput("\x1b[<64;10;5M");
		assert.equal(h.lines(80, 10).join("\n"), before);
	} finally {
		await h.dispose();
	}
});

test("shell transcript retains the note and exact footer at the bottom of its viewport (#4521)", async () => {
	const shell = taskRecord("shell", "command");
	shell.output.byteCount = "10000";
	const h = await host((owner) => ({
		...owner,
		tasks: [shell],
		backgroundTasks: [shell],
		readTaskOutput: async () => ({ ok: true as const, value: { text: "short output", omitted: false } }),
	}));
	try {
		await enter(h.inspector);
		await enter(h.inspector);
		const lines = h.lines(110, 30);
		assert.equal(lines.length, 30);
		assert.equal(lines.at(-2), "Earlier output omitted · showing retained 8 KiB tail");
		assert.equal(lines.at(-1), "Esc back · ctrl+home/ctrl+end top/latest");
		assert.doesNotMatch(lines.at(-1) ?? "", /Enter messages/);
		assert.ok(lines.slice(3, -2).some((line) => line === ""));
	} finally {
		await h.dispose();
	}
});

test("agent transcript footer offers messaging only when the source supports it (#4521)", async () => {
	for (const canSend of [true, false]) {
		const h = await host((owner) =>
			canSend ? owner : Object.assign(Object.create(owner) as TaskViewSource, { sendTaskMessage: undefined }),
		);
		try {
			await h.fixture.start("Agent footer");
			const session = SessionManager.inMemory();
			await session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
			h.fixture.runners[0].context.bindTranscript(session);
			await enter(h.inspector);
			await enter(h.inspector);
			assert.equal(h.lines(110, 30).at(-2), "─".repeat(110));
			const footer = h.lines(110, 30).at(-1) ?? "";
			assert.equal(footer.includes("Enter messages the agent"), canSend);
			assert.equal(
				footer,
				canSend
					? "Esc back · Enter messages the agent · ctrl+home/ctrl+end top/latest"
					: "Esc back · ctrl+home/ctrl+end top/latest",
			);
			assert.doesNotMatch(footer, / · {2}· /);
		} finally {
			await h.dispose();
		}
	}
});

test("transcript shows both a retained-output note and a late input failure (#4521, #4662)", async () => {
	const written = Promise.withResolvers<{ ok: false; error: { message: string } }>();
	const shell = taskRecord("shell", "command");
	shell.output.byteCount = "10000";
	const h = await host((owner) => ({
		...owner,
		tasks: [shell],
		backgroundTasks: [shell],
		stdinAvailable: () => true,
		writeTaskInput: () => written.promise,
		readTaskOutput: async () => ({ ok: true as const, value: { text: "output", omitted: false } }),
	}));
	try {
		await enter(h.inspector);
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput("\x1b[B");
		await enter(h.inspector);
		h.inspector.handleInput("y");
		await enter(h.inspector);
		h.inspector.handleInput("\x1b");
		await enter(h.inspector);
		await enter(h.inspector);
		written.resolve({ ok: false, error: { message: "input failed" } });
		await flush();
		assert.equal(h.lines().at(-2), "Earlier output omitted · showing retained 8 KiB tail · input failed");
	} finally {
		written.resolve({ ok: false, error: { message: "input failed" } });
		await h.dispose();
	}
});

test("opening the picker again replaces an open transcript (#4521)", async () => {
	const h = await host();
	try {
		await h.fixture.start("Return to picker");
		await enter(h.inspector);
		await enter(h.inspector);
		assert.match(h.lines().join("\n"), /^Transcript/);
		h.inspector.open();
		assert.match(h.lines().join("\n"), /Background tasks/);
		assert.doesNotMatch(h.lines().join("\n"), /^Transcript/);
	} finally {
		await h.dispose();
	}
});

test("settled tasks do not offer a stop shortcut (#4521)", async () => {
	const h = await host();
	try {
		await h.fixture.start("Settled task");
		await h.fixture.settle();
		await flush();
		const footer = h.lines().at(-1) ?? "";
		assert.match(footer, /↑↓ select · enter view · Esc back/i);
		await enter(h.inspector);
		assert.match(h.lines().at(-1) ?? "", /↑↓ actions · enter select · Esc back/i);
	} finally {
		await h.dispose();
	}
});

test("configured stop shortcut is shown on picker and detail instead of x (#4521)", async () => {
	const h = await host(undefined, new KeybindingsManager({ "app.tasks.cancel": "ctrl+k" }));
	try {
		await h.fixture.start("Configured stop");
		assert.match(h.lines().at(-1) ?? "", /ctrl\+k stop · Esc back/);
		await enter(h.inspector);
		assert.match(h.lines().at(-1) ?? "", /ctrl\+k stop · Esc back/);
		assert.doesNotMatch(h.lines().at(-1) ?? "", /x stop/);
	} finally {
		await h.dispose();
	}
});

test("an open agent transcript remains renderable after its task disappears (#4521)", async () => {
	let present = true;
	let changed = () => {};
	const h = await host((owner) => ({
		...owner,
		get tasks() {
			return present ? owner.tasks : [];
		},
		get backgroundTasks() {
			return present ? owner.backgroundTasks : [];
		},
		subscribe(listener) {
			changed = listener;
			return owner.subscribe(listener);
		},
	}));
	try {
		await h.fixture.start("Disappearing task");
		await enter(h.inspector);
		await enter(h.inspector);
		present = false;
		changed();
		await flush();
		const lines = h.lines();
		assert.match(lines[0] ?? "", /^Transcript · Task$/);
		assert.equal(lines.at(-1), "Esc back · ctrl+home/ctrl+end top/latest");
	} finally {
		await h.dispose();
	}
});

test("physical Ctrl+C closes the mounted inspector and is consumed (#4521)", async () => {
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
	let completion: Promise<void> | undefined;
	try {
		await fixture.start("Close inspector");
		completion = showTaskInspector({ custom: service.custom.bind(service) }, fixture.store);
		await flush();
		const open = messages.findLast((message) => message.type === "engine_custom_open");
		assert.ok(open && open.type === "engine_custom_open");
		service.handleLine(
			serializeInteractiveEngineFrame({
				type: "engine_custom_input",
				componentId: open.componentId,
				requestId: 1,
				data: "\x03",
			}),
		);
		await flush();
		const result = messages.findLast((message) => message.type === "engine_custom_input_result");
		assert.ok(result && result.type === "engine_custom_input_result");
		assert.equal(result.handled, true);
		await completion;
	} finally {
		service.dispose();
		await completion;
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("mounted transcript tolerates host settings callbacks being withdrawn (#4521)", async () => {
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
	const ui: TaskInspectorUi = {
		custom: service.custom.bind(service),
		getChatRenderSettings: () => ({
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			toolOutputExpanded: false,
			showImages: false,
			imageWidthCells: 80,
			markdownTransformers: [],
			getToolDefinition: () => undefined,
			getCustomMessageRenderer: () => undefined,
		}),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	let completion: Promise<void> | undefined;
	try {
		await fixture.start("Changing host settings");
		completion = showTaskInspector(ui, fixture.store);
		await flush();
		const send = async (data: string, requestId: number) => {
			const open = messages.findLast((message) => message.type === "engine_custom_open");
			assert.ok(open && open.type === "engine_custom_open");
			service.handleLine(
				serializeInteractiveEngineFrame({
					type: "engine_custom_input",
					componentId: open.componentId,
					requestId,
					data,
				}),
			);
			await flush();
			const result = messages.findLast(
				(message) => message.type === "engine_custom_input_result" && message.requestId === requestId,
			);
			assert.ok(result && result.type === "engine_custom_input_result");
			assert.equal(result.handled, true);
		};
		await send("\r", 1);
		await send("\r", 2);
		ui.getChatRenderSettings = undefined;
		const open = messages.findLast((message) => message.type === "engine_custom_open");
		assert.ok(open && open.type === "engine_custom_open");
		service.handleLine(
			serializeInteractiveEngineFrame({
				type: "engine_custom_render",
				componentId: open.componentId,
				requestId: 3,
				width: 100,
				rows: 24,
			}),
		);
		await flush();
		const frame = messages.findLast((message) => message.type === "engine_custom_frame" && message.requestId === 3);
		assert.ok(frame && frame.type === "engine_custom_frame");
		assert.match(frame.lines.map((line) => stripVTControlCharacters(line)).join("\n"), /Transcript/);
		ui.getToolsExpanded = undefined;
		await send("\x0f", 4);
		ui.getToolsExpanded = () => false;
		ui.setToolsExpanded = undefined;
		await send("\x0f", 5);
		await send("\x03", 6);
		await completion;
	} finally {
		service.dispose();
		await completion;
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("shell transcript refresh reads from zero if its task record disappears (#4521)", async () => {
	let present = true;
	let changed = () => {};
	const reads: string[] = [];
	const shell = taskRecord("shell", "command");
	shell.output.byteCount = "10000";
	const h = await host((owner) => ({
		...owner,
		get tasks() {
			return present ? [shell] : [];
		},
		get backgroundTasks() {
			return present ? [shell] : [];
		},
		subscribe(listener) {
			changed = listener;
			return () => {};
		},
		readTaskOutput: async (_id, range) => {
			reads.push(range.start);
			return { ok: true as const, value: { text: `from ${range.start}`, omitted: false } };
		},
	}));
	try {
		await enter(h.inspector);
		await enter(h.inspector);
		assert.equal(reads.at(-1), "1808");
		present = false;
		changed();
		await flush();
		assert.equal(reads.at(-1), "0");
		assert.match(h.lines().join("\n"), /from 0/);
	} finally {
		await h.dispose();
	}
});

test("Ctrl+C during a picker-to-detail transition closes instead of reopening it (#4521)", async () => {
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
	let completion: Promise<void> | undefined;
	let finished = false;
	try {
		await fixture.start("Transition close");
		completion = showTaskInspector({ custom: service.custom.bind(service) }, fixture.store).then(() => {
			finished = true;
		});
		await flush();
		const open = messages.findLast((message) => message.type === "engine_custom_open");
		assert.ok(open && open.type === "engine_custom_open");
		for (const [requestId, data] of [
			[1, "\r"],
			[2, "\x03"],
		] as const)
			service.handleLine(
				serializeInteractiveEngineFrame({
					type: "engine_custom_input",
					componentId: open.componentId,
					requestId,
					data,
				}),
			);
		await flush();
		assert.equal(finished, true);
		assert.equal(messages.filter((message) => message.type === "engine_custom_open").length, 1);
	} finally {
		service.dispose();
		await completion;
		await fixture.dispose();
		setKeybindings(previous);
	}
});
