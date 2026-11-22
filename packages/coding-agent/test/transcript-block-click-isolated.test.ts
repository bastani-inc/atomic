import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getKeybindings,
	MULTI_CLICK_INTERVAL_MS,
	matchesKey,
	ScrollView,
	setKeybindings,
	stripTerminalSequences,
	Text,
	type TuiAltScreen,
	VStack,
	WindowedContainer,
} from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { collectEverythingTracked, trackCollection } from "../../../test/helpers/collect-garbage.js";
import { renderIntercomCustomMessage } from "../../intercom/ui/inline-message.js";
import { ENDED_CHILD_WAKE_MESSAGE_TYPE, renderIntercomWakeMessage } from "../../intercom/ui/wake-notice.js";
import { registerWebAccessMessageRenderers } from "../../web-access/message-renderers.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentSessionRuntime, createAgentSessionServices } from "../src/core/agent-session-runtime.js";
import { createAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { setCallbackActivityReporter } from "../src/core/callback-activity.js";
import { createEventBus } from "../src/core/event-bus.js";
import { loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionAPI, MessageRenderer } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { CustomMessage } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { InteractiveMode } from "../src/index.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import {
	supersedeBlockClicks,
	toggleClickedBlocks,
} from "../src/modes/interactive/components/transcript-block-clicks.js";
import { stopRendererWatch, watchSessionRenderers } from "../src/modes/interactive/interactive-session-runtime.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.js";
import { initTheme, onThemeChange, stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.js";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.js";
import {
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../src/modes/interactive-engine/remote-renderer.js";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.js";

beforeAll(() => initTheme("dark", false));

/** How long the host waits for an engine frame: a few render passes, with room for a loaded machine. */
const ENGINE_FRAME_WAIT = { timeout: 10_000, interval: 10 };

const closers: Array<() => void> = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");

/**
 * The isolated engine's render service behind an in-memory transport, with the Intercom message renderer loaded.
 * `frames.hold()` keeps what the engine sends back from reaching the host, as a busy engine or a slow pipe does, until
 * `frames.release()`.
 */
function isolatedEngine(renderers: Readonly<Record<string, MessageRenderer>> = {}) {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const ended = new Set<(event: { generation: number }) => void>();
	let generation = 1;
	let online = true;
	let offlineRenders = 0;
	let held: InteractiveEngineMessage[] | undefined;
	const deliver = (message: InteractiveEngineMessage) => {
		for (const listener of [...listeners]) listener(message);
	};
	setCallbackActivityReporter({ started() {}, finished() {} });
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (!message) return;
		if (held) held.push(message);
		else deliver(message);
	});
	const session = {
		extensionRunner: {
			resolveToolRenderers: () => undefined,
			getMessageRenderer: (customType: string) =>
				customType === "responsive"
					? (_message: CustomMessage<unknown>, { expanded }: { expanded: boolean }) => ({
							invalidate() {},
							render: (width: number) => ["Title", ...(expanded && width < 80 ? ["Narrow detail"] : [])],
						})
					: customType === "intercom_message"
						? renderIntercomCustomMessage
						: customType === ENDED_CHILD_WAKE_MESSAGE_TYPE
							? renderIntercomWakeMessage
							: renderers[customType],
		},
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/workspace" },
	} as unknown as AgentSession;
	service.bindSession(session);
	const runtime = {
		getEngineGeneration: () => generation,
		onGenerationEnded(listener: (event: { generation: number }) => void) {
			ended.add(listener);
			return () => ended.delete(listener);
		},
		onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand(command: InteractiveEngineCommand) {
			if (online) service.handleLine(serializeInteractiveEngineFrame(command).trim());
			else if (command.type === "engine_tool_render" || command.type === "engine_message_render") offlineRenders++;
		},
	} as unknown as IsolatedInteractiveRuntime;
	closers.push(() => {
		service.dispose();
		setCallbackActivityReporter(undefined);
	});
	const frames = {
		offlineRenders: () => offlineRenders,
		exit() {
			online = false;
			held = undefined; // The dead child cannot deliver its held replies.
			for (const listener of ended) listener({ generation });
		},
		rebind() {
			online = true;
			generation++;
			service.bindSession(session);
			deliver({ type: "engine_bound" });
		},
		hold() {
			held ??= [];
		},
		release() {
			const messages = held ?? [];
			held = undefined;
			for (const message of messages) deliver(message);
		},
		/** How many messages the engine sent while held. */
		held: () => held?.length ?? 0,
		hasClickComparison: () =>
			held?.some((m) => m.type === "engine_custom_frame" && m.expansionChangesRows !== undefined),
	};
	return { runtime, frames };
}

