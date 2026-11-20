import assert from "node:assert/strict";
import { Text } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { FIRST_FRAME_TIMEOUT_MS } from "../src/modes/interactive/agent-view/remote-port.ts";
import { holdTranscriptDock } from "../src/modes/interactive/agent-view/transcript-slot.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { holdPromptSlot, PROMPT_SLOT_HOLD_MS } from "../src/modes/interactive/components/prompt-slot.ts";
import { screenHoldOf } from "../src/modes/interactive/screen-hold.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { type MainChatTerminal, startMainChat } from "./helpers/main-chat-terminal.js";

/**
 * A slash command that opens a view, drawn on a terminal by the real interactive mode on both hosts: every frame the
 * terminal shows between Enter and the view still shows the typed command, never the bare prompt or an empty view.
 * Frames are rebuilt from the bytes written, one per synchronized update.
 */

/** The real interactive mode starts, and the isolated host starts its engine, once per case. */
const INTERACTIVE_CASE_TIMEOUT_MS = 90_000;

interface Write {
	readonly terminal: VirtualTerminal;
	readonly at: number;
	readonly data: string;
}

const chats: MainChatTerminal[] = [];
let writes: Write[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	vi.restoreAllMocks();
	while (chats.length > 0) await chats.pop()?.stop();
	writes = [];
});

async function start(host: "in-process" | "isolated"): Promise<MainChatTerminal> {
	const write = VirtualTerminal.prototype.write;
	vi.spyOn(VirtualTerminal.prototype, "write").mockImplementation(function (this: VirtualTerminal, data: string) {
		writes.push({ terminal: this, at: performance.now(), data });
		write.call(this, data);
	});
	const chat = await startMainChat(host, { engineUi: true });
	chats.push(chat);
	await chat.settled(/❯/);
	return chat;
}

/** The screens the terminal showed after each frame written from `from` on, and when each was written. */
async function screens(chat: MainChatTerminal, from: number): Promise<Array<{ at: number; text: string }>> {
	const written = writes.filter((write) => write.terminal === chat.terminal);
	vi.restoreAllMocks();
	const replay = new VirtualTerminal(chat.terminal.columns, chat.terminal.rows);
	const shown: Array<{ at: number; text: string }> = [];
	let synchronized = false;
	for (const [index, write] of written.entries()) {
		replay.write(write.data);
		const begin = write.data.lastIndexOf("\x1b[?2026h");
		const end = write.data.lastIndexOf("\x1b[?2026l");
		if (begin !== end) synchronized = begin > end;
		if (synchronized || index < from) continue;
		shown.push({ at: write.at, text: (await replay.flushAndGetViewport()).join("\n") });
	}
	return shown;
}

/** Enter, as a terminal delivers it: in its own turn of the event loop. */
async function pressEnter(chat: MainChatTerminal): Promise<{ from: number; at: number }> {
	return new Promise((resolve) =>
		setImmediate(() => {
			const from = writes.filter((write) => write.terminal === chat.terminal).length;
			const at = performance.now();
			chat.press("\r");
			resolve({ from, at });
		}),
	);
}

/** Run `command` and check every frame up to its view: each still shows the typed command, or shows the view. */
async function expectStraightToView(chat: MainChatTerminal, command: string, view: RegExp): Promise<void> {
	const typed = new RegExp(`❯ ${command.replace("/", "\\/")}`);
	chat.press(command);
	await chat.settled(typed);
	const enter = await pressEnter(chat);
	await chat.settled(view);
	const frames = await screens(chat, enter.from);
	assert.ok(
		frames.some((frame) => view.test(frame.text)),
		"the view was never drawn",
	);
	for (const frame of frames) {
		if (view.test(frame.text)) return;
		// Past the bound the prompt's slot shows what it holds, as before.
		if (frame.at - enter.at > PROMPT_SLOT_HOLD_MS) return;
		assert.match(frame.text, typed, `a frame between ${command} and its view:\n${frame.text}`);
	}
}

async function finishOneTurn(chat: MainChatTerminal): Promise<void> {
	chat.press("hello");
	chat.press("\r");
	await chat.gate.entered.promise;
	chat.gate.release.resolve();
	await chat.settled(/answer 2/);
}

describe.each(["in-process", "isolated"] as const)("a slash command that opens a view (%s host)", (host) => {
	test(
		"/model goes from the typed command straight to the model selector",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/model", /Select model/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/tree goes from the typed command straight to the session tree",
		async () => {
			const chat = await start(host);
			await finishOneTurn(chat);
			await expectStraightToView(chat, "/tree", /Session tree/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/resume goes from the typed command straight to the listed sessions",
		async () => {
			const chat = await start(host);
			await finishOneTurn(chat);
			await expectStraightToView(chat, "/resume", /Sessions \(\d+\)/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"a prompt that draws a run's working status in its border never shows it after the run has ended",
		async () => {
			const chat = await start(host);
			chat.mode.setCustomEditorComponent(
				(tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }),
			);
			chat.mode.showWorkingLoaderNow();
			const status = /^── ∀ /m;
			await chat.settled(status);
			chat.press("/model");
			await chat.settled(/❯ \/model/);
			// Enter, then the run ends in the same turn of the event loop, before the selector mounts.
			const from = await new Promise<number>((resolve) =>
				setImmediate(() => {
					const written = writes.filter((write) => write.terminal === chat.terminal).length;
					chat.press("\r");
					chat.mode.stopWorkingLoader();
					resolve(written);
				}),
			);
			await chat.settled(/Select model/);
			for (const frame of await screens(chat, from))
				assert.doesNotMatch(frame.text, status, `a frame shows the ended run's status:\n${frame.text}`);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"a key that ends a held prompt or dock still reaches the prompt, and a scroll key still scrolls",
		async () => {
			const chat = await start(host);
			for (let line = 1; line <= 60; line++) chat.mode.chatContainer.addChild(new Text(`filler ${line}`, 0, 0));
			chat.mode.ui.requestRender();
			await chat.settled(/filler 60/);
			const screenHold = screenHoldOf(chat.mode);
			const scroll = chat.mode.transcriptScrollView;
			assert.ok(scroll);
			const hold = {
				prompt: () => holdPromptSlot(chat.mode.editorContainer),
				dock: () => holdTranscriptDock(chat.mode, FIRST_FRAME_TIMEOUT_MS),
			};
			for (const region of ["prompt", "dock"] as const) {
				hold[region]();
				assert.equal(screenHold.region, region);
				chat.press("x");
				assert.equal(screenHold.region, undefined, `the key ends the held ${region}`);
				assert.equal(chat.mode.editor.getText(), "x", `the key that ended the held ${region} reached the prompt`);
				chat.mode.editor.setText("");
				await chat.settled(/filler 60/);

				hold[region]();
				assert.equal(screenHold.region, region);
				const top = scroll.scrollTop;
				chat.press("\x1b[5~");
				assert.equal(screenHold.region, undefined, `PageUp ends the held ${region}`);
				await chat.settled();
				assert.ok(
					scroll.scrollTop < top,
					`PageUp that ended the held ${region} scrolled: ${top} -> ${scroll.scrollTop}`,
				);
				scroll.scrollToEnd();
				chat.mode.ui.requestRender();
				await chat.settled(/filler 60/);
			}
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/tasks goes from the typed command straight to the drawn task panel",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/tasks", /No background work/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);
});
