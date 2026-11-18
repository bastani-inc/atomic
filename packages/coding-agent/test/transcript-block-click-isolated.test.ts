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
import type { CustomMessage } from "../src/core/messages.js";
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

/** The isolated engine's render service behind an in-memory transport, with the Intercom message renderer loaded. */
function isolatedEngine() {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	setCallbackActivityReporter({ started() {}, finished() {} });
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (message) for (const listener of [...listeners]) listener(message);
	});
	service.bindSession({
		extensionRunner: {
			resolveToolRenderers: () => undefined,
			getMessageRenderer: (customType: string) =>
				customType === "intercom_message" ? renderIntercomCustomMessage : undefined,
		},
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/workspace" },
	} as unknown as AgentSession);
	const runtime = {
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
	return runtime;
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
async function mountIsolatedChat() {
	const runtime = isolatedEngine();
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
	/** A single click on `text` in the first row matching `pattern`: no second press follows within the interval. */
	const click = async (pattern: RegExp, text: string) => {
		const row = rowOf(pattern);
		const column = screen()[row]!.indexOf(text);
		terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
		terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
		await new Promise((resolve) => setTimeout(resolve, MULTI_CLICK_INTERVAL_MS + 50));
	};
	return { transcript, bash, message, screen, shows, waitFor, click };
}

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