function intercomMessage(text: string): CustomMessage<unknown> {
	const from = {
		id: "peer-1",
		name: "worker-2",
		cwd: "/workspace",
		model: "m",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	return {
		role: "custom",
		customType: "intercom_message",
		content: text,
		display: true,
		details: { from, message: { id: `intercom-${text.length}`, timestamp: 1, content: { text } }, bodyText: text },
		timestamp: 1,
	};
}

/** The main chat of an isolated session: rows the engine draws, in a following transcript, under the real renderer. */
async function mountIsolatedChat(renderers?: Readonly<Record<string, MessageRenderer>>) {
	const { runtime, frames } = isolatedEngine(renderers);
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 60;
	const tui = createFullscreenTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal }) as TuiAltScreen;
	closers.unshift(() => tui.stop());
	let transcript: ScrollView | undefined;
	const chat = new StartupChatContainer(
		() => false,
		() => transcript,
	);
	chat.releaseStartupOutput();
	const document = new WindowedContainer();
	document.addChild(chat);
	transcript = new ScrollView(document, { follow: "end", primary: true });
	const editor = new Text("editor", 0, 0);
	tui.addChild(editor);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editor, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		]),
	);
	tui.setFocus(editor);
	tui.start();
	const requestRender = () => tui.requestRender();
	const bash = (id: string, command: string, output: string) => {
		const row = new RemoteToolExecutionComponent("bash", id, { command }, { outputPad: 1 }, runtime, requestRender);
		row.setArgsComplete();
		row.markExecutionStarted(Date.now());
		// A finished call carries its duration, as the agent loop reports it, so the row reads the same each time.
		row.updateResult({ content: [{ type: "text", text: output }], isError: false, durationMs: 100 });
		chat.addChild(row);
		return row;
	};
	const message = (custom: CustomMessage<unknown>) => {
		const row = new RemoteCustomMessageComponent(custom, runtime, requestRender, 1);
		chat.addChild(row);
		return row;
	};
	const screen = () => {
		tui.renderNow();
		return tui.getScreenLines().map((line) => stripTerminalSequences(line).trimEnd());
	};
	const shows = (pattern: RegExp) => screen().some((line) => pattern.test(line));
	const waitFor = (pattern: RegExp, present = true) =>
		vi.waitFor(() => assert.equal(shows(pattern), present, screen().join("\n")), ENGINE_FRAME_WAIT);
	const rowOf = (pattern: RegExp) => {
		const row = screen().findIndex((line) => pattern.test(line));
		assert.notEqual(row, -1, `no row matches ${pattern}:\n${screen().join("\n")}`);
		return row;
	};
	/** A press and release on `text` in the first row matching `pattern`, which has not settled into a single click yet. */
	const quickClick = (pattern: RegExp, text: string) => {
		const row = rowOf(pattern);
		const column = screen()[row]!.indexOf(text);
		terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
		terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
	};
	/** Lets the multi-click interval pass with no further press, so the clicks so far settle as single clicks. */
	const settle = () => sleep(MULTI_CLICK_INTERVAL_MS + 50);
	/** A single click on `text` in the first row matching `pattern`: no second press follows within the interval. */
	const click = async (pattern: RegExp, text: string) => {
		quickClick(pattern, text);
		await settle();
	};
	return {
		tui,
		transcript,
		frames,
		bash,
		message,
		screen,
		shows,
		waitFor,
		quickClick,
		settle,
		click,
		cancelBlockClicks: () => supersedeBlockClicks(chat),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an isolated renderer sends rows, not its click handler; its block still expands (#5696)", async () => {
	const handleMouse = vi.fn(() => ({ handled: true }));
	const chat = await mountIsolatedChat({
		approval: (_message, { expanded }) => ({
			invalidate() {},
			render: () => ["[ Approve ]", ...(expanded ? ["Approval details"] : [])],
			handleMouse,
		}),
	});
	chat.message({ ...intercomMessage("review"), customType: "approval" });
	await chat.waitFor(/\[ Approve \]/);
	await chat.click(/\[ Approve \]/, "Approve");
	await chat.waitFor(/Approval details/);
	assert.equal(handleMouse.mock.calls.length, 0);
});

test("an isolated row not redrawn since a resize compares at the transcript's settlement width (#5562)", async () => {
	const { runtime } = isolatedEngine();
	const row = new RemoteCustomMessageComponent(
		{ ...intercomMessage("sample"), customType: "responsive" },
		runtime,
		() => {},
		1,
	);
	try {
		await vi.waitFor(() => assert.ok(row.render(105).some((line) => line.includes("Title"))), ENGINE_FRAME_WAIT);
		// The reader scrolled the block out of the window, so the resize did not redraw the block itself.
		toggleClickedBlocks([row], 68, () => {});
		await vi.waitFor(() => assert.ok(row.isExpanded()), ENGINE_FRAME_WAIT);
	} finally {
		row.dispose();
	}
});

test("a click on the expand hint of a tool block the isolated engine draws expands that block alone and presses no key", async () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	closers.push(() => setKeybindings(previous));
	const chat = await mountIsolatedChat();
	const keys: string[] = [];
	closers.push(
		chat.tui.addInputListener((data) => {
			keys.push(data);
			return undefined;
		}),
	);
	chat.bash("first", "first-command", lines(20, "first output"));
	chat.bash("second", "second-command", lines(20, "second output"));
	await chat.waitFor(/second output 20$/);
	await chat.click(/earlier lines.*ctrl\+o/, "ctrl+o");
	await chat.waitFor(/first output 1$/);
	assert.ok(!chat.shows(/second output 1$/), chat.screen().join("\n"));
	assert.equal(keys.filter((data) => matchesKey(data, "ctrl+o")).length, 0, "the hint is the block's own toggle");
});

test("a click on any row of a tool block the isolated engine draws expands it, and a second click collapses it", async () => {
	const chat = await mountIsolatedChat();
	chat.bash("long", "long-command", lines(20, "long output"));
	await chat.waitFor(/long output 20$/);
	assert.ok(!chat.shows(/long output 1$/));

	await chat.click(/long output 18$/, "output");
	await chat.waitFor(/long output 1$/);
	assert.equal(chat.transcript.isFollowingEnd, false, "the expanded block holds the view");

	await chat.click(/long output 3$/, "output");
	await chat.waitFor(/long output 1$/, false);
});

test("fast single clicks on different rows of a block the isolated engine draws each toggle it once they settle", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("long", "long-command", lines(20, "long output"));
	await chat.waitFor(/long output 20$/);

	chat.quickClick(/Bash\(long-command\)/, "long-command");
	await sleep(100);
	chat.quickClick(/long output 18$/, "output");
	await chat.settle();
	// The first click opened the block and the second folds it again.
	await vi.waitFor(() => {
		assert.equal(row.isExpanded(), false);
		assert.equal(chat.shows(/long output 1$/), false, chat.screen().join("\n"));
	}, ENGINE_FRAME_WAIT);
});

test("fast single clicks on a block the isolated engine draws each toggle it, also when the engine draws them only after both settle", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("long", "long-command", lines(20, "long output"));
	await chat.waitFor(/long output 20$/);

	chat.frames.hold();
	chat.quickClick(/Bash\(long-command\)/, "long-command");
	await sleep(100);
	chat.quickClick(/long output 18$/, "output");
	await chat.settle();
	// The engine drew both clicks' rows, which have not reached the host yet.
	await vi.waitFor(() => assert.ok(chat.frames.held() >= 1), ENGINE_FRAME_WAIT);
	await sleep(50);
	chat.frames.release();
	await sleep(100);
	await vi.waitFor(() => {
		assert.equal(row.isExpanded(), false);
		assert.equal(chat.shows(/long output 1$/), false, chat.screen().join("\n"));
	}, ENGINE_FRAME_WAIT);
	assert.equal(chat.transcript.isFollowingEnd, true, "a block opened and folded again does not hold the view");

	chat.frames.hold();
	chat.quickClick(/Bash\(long-command\)/, "long-command");
	await sleep(100);
	chat.quickClick(/long output 18$/, "output");
	await sleep(100);
	chat.quickClick(/long output 19$/, "output");
	await chat.settle();
	await vi.waitFor(() => assert.ok(chat.frames.held() >= 1), ENGINE_FRAME_WAIT);
	await sleep(50);
	chat.frames.release();
	await chat.waitFor(/long output 1$/);
	assert.equal(row.isExpanded(), true, "three clicks leave it open");
	assert.equal(chat.transcript.isFollowingEnd, false, "the opened block holds the view");
});

