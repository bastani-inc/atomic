import assert from "node:assert/strict";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { PROMPT_SLOT_HOLD_MS } from "../src/modes/interactive/components/prompt-slot.ts";
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
		"/tasks goes from the typed command straight to the drawn task panel",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/tasks", /No background work/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);
});
