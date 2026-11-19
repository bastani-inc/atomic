import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
	MULTI_CLICK_INTERVAL_MS,
	ScrollView,
	stripTerminalSequences,
	Text,
	type TuiAltScreen,
	VStack,
	WindowedContainer,
} from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { renderIntercomCustomMessage } from "../../intercom/ui/inline-message.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { setCallbackActivityReporter } from "../src/core/callback-activity.js";
import type { MessageRenderer } from "../src/core/extensions/types.js";
import type { CustomMessage } from "../src/core/messages.js";
import {
	supersedeBlockClicks,
	toggleClickedBlocks,
} from "../src/modes/interactive/components/transcript-block-clicks.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
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