test("a click on any row of an Intercom message card the isolated engine draws expands it, and a second click collapses it", async () => {
	const chat = await mountIsolatedChat();
	chat.message(intercomMessage(lines(12, "peer line")));
	await chat.waitFor(/Message from worker-2/);
	assert.ok(!chat.shows(/peer line 12$/), chat.screen().join("\n"));

	await chat.click(/… \+9 lines/, "+9");
	await chat.waitFor(/peer line 12$/);

	await chat.click(/peer line 5$/, "peer");
	await chat.waitFor(/peer line 12$/, false);

	await chat.click(/Message from worker-2/, "worker-2");
	await chat.waitFor(/peer line 12$/);
});

test("a single click on changing one-line output keeps following the end (#5562)", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("streaming", "status", "short A");
	await chat.waitFor(/short A$/);
	chat.quickClick(/short A$/, "short");
	chat.frames.hold();
	row.updateResult({ content: [{ type: "text", text: "short B" }], isError: false, durationMs: 100 }, true);
	await chat.settle();
	chat.frames.release();
	await chat.waitFor(/short B$/);
	await vi.waitFor(() => assert.equal(row.isExpanded(), false), ENGINE_FRAME_WAIT);
	assert.equal(chat.transcript.isFollowingEnd, true);
});

test("two clicks waiting on engine frames each use the output at their own settlement (#5562)", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("progress", "status", "short output");
	await chat.waitFor(/short output$/);
	chat.frames.hold();
	await chat.click(/short output$/, "short"); // Nothing to expand yet.
	chat.quickClick(/short output$/, "short");
	row.updateResult({ content: [{ type: "text", text: lines(20, "more") }], isError: false, durationMs: 100 });
	await chat.settle(); // This click now has more rows to show.
	chat.frames.release();
	await chat.waitFor(/more 1$/);
	assert.equal(row.isExpanded(), true);
	assert.equal(chat.transcript.isFollowingEnd, false);
});

test("a running tool's elapsed time changing during a click does not count as extra output (#5562)", async () => {
	const { runtime, frames } = isolatedEngine();
	// Use a live call without a finished duration. Its header advances between the two draws.
	const live = new RemoteToolExecutionComponent("bash", "live", { command: "working" }, {}, runtime, () => {});
	closers.unshift(() => live.dispose());
	live.setArgsComplete();
	live.markExecutionStarted();
	live.updateResult({ content: [{ type: "text", text: "working line" }], isError: false }, true);
	await vi.waitFor(() => assert.ok(live.render(80).some((line) => line.includes("working line"))), ENGINE_FRAME_WAIT);
	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
	let changed = false;
	try {
		frames.hold();
		live.expandByClick(true, () => {
			changed = true;
		});
		await vi.waitFor(() => assert.ok(frames.hasClickComparison()), ENGINE_FRAME_WAIT);
		frames.release();
		assert.equal(changed, false);
		assert.equal(live.isExpanded(), false);
	} finally {
		clock.mockRestore();
	}
});

test("keeping the current global expansion can discard a click already waiting for engine rows (#5562)", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("waiting", "status", lines(20, "output"));
	await chat.waitFor(/Bash\(status\)/);
	chat.frames.hold();
	await chat.click(/Bash\(status\)/, "status");
	await vi.waitFor(() => assert.ok(chat.frames.hasClickComparison()), ENGINE_FRAME_WAIT);
	chat.cancelBlockClicks();
	chat.frames.release();
	assert.equal(row.isExpanded(), false);
	await chat.click(/Bash\(status\)/, "status");
	await chat.waitFor(/output 1$/);
});

for (const length of [1, 20]) {
	test(`a delayed click decision on ${length} output rows cannot undo a later global expansion (#5562)`, async () => {
		const chat = await mountIsolatedChat();
		const row = chat.bash("progress", "status", lines(length, "output"));
		await chat.waitFor(/Bash\(status\)/);
		chat.frames.hold();
		await chat.click(/Bash\(status\)/, "status");
		await vi.waitFor(() => assert.ok(chat.frames.held() > 0), ENGINE_FRAME_WAIT);
		row.setExpanded(true); // Ctrl+O sets this on every row.
		chat.frames.release();
		row.updateResult({ content: [{ type: "text", text: lines(20, "more") }], isError: false, durationMs: 100 });
		await chat.waitFor(/more 20$/);
		assert.ok(chat.shows(/more 1$/));
	});
}

test("an isolated row keeps drawing after its engine exits with a click outstanding (#5562)", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("restart", "status", lines(20, "before"));
	await chat.waitFor(/before 20$/);
	chat.frames.hold();
	await chat.click(/before 20$/, "before");
	await vi.waitFor(() => assert.ok(chat.frames.hasClickComparison()), ENGINE_FRAME_WAIT);
	chat.frames.exit();
	row.updateResult({ content: [{ type: "text", text: lines(20, "after") }], isError: false, durationMs: 100 });
	row.render(100); // A paint while the writer is gone must not use up the update.
	assert.equal(chat.frames.offlineRenders(), 0);
	chat.frames.rebind();
	await chat.waitFor(/after 20$/);
	assert.equal(chat.shows(/after 1$/), false, "the dead engine's click was canceled");
	await chat.click(/after 20$/, "after");
	await chat.waitFor(/after 1$/);
});

test("a click on a block the isolated engine draws with nothing to expand changes nothing and keeps following the end", async () => {
	const chat = await mountIsolatedChat();
	const row = chat.bash("short", "short-command", "only line");
	const card = chat.message(intercomMessage("all of it fits"));
	await chat.waitFor(/all of it fits$/);
	const before = chat.screen();

	await chat.click(/Bash\(short-command\)/, "short");
	await chat.click(/only line$/, "only");
	await chat.click(/all of it fits$/, "fits");
	// The engine's frames for the clicked state arrive and match: each row goes back to its expansion.
	await vi.waitFor(() => {
		assert.equal(row.isExpanded(), false);
		assert.equal(card.isExpanded(), false);
	}, ENGINE_FRAME_WAIT);
	assert.deepEqual(chat.screen(), before);
	assert.equal(chat.transcript.isFollowingEnd, true);
});

test("clicking an Intercom subagent wake notice in the isolated host expands full IDs and collapses back", async () => {
	const chat = await mountIsolatedChat();
	const wake: CustomMessage<unknown> = {
		role: "custom",
		customType: ENDED_CHILD_WAKE_MESSAGE_TYPE,
		content:
			"Resuming subagent `subagent-debugger-45255a2f-7` (45255a2f:6) for an Intercom message from subagent-worker-45255a2f-3. It stays this session's subagent: its result arrives here.",
		display: true,
		details: {
			childName: "subagent-debugger-45255a2f-7",
			childId: "45255a2f:6",
			from: { id: "133acdf4-dc40-4f80-865c-ba1931d0a8cc", name: "subagent-worker-45255a2f-3" },
			depth: 1,
		},
		timestamp: 1,
	};
	const card = chat.message(wake);
	await chat.waitFor(/Woke subagent-debugger-…-7 for a message from subagent-worker-…-3/);
	assert.equal(card.isExpanded(), false);
	assert.equal(chat.shows(/\[intercom_subagent_wake\]/), false);

	await chat.click(/Woke subagent-debugger-…-7/, "Woke");
	await chat.waitFor(/subagent-debugger-45255a2f-7 · 45255a2f:6/);
	assert.equal(card.isExpanded(), true);
	assert.ok(chat.shows(/Result stays with this session and arrives here\./));

	await chat.click(/Result stays with this session/, "Result");
	await vi.waitFor(() => assert.equal(card.isExpanded(), false), ENGINE_FRAME_WAIT);
	await vi.waitFor(
		() => assert.equal(chat.shows(/subagent-debugger-45255a2f-7 · 45255a2f:6/), false),
		ENGINE_FRAME_WAIT,
	);
});

test("deferred startup attachStartupExtensions in place replaces pre-attach fallback boxes on the same runner in isolated host", async () => {
	const bus = createEventBus();
	const runtimeObj = createExtensionRuntime();
	const runner = new ExtensionRunner(
		[],
		runtimeObj,
		"/workspace",
		SessionManager.inMemory("/workspace"),
		new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
	);

	// Isolated engine wired to the real ExtensionRunner (mutated in place by attachStartupExtensions).
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const ended = new Set<(event: { generation: number }) => void>();
	const deliver = (message: InteractiveEngineMessage) => {
		for (const listener of [...listeners]) listener(message);
	};
	setCallbackActivityReporter({ started() {}, finished() {} });
	const service = new EngineRenderService((line) => {
		const parsed = parseInteractiveEngineMessage(line.trim());
		if (parsed) deliver(parsed);
	});
	const session = {
		extensionRunner: runner,
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/workspace" },
	} as unknown as AgentSession;
	service.bindSession(session);
	const isolatedRuntime = {
		getEngineGeneration: () => 1,
		onGenerationEnded(listener: (event: { generation: number }) => void) {
			ended.add(listener);
			return () => ended.delete(listener);
		},
		onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand(command: InteractiveEngineCommand) {
			service.handleLine(serializeInteractiveEngineFrame(command).trim());
		},
	} as unknown as IsolatedInteractiveRuntime;
	closers.push(() => {
		service.dispose();
		setCallbackActivityReporter(undefined);
	});

	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 60;
	const tui = createFullscreenTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal }) as TuiAltScreen;
	closers.unshift(() => tui.stop());
	let transcript: ScrollView | undefined;
	const chatContainer = new StartupChatContainer(
		() => false,
		() => transcript,
	);
	chatContainer.releaseStartupOutput();
	const document = new WindowedContainer();
	document.addChild(chatContainer);
	transcript = new ScrollView(document, { follow: "end", primary: true });
	const editor = new Text("editor", 0, 0);
	tui.addChild(editor);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editor, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		]),
	);
	tui.setFocus(editor);
	tui.start();

	const curatorMsg: CustomMessage<unknown> = {
		role: "custom",
		customType: "curator-config",
		content: [{ type: "text", text: "Curator disabled — web_search will return raw results" }],
		display: true,
		details: { workflow: "none" },
		timestamp: 1,
	};
	const errorMsg: CustomMessage<unknown> = {
		role: "custom",
		customType: "web-search-error",
		content: "Content fetch failed [fetch-abcd]: upstream timeout",
		display: true,
		timestamp: 2,
	};

	const curatorCard = new RemoteCustomMessageComponent(curatorMsg, isolatedRuntime, () => tui.requestRender(), 1);
	const errorCard = new RemoteCustomMessageComponent(errorMsg, isolatedRuntime, () => tui.requestRender(), 1);
	chatContainer.addChild(curatorCard);
	chatContainer.addChild(errorCard);

	const screen = () => {
		tui.renderNow();
		return tui
			.getScreenLines()
			.map((l) => stripTerminalSequences(l).trimEnd())
			.join("\n");
	};

	// 1. Before deferred startup attaches web-access, both cards render through the generic bracketed fallback box.
	await vi.waitFor(() => {
		const text = screen();
		assert.ok(text.includes("[curator-config]"), `expected initial fallback box, got:\n${text}`);
		assert.ok(text.includes("[web-search-error]"), `expected initial fallback box, got:\n${text}`);
	}, ENGINE_FRAME_WAIT);

	// 2. Deferred startup completes IN PLACE on the exact same runner reference (preserveRunner: true).
	const webAccessExt = await loadExtensionFromFactory(
		(pi) => {
			registerWebAccessMessageRenderers(pi);
		},
		"/workspace",
		bus,
		runtimeObj,
		"builtin:web-access",
	);
	const startNewcomers = runner.attachStartupExtensions([webAccessExt]);
	await startNewcomers();

	// 3. Both already-rendered cards automatically repaint to styled notice cards (NO Ctrl+O required).
	await vi.waitFor(() => {
		const text = screen();
		assert.ok(text.includes("Search curator disabled"), `curator card stayed stuck:\n${text}`);
		assert.ok(text.includes("Web content fetch failed"), `error card stayed stuck:\n${text}`);
		assert.equal(text.includes("[curator-config]"), false, `stale [curator-config] remained:\n${text}`);
		assert.equal(text.includes("[web-search-error]"), false, `stale [web-search-error] remained:\n${text}`);
	}, ENGINE_FRAME_WAIT);

	// 4. Ctrl+O expands the repainted cards cleanly to full wrapped text.
	curatorCard.setExpanded(true);
	errorCard.setExpanded(true);
	tui.requestRender();
	await vi.waitFor(() => {
		const text = screen();
		assert.ok(
			text.includes("Curator disabled — web_search will return raw results"),
			`expanded curator missing:\n${text}`,
		);
		assert.ok(text.includes("Fetch ID · fetch-abcd"), `expanded error missing Fetch ID:\n${text}`);
		assert.ok(text.includes("upstream timeout"), `expanded error missing reason:\n${text}`);
	}, ENGINE_FRAME_WAIT);
});

test("attachStartupExtensions and engine_resources_ready invalidate only records whose resolved renderer changed (0 spurious disposals/rerenders)", async () => {
	const runCase = async (changedCustomRows: number) => {
		const bus = createEventBus();
		const runtimeObj = createExtensionRuntime();
		let thirdPartyPi: ExtensionAPI | undefined;
		const existingExt = await loadExtensionFromFactory(
			(pi) => {
				thirdPartyPi = pi;
			},
			"/workspace",
			bus,
			runtimeObj,
			"/workspace/third-party.ts",
		);
		const runner = new ExtensionRunner(
			[existingExt],
			runtimeObj,
			"/workspace",
			SessionManager.inMemory("/workspace"),
			new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
		);

		const listeners = new Set<(message: InteractiveEngineMessage) => void>();
		const deliver = (message: InteractiveEngineMessage) => {
			for (const listener of [...listeners]) listener(message);
		};
		let phase: "initial" | "post_attach" | "runtime_reg" | "teardown" = "initial";
		let initialFrames = 0;
		let postDisposals = 0;
		let postInvalidates = 0;
		let postToolCmds = 0;
		let postUnchangedMsgCmds = 0;
		let postChangedMsgCmds = 0;
		let postFrames = 0;
		let postRequestRenders = 0;
		let runtimeRegDisposals = 0;
		let runtimeRegInvalidates = 0;
		let runtimeRegCmds = 0;

		setCallbackActivityReporter({ started() {}, finished() {} });
		const service = new EngineRenderService((line) => {
			const parsed = parseInteractiveEngineMessage(line.trim());
			if (!parsed) return;
			if (phase === "initial" && parsed.type === "engine_custom_frame") initialFrames++;
			if (phase === "post_attach") {
				if (parsed.type === "engine_custom_invalidate") postInvalidates++;
				if (parsed.type === "engine_custom_frame") postFrames++;
			}
			if (phase === "runtime_reg" && parsed.type === "engine_custom_invalidate") runtimeRegInvalidates++;
			deliver(parsed);
		});
		const internalService = service as unknown as {
			records: Map<string, unknown>;
			disposeRecord: (id: string) => void;
		};
		const origDispose = internalService.disposeRecord.bind(service);
		internalService.disposeRecord = (id: string) => {
			if (internalService.records.has(id)) {
				if (phase === "post_attach") postDisposals++;
				if (phase === "runtime_reg") runtimeRegDisposals++;
			}
			origDispose(id);
		};

		const session = {
			extensionRunner: runner,
			getToolDefinition: () => undefined,
			sessionManager: { getCwd: () => "/workspace", getSessionId: () => `sess-${changedCustomRows}` },
		} as unknown as AgentSession;
		service.bindSession(session);

		const isolatedRuntime = {
			session,
			getEngineGeneration: () => 1,
			onGenerationEnded: () => () => {},
			onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			sendEngineCommand(command: InteractiveEngineCommand) {
				if (phase === "post_attach") {
					if (command.type === "engine_tool_render") postToolCmds++;
					else if (command.type === "engine_message_render") {
						if (command.message.customType === "web-search-error") postChangedMsgCmds++;
						else postUnchangedMsgCmds++;
					}
				} else if (phase === "runtime_reg") {
					if (command.type === "engine_tool_render" || command.type === "engine_message_render") {
						runtimeRegCmds++;
					}
				}
				service.handleLine(serializeInteractiveEngineFrame(command).trim());
			},
		} as unknown as IsolatedInteractiveRuntime;

		const rows: Array<RemoteToolExecutionComponent | RemoteCustomMessageComponent> = [];
		let scheduled = false;
		const requestRender = () => {
			if (phase === "post_attach") postRequestRenders++;
			if (!scheduled) {
				scheduled = true;
				queueMicrotask(() => {
					scheduled = false;
					for (const row of rows) row.render(100);
				});
			}
		};

		for (let i = 0; i < 10; i++) {
			const tool = new RemoteToolExecutionComponent(
				"read",
				`tc-${i}`,
				{ path: `/workspace/f${i}.ts` },
				{ showImages: false, imageWidthCells: 0, outputPad: 1 },
				isolatedRuntime,
				requestRender,
			);
			tool.updateResult({ content: [{ type: "text", text: `line ${i}` }], details: {} }, false);
			rows.push(tool);
		}
		for (let i = 0; i < 10; i++) {
			rows.push(
				new RemoteCustomMessageComponent(
					{ role: "custom", customType: "third-party-note", content: `Note ${i}`, display: true, timestamp: i },
					isolatedRuntime,
					requestRender,
					1,
				),
			);
		}
		const changedCards: RemoteCustomMessageComponent[] = [];
		for (let i = 0; i < changedCustomRows; i++) {
			const card = new RemoteCustomMessageComponent(
				{
					role: "custom",
					customType: "web-search-error",
					content: `Content fetch failed [f${i}]: timeout`,
					display: true,
					timestamp: 100 + i,
				},
				isolatedRuntime,
				requestRender,
				1,
			);
			rows.push(card);
			changedCards.push(card);
		}

		for (const row of rows) row.render(100);
		await vi.waitFor(() => assert.ok(initialFrames >= rows.length), ENGINE_FRAME_WAIT);
		// Wait for any initial settled tool repaint checks to drain before switching to post_attach.
		for (let i = 0; i < 10; i++) {
			const before = initialFrames;
			await new Promise((r) => setTimeout(r, 30));
			if (initialFrames === before) break;
		}

		phase = "post_attach";
		const subagentsExt = await loadExtensionFromFactory(
			(pi) => {
				for (const t of ["subagent-notify", "subagent-resume-note"]) {
					pi.registerMessageRenderer(t, () => null);
				}
			},
			"/workspace",
			bus,
			runtimeObj,
			"builtin:subagents",
		);
		const webExt = await loadExtensionFromFactory(
			(pi) => {
				registerWebAccessMessageRenderers(pi);
			},
			"/workspace",
			bus,
			runtimeObj,
			"builtin:web-access",
		);
		const startNewcomers = runner.attachStartupExtensions([subagentsExt, webExt]);
		await startNewcomers();
		deliver({ type: "engine_resources_ready" });

		if (changedCustomRows > 0) {
			await vi.waitFor(() => assert.equal(postFrames, changedCustomRows), ENGINE_FRAME_WAIT);
		}
		await new Promise((r) => setTimeout(r, 80));

		const changedRendered = changedCards.map((card) =>
			card
				.render(100)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		);

		// Runtime third-party registerMessageRenderer must NOT dispose/invalidate anything (parity with main).
		phase = "runtime_reg";
		thirdPartyPi!.registerMessageRenderer("late-type", () => new Text("LATE_OK", 0, 0));
		await new Promise((r) => setTimeout(r, 80));

		phase = "teardown";
		for (const row of rows) row.dispose();
		service.dispose();
		setCallbackActivityReporter(undefined);
		return {
			postDisposals,
			postInvalidates,
			postToolCmds,
			postUnchangedMsgCmds,
			postChangedMsgCmds,
			postFrames,
			postRequestRenders,
			changedRendered,
			runtimeRegDisposals,
			runtimeRegInvalidates,
			runtimeRegCmds,
		};
	};

	const zero = await runCase(0);
	assert.equal(zero.postDisposals, 0, "0 changed rows must produce 0 disposals");
	assert.equal(zero.postInvalidates, 0, "0 changed rows must produce 0 invalidates");
	assert.equal(zero.postToolCmds, 0, "0 changed rows must produce 0 tool renders");
	assert.equal(zero.postUnchangedMsgCmds, 0, "0 changed rows must produce 0 unchanged message renders");
	assert.equal(zero.postFrames, 0, "0 changed rows must produce 0 frames");
	assert.equal(zero.postRequestRenders, 0, "0 changed rows must produce 0 host requestRenders");
	assert.equal(zero.runtimeRegDisposals, 0, "runtime 3P reg must produce 0 disposals");
	assert.equal(zero.runtimeRegInvalidates, 0, "runtime 3P reg must produce 0 invalidates");
	assert.equal(zero.runtimeRegCmds, 0, "runtime 3P reg must produce 0 render commands");

	const two = await runCase(2);
	assert.equal(two.postDisposals, 2, "only the 2 changed rows may be disposed");
	assert.equal(two.postInvalidates, 2, "only the 2 changed rows may be invalidated");
	assert.equal(two.postToolCmds, 0, "unrelated tools must not re-render");
	assert.equal(two.postUnchangedMsgCmds, 0, "unrelated custom messages must not re-render");
	assert.equal(two.postChangedMsgCmds, 2, "only the 2 changed custom messages may re-render");
	assert.equal(two.postFrames, 2, "only 2 frames may be emitted");
	for (const rendered of two.changedRendered) {
		assert.ok(rendered.includes("Web content fetch failed"), `expected repainted card, got:\n${rendered}`);
		assert.equal(rendered.includes("[web-search-error]"), false);
	}
});

test("InteractiveMode.stop() unsubscribes its renderer watcher so a stopped mode is collectable", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-mode-stop-gc-"));
	const cwd = join(root, "proj");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const makeSessionRuntime = async () => {
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		return createAgentSessionRuntime(
			async (runtimeOptions) => {
				const services = await createAgentSessionServices({
					cwd: runtimeOptions.cwd,
					agentDir: runtimeOptions.agentDir,
					modelRuntime,
					resourceLoaderOptions: {
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						extensionFactories: [],
					},
				});
				const created = await createAgentSessionFromServices({
					services,
					sessionManager: runtimeOptions.sessionManager,
					builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
				});
				return { ...created, services, diagnostics: services.diagnostics };
			},
			{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		);
	};
	try {
		const tracked = trackCollection();
		await (async () => {
			const runtime = await makeSessionRuntime();
			const runnerRef = runtime.session.extensionRunner;
			const mode = new InteractiveMode(runtime, { terminal: new RecordingTerminal(80, 24) });
			tracked.track(mode);
			mode.ensureManagedToolsReady = async () => {};
			await mode.init();
			const listenersBeforeStop = (runnerRef as unknown as { rendererChangeListeners?: Set<unknown> })
				.rendererChangeListeners?.size;
			assert.equal(listenersBeforeStop, 1, "active in-process mode should register 1 renderer watcher");
			mode.stop();
			const listenersAfterStop = (runnerRef as unknown as { rendererChangeListeners?: Set<unknown> })
				.rendererChangeListeners?.size;
			assert.equal(listenersAfterStop, 0, "mode.stop() must unsubscribe its renderer watcher before dispose");
			await runtime.dispose();
		})();
		// Overwrite process-global single-slot UI sinks installed by InteractiveMode.init() (theme/diagnostic sinks).
		await (async () => {
			const runtime2 = await makeSessionRuntime();
			const mode2 = new InteractiveMode(runtime2, { terminal: new RecordingTerminal(80, 24) });
			mode2.ensureManagedToolsReady = async () => {};
			await mode2.init();
			mode2.stop();
			await runtime2.dispose();
		})();
		stopThemeWatcher();
		onThemeChange(() => {});
		await collectEverythingTracked(tracked, 100);
		assert.equal(tracked.collected(), 1, "stopped InteractiveMode must be garbage-collectable");

		// Also verify stopRendererWatch releases all references from a STILL-LIVE unrevoked ExtensionRunner,
		// and StartupChatContainer indexed refresh does not probe foreign widget `.children` getters.
		const liveRunner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			cwd,
			SessionManager.inMemory(cwd),
			new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
		);
		const trackedLive = trackCollection();
		let foreignReads = 0;
		const chat = new StartupChatContainer();
		const foreignWidget = {
			invalidate() {},
			render: () => ["widget"],
			get children() {
				foreignReads += 1;
				throw new Error("foreign widget children getter must not be probed");
			},
		};
		chat.addChild(foreignWidget);
		chat.addChild(
			new CustomMessageComponent(
				{ role: "custom", customType: "unrelated", content: "hi", display: true, timestamp: 1 },
				undefined,
			),
		);
		const sessionStub = { extensionRunner: liveRunner } as unknown as AgentSession;
		await (async () => {
			const fakeMode = {
				isShuttingDown: false,
				session: sessionStub,
				chatContainer: chat,
				runtimeHost: undefined,
				ui: { requestRender() {} },
			} as unknown as InteractiveMode;
			trackedLive.track(fakeMode);
			watchSessionRenderers(fakeMode, sessionStub, liveRunner);
			const ext = await loadExtensionFromFactory(
				(pi) => {
					registerWebAccessMessageRenderers(pi);
				},
				cwd,
				createEventBus(),
				createExtensionRuntime(),
				"builtin:web-access",
			);
			const start = liveRunner.attachStartupExtensions([ext]);
			await start();
			assert.equal(foreignReads, 0, "in-process refresh must not probe foreign widget .children getters");
			stopRendererWatch(fakeMode);
		})();
		await collectEverythingTracked(trackedLive, 100);
		assert.equal(trackedLive.collected(), 1, "stopped mode must be collectable while its ExtensionRunner stays live");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EngineRenderService resolves distinct tool names once, keeps fresh-closure resolvers stable, detects renderShell, clears watchedRunner on revokeAuthority, and evicts all collapsed/expanded recentFrames", async () => {
	const bus = createEventBus();
	const runtimeObj = createExtensionRuntime();
	let freshResolverCalls = 0;
	const existingExt = await loadExtensionFromFactory(
		(pi) => {
			pi.registerToolRenderer((toolName, next) => {
				freshResolverCalls += 1;
				if (toolName === "contact_supervisor") {
					return {
						renderCall: () => new Text("SUP_CALL", 0, 0),
						renderResult: () => new Text("SUP_RES", 0, 0),
					};
				}
				return next();
			});
		},
		"/workspace",
		bus,
		runtimeObj,
		"builtin:intercom",
	);
	const runner = new ExtensionRunner(
		[existingExt],
		runtimeObj,
		"/workspace",
		SessionManager.inMemory("/workspace"),
		new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
	);

	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const deliver = (message: InteractiveEngineMessage) => {
		for (const listener of [...listeners]) listener(message);
	};
	let phase: "initial" | "attach_unrelated" | "attach_rendershell" | "teardown" = "initial";
	let initialFrames = 0;
	const disposedByPhase: Record<string, number> = { attach_unrelated: 0, attach_rendershell: 0 };
	const invalidatedByPhase: Record<string, number> = { attach_unrelated: 0, attach_rendershell: 0 };
	const renderedByPhase: Record<string, string[]> = { attach_unrelated: [], attach_rendershell: [] };

	setCallbackActivityReporter({ started() {}, finished() {} });
	const service = new EngineRenderService((line) => {
		const parsed = parseInteractiveEngineMessage(line.trim());
		if (!parsed) return;
		if (phase === "initial" && parsed.type === "engine_custom_frame") initialFrames++;
		if (parsed.type === "engine_custom_invalidate" && phase in invalidatedByPhase) {
			invalidatedByPhase[phase]! += 1;
		}
		deliver(parsed);
	});
	const internalService = service as unknown as {
		records: Map<string, unknown>;
		watchedRunner: unknown;
		disposeRecord: (id: string) => void;
	};
	const origDispose = internalService.disposeRecord.bind(service);
	internalService.disposeRecord = (id: string) => {
		if (internalService.records.has(id) && phase in disposedByPhase) {
			disposedByPhase[phase]! += 1;
		}
		origDispose(id);
	};
	const session = {
		extensionRunner: runner,
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/workspace", getSessionId: () => "sess-tool-exact" },
	} as unknown as AgentSession;
	service.bindSession(session);
	const isolatedRuntime = {
		session,
		getEngineGeneration: () => 1,
		onGenerationEnded: () => () => {},
		onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand(command: InteractiveEngineCommand) {
			if (phase in renderedByPhase) {
				if (command.type === "engine_tool_render") renderedByPhase[phase]!.push(command.toolName);
				else if (command.type === "engine_message_render") renderedByPhase[phase]!.push(command.message.customType);
			}
			service.handleLine(serializeInteractiveEngineFrame(command).trim());
		},
	} as unknown as IsolatedInteractiveRuntime;

	const rows: Array<RemoteToolExecutionComponent | RemoteCustomMessageComponent> = [];
	let scheduled = false;
	const requestRender = () => {
		if (!scheduled) {
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				for (const row of rows) row.render(100);
			});
		}
	};

	// 25 read tools + 1 contact_supervisor (fresh-closure resolver) + 1 custom_shell_tool + 1 web-search-error
	for (let i = 0; i < 25; i++) {
		const t = new RemoteToolExecutionComponent(
			"read",
			`read-${i}`,
			{ path: `/workspace/f${i}.ts` },
			{ showImages: false, imageWidthCells: 0, outputPad: 1 },
			isolatedRuntime,
			requestRender,
		);
		t.updateResult({ content: [{ type: "text", text: "ok" }], details: {} }, false);
		rows.push(t);
	}
	const supTool = new RemoteToolExecutionComponent(
		"contact_supervisor",
		"sup-1",
		{ reason: "progress_update" },
		{ showImages: false, imageWidthCells: 0, outputPad: 1 },
		isolatedRuntime,
		requestRender,
	);
	supTool.updateResult({ content: [{ type: "text", text: "ok" }], details: {} }, false);
	rows.push(supTool);
	const shellTool = new RemoteToolExecutionComponent(
		"custom_shell_tool",
		"sh-1",
		{},
		{ showImages: false, imageWidthCells: 0, outputPad: 1 },
		isolatedRuntime,
		requestRender,
	);
	shellTool.updateResult({ content: [{ type: "text", text: "ok" }], details: {} }, false);
	rows.push(shellTool);
	const errMsg: CustomMessage<unknown> = {
		role: "custom",
		customType: "web-search-error",
		content: "Content fetch failed [f9]: timeout",
		display: true,
		timestamp: 9,
	};
	const errCard = new RemoteCustomMessageComponent(errMsg, isolatedRuntime, requestRender, 1);
	rows.push(errCard);

	for (const row of rows) row.render(100);
	await vi.waitFor(() => assert.ok(initialFrames >= rows.length), ENGINE_FRAME_WAIT);
	// Render errCard expanded too so BOTH collapsed AND expanded fallback frames enter recentFrames!
	errCard.setExpanded(true);
	errCard.render(100);
	for (let i = 0; i < 10; i++) {
		const before = initialFrames;
		await new Promise((r) => setTimeout(r, 25));
		if (initialFrames === before) break;
	}

	// 1. Attach an unrelated dormant lazy builtin that calls registerToolRenderer (delegating to next()) + web-access message renderers.
	phase = "attach_unrelated";
	const callsBeforeAttach = freshResolverCalls;
	const unrelatedExt = await loadExtensionFromFactory(
		(pi) => {
			pi.registerToolRenderer((_toolName, next) => next());
			registerWebAccessMessageRenderers(pi);
		},
		"/workspace",
		bus,
		runtimeObj,
		"builtin:web-access",
	);
	const start1 = runner.attachStartupExtensions([unrelatedExt]);
	await start1();
	await new Promise((r) => setTimeout(r, 80));

	// Only 3 distinct tool names (read, contact_supervisor, custom_shell_tool) should be resolved (NOT 27!),
	// and ZERO tools (including fresh-closure contact_supervisor) may be disposed or re-rendered!
	assert.equal(
		freshResolverCalls - callsBeforeAttach,
		3,
		`expected 1 resolver call per distinct tool name (3), got ${freshResolverCalls - callsBeforeAttach}`,
	);
	assert.equal(disposedByPhase.attach_unrelated, 1, "only the 1 web-search-error row may be disposed");
	assert.equal(invalidatedByPhase.attach_unrelated, 1, "only the 1 web-search-error row may be invalidated");
	assert.deepEqual(renderedByPhase.attach_unrelated, ["web-search-error"]);

	// Rebuilding a fresh collapsed RemoteCustomMessageComponent for errMsg must NOT synchronously paint stale "[web-search-error]"!
	const rebuiltCollapsed = new RemoteCustomMessageComponent(errMsg, isolatedRuntime, () => {}, 1);
	const syncFirstPaint = rebuiltCollapsed
		.render(100)
		.map((l) => stripTerminalSequences(l))
		.join("\n");
	assert.equal(
		syncFirstPaint.includes("[web-search-error]"),
		false,
		`stale collapsed fallback leaked from recentFrames:\n${syncFirstPaint}`,
	);
	rebuiltCollapsed.dispose();

	// 2. Attach an extension whose tool renderer returns `{ renderShell: "self" }` for custom_shell_tool: ONLY custom_shell_tool invalidates!
	phase = "attach_rendershell";
	const shellExt = await loadExtensionFromFactory(
		(pi) => {
			pi.registerToolRenderer((toolName, next) =>
				toolName === "custom_shell_tool" ? { renderShell: "self" } : next(),
			);
		},
		"/workspace",
		bus,
		runtimeObj,
		"inline:shell",
	);
	const start2 = runner.attachStartupExtensions([shellExt]);
	await start2();
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(disposedByPhase.attach_rendershell, 1, "only custom_shell_tool may be disposed for renderShell change");
	assert.deepEqual(renderedByPhase.attach_rendershell, ["custom_shell_tool"]);

	// 3. Revoking runner authority (e.g. /reload) immediately clears EngineRenderService.watchedRunner!
	assert.equal(internalService.watchedRunner, runner);
	runner.revokeAuthority();
	assert.equal(
		internalService.watchedRunner,
		undefined,
		"revokeAuthority must clear EngineRenderService.watchedRunner",
	);

	phase = "teardown";
	for (const row of rows) row.dispose();
	service.dispose();
	setCallbackActivityReporter(undefined);
});

test("real AgentSession read/bash tools see 0 disposals or invalidates across preserveRunner _buildRuntime + attachStartupExtensions", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-real-session-tools-"));
	const cwd = join(root, "proj");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	try {
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [],
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		const session = created.session;
		const listeners = new Set<(message: InteractiveEngineMessage) => void>();
		const deliver = (message: InteractiveEngineMessage) => {
			for (const listener of [...listeners]) listener(message);
		};
		let phase: "initial" | "post" | "teardown" = "initial";
		let initialFrames = 0;
		let postDisposals = 0;
		let postInvalidates = 0;
		const postCmds: string[] = [];

		setCallbackActivityReporter({ started() {}, finished() {} });
		const service = new EngineRenderService((line) => {
			const parsed = parseInteractiveEngineMessage(line.trim());
			if (!parsed) return;
			if (phase === "initial" && parsed.type === "engine_custom_frame") initialFrames++;
			if (phase === "post" && parsed.type === "engine_custom_invalidate") postInvalidates++;
			deliver(parsed);
		});
		const internalService = service as unknown as {
			records: Map<string, unknown>;
			disposeRecord: (id: string) => void;
		};
		const origDispose = internalService.disposeRecord.bind(service);
		internalService.disposeRecord = (id: string) => {
			if (phase === "post" && internalService.records.has(id)) postDisposals++;
			origDispose(id);
		};
		service.bindSession(session);
		const isolatedRuntime = {
			session,
			getEngineGeneration: () => 1,
			onGenerationEnded: () => () => {},
			onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			sendEngineCommand(command: InteractiveEngineCommand) {
				if (
					phase === "post" &&
					(command.type === "engine_tool_render" || command.type === "engine_message_render")
				) {
					postCmds.push(command.type === "engine_tool_render" ? command.toolName : command.message.customType);
				}
				service.handleLine(serializeInteractiveEngineFrame(command).trim());
			},
		} as unknown as IsolatedInteractiveRuntime;

		const rows: Array<RemoteToolExecutionComponent | RemoteCustomMessageComponent> = [];
		let scheduled = false;
		const requestRender = () => {
			if (!scheduled) {
				scheduled = true;
				queueMicrotask(() => {
					scheduled = false;
					for (const row of rows) row.render(100);
				});
			}
		};
		for (let i = 0; i < 5; i++) {
			const rTool = new RemoteToolExecutionComponent(
				"read",
				`r-${i}`,
				{ path: `/workspace/f${i}.ts` },
				{ showImages: false, imageWidthCells: 0, outputPad: 1 },
				isolatedRuntime,
				requestRender,
			);
			rTool.updateResult({ content: [{ type: "text", text: "ok" }], details: {} }, false);
			rows.push(rTool);
			const bTool = new RemoteToolExecutionComponent(
				"bash",
				`b-${i}`,
				{ command: "echo hi" },
				{ showImages: false, imageWidthCells: 0, outputPad: 1 },
				isolatedRuntime,
				requestRender,
			);
			bTool.updateResult({ content: [{ type: "text", text: "hi" }], details: {} }, false);
			rows.push(bTool);
		}
		for (const row of rows) row.render(100);
		await vi.waitFor(() => assert.ok(initialFrames >= rows.length), ENGINE_FRAME_WAIT);
		for (let i = 0; i < 10; i++) {
			const before = initialFrames;
			await new Promise((r) => setTimeout(r, 25));
			if (initialFrames === before) break;
		}

		// Real deferred startup sequence: attachStartupExtensions([lazyWebAccess]) + _buildRuntime({ preserveRunner: true }) + startNewcomers()
		phase = "post";
		const ext = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolRenderer((_name, next) => next());
				registerWebAccessMessageRenderers(pi);
			},
			cwd,
			createEventBus(),
			createExtensionRuntime(),
			"builtin:web-access",
		);
		const startNewcomers = session.extensionRunner.attachStartupExtensions([ext]);
		(
			session as unknown as {
				_buildRuntime: (opts: {
					includeAllExtensionTools: boolean;
					preserveRunner: boolean;
					powerShellAvailable: boolean;
				}) => void;
			}
		)._buildRuntime({
			includeAllExtensionTools: true,
			preserveRunner: true,
			powerShellAvailable: false,
		});
		await startNewcomers();
		await new Promise((r) => setTimeout(r, 80));

		assert.equal(postDisposals, 0, "real AgentSession read/bash tools must not be disposed on preserveRunner attach");
		assert.equal(postInvalidates, 0, "real AgentSession read/bash tools must not be invalidated");
		assert.deepEqual(postCmds, []);

		phase = "teardown";
		for (const row of rows) row.dispose();
		service.dispose();
		setCallbackActivityReporter(undefined);
		await session.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
