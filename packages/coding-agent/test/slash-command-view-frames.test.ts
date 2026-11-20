import assert from "node:assert/strict";
import { Text } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import type { SubagentState } from "../../subagents/src/shared/types.ts";
import { registerSlashCommands } from "../../subagents/src/slash/slash-commands.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { FIRST_FRAME_TIMEOUT_MS } from "../src/modes/interactive/agent-view/remote-port.ts";
import { holdTranscriptDock } from "../src/modes/interactive/agent-view/transcript-slot.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { holdPromptSlot, PROMPT_SLOT_HOLD_MS } from "../src/modes/interactive/components/prompt-slot.ts";
import { screenHoldOf } from "../src/modes/interactive/screen-hold.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { ESCAPE, type MainChatTerminal, startMainChat } from "./helpers/main-chat-terminal.js";

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

async function start(host: "in-process" | "isolated", extensions?: ExtensionFactory[]): Promise<MainChatTerminal> {
	const write = VirtualTerminal.prototype.write;
	vi.spyOn(VirtualTerminal.prototype, "write").mockImplementation(function (this: VirtualTerminal, data: string) {
		writes.push({ terminal: this, at: performance.now(), data });
		write.call(this, data);
	});
	const chat = await startMainChat(host, { engineUi: true, extensions, extensionUi: extensions !== undefined });
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

/**
 * Run `command` and check every frame up to its view: each still shows the typed command, or shows the view. `until` is
 * what the screen settles on, when the view does not stay up.
 */
async function expectStraightToView(
	chat: MainChatTerminal,
	command: string,
	view: RegExp,
	until: RegExp = view,
): Promise<void> {
	const typed = new RegExp(`❯ ${command.replace("/", "\\/")}`);
	chat.press(command);
	await chat.settled(typed);
	const enter = await pressEnter(chat);
	await chat.settled(until);
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

/** Type `command` with its suggestions closed, so Enter submits it as typed. */
async function typeClosed(chat: MainChatTerminal, command: string): Promise<RegExp> {
	const typed = new RegExp(`❯ ${command.replace("/", "\\/")}`);
	chat.press(command);
	await chat.settled(typed);
	chat.press(ESCAPE);
	await chat.settled(typed);
	return typed;
}

/** An extension command that runs until `release`, after `effect`. */
function slowCommand(name: string, release: Promise<void>, effect?: (ui: { notify(message: string): void }) => void) {
	return ((pi) =>
		pi.registerCommand(name, {
			handler: async (_args, ctx) => {
				effect?.(ctx.ui);
				await release;
			},
		})) satisfies ExtensionFactory;
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
		"/thinking goes from the typed command straight to the thinking level selector (#6077)",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/thinking", /Thinking level/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/thinking with a level clears the prompt at once: it opens no view (#6077)",
		async () => {
			const chat = await start(host);
			const typed = /❯ \/thinking off/;
			chat.press("/thinking off");
			await chat.settled(typed);
			// Escape closes the level suggestions, so Enter submits the command rather than picking one.
			chat.press(ESCAPE);
			await chat.settled(typed);
			const enter = await pressEnter(chat);
			await chat.settled(/Thinking level: off/);
			const [first] = await screens(chat, enter.from);
			assert.ok(first, "nothing was drawn after Enter");
			assert.doesNotMatch(first.text, typed, `the first frame after Enter:\n${first.text}`);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/login goes from the typed command straight to the authentication methods (#6077)",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/login", /Select authentication method/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/fork goes from the typed command straight to the messages to fork from (#6077)",
		async () => {
			const chat = await start(host);
			await finishOneTurn(chat);
			await expectStraightToView(chat, "/fork", /Fork from message/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/fork with nothing to fork from shows the live prompt with its notice (#6077)",
		async () => {
			const chat = await start(host);
			chat.press("/fork");
			await chat.settled(/❯ \/fork/);
			const enter = await pressEnter(chat);
			const notice = /No messages to fork from/;
			await chat.settled(notice);
			const frames = (await screens(chat, enter.from)).filter((frame) => notice.test(frame.text));
			assert.ok(frames.length > 0, "the notice was never drawn");
			for (const frame of frames)
				assert.doesNotMatch(frame.text, /❯ \/fork/, `a frame with the notice:\n${frame.text}`);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/trust goes from the typed command straight to the trust choices (#6077)",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/trust", /Project trust/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"a key that reaches /trust's view before its choices load shows the view live (#6077)",
		async () => {
			const chat = await start(host);
			const typed = /❯ \/trust/;
			chat.press("/trust");
			await chat.settled(typed);
			// Enter and Down arrive in one read, before any frame: the view keeps Down for its choices.
			const from = await new Promise<number>((resolve) =>
				setImmediate(() => {
					const written = writes.filter((write) => write.terminal === chat.terminal).length;
					chat.press("\r");
					chat.press("\x1b[B");
					resolve(written);
				}),
			);
			await chat.settled(/Project trust/);
			const [first] = await screens(chat, from);
			assert.ok(first, "nothing was drawn after Enter");
			assert.doesNotMatch(first.text, typed, `the first frame after Enter and Down:\n${first.text}`);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/reload goes from the typed command straight to its progress notice (#6077)",
		async () => {
			const chat = await start(host);
			await expectStraightToView(chat, "/reload", /Reloading keybindings/, /Reload(ed keybindings| failed)/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/model with a name it has to look up goes from the typed command straight to the selector (#6077)",
		async () => {
			const chat = await start(host);
			const typed = await typeClosed(chat, "/model no-such-model");
			const enter = await pressEnter(chat);
			await chat.settled(/Select model/);
			for (const frame of await screens(chat, enter.from)) {
				if (/Select model/.test(frame.text)) return;
				if (frame.at - enter.at > PROMPT_SLOT_HOLD_MS) return;
				assert.match(frame.text, typed, `a frame between the command and the selector:\n${frame.text}`);
			}
			assert.fail("the selector was never drawn");
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/model with the exact name of a model clears the prompt at once: it opens no view (#6077)",
		async () => {
			const chat = await start(host);
			const model = chat.mode.session.model;
			assert.ok(model);
			const typed = await typeClosed(chat, `/model ${model.provider}/${model.id}`);
			const enter = await pressEnter(chat);
			await chat.settled(/Model: /);
			const [first] = await screens(chat, enter.from);
			assert.ok(first, "nothing was drawn after Enter");
			assert.doesNotMatch(first.text, typed, `the first frame after Enter:\n${first.text}`);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"/agents, an extension command, goes from the typed command straight to its view (#6077)",
		async () => {
			const chat = await start(host, [
				(pi) => registerSlashCommands(pi, { baseCwd: process.cwd() } as SubagentState),
			]);
			await expectStraightToView(chat, "/agents", /Built-in agents/);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"an extension command that shows a notice shows it with the live prompt (#6077)",
		async () => {
			const release = Promise.withResolvers<void>();
			const chat = await start(host, [slowCommand("note", release.promise, (ui) => ui.notify("noted"))]);
			chat.press("/note");
			await chat.settled(/❯ \/note/);
			const enter = await pressEnter(chat);
			await chat.settled(/noted/);
			const frames = (await screens(chat, enter.from)).filter((frame) => /noted/.test(frame.text));
			release.resolve();
			assert.ok(frames.length > 0, "the notice was never drawn");
			for (const frame of frames)
				assert.doesNotMatch(frame.text, /❯ \/note/, `a frame with the notice:\n${frame.text}`);
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"an extension command that shows nothing shows the live prompt once it returns (#6077)",
		async () => {
			let ran = false;
			const chat = await start(host, [
				(pi) =>
					pi.registerCommand("quiet", {
						handler: async () => {
							ran = true;
						},
					}),
			]);
			chat.press("/quiet");
			await chat.settled(/❯ \/quiet/);
			await pressEnter(chat);
			// The turn that ran the command has ended: the prompt's slot is no longer held, without waiting for its bound.
			await vi.waitFor(() => assert.ok(ran && chat.mode.promptTurn === undefined && !chat.mode.session.isStreaming));
			assert.notEqual(screenHoldOf(chat.mode).region, "prompt");
		},
		INTERACTIVE_CASE_TIMEOUT_MS,
	);

	test(
		"an extension command that shows nothing for a while shows the live prompt after the hold's bound (#6077)",
		async () => {
			const release = Promise.withResolvers<void>();
			const chat = await start(host, [slowCommand("slow", release.promise)]);
			chat.press("/slow");
			await chat.settled(/❯ \/slow/);
			await pressEnter(chat);
			// The command still runs; its hold has ended at its bound and the prompt shows as it is.
			const screen = (await chat.settled(/^❯\s*$/m)).join("\n");
			assert.doesNotMatch(screen, /❯ \/slow/);
			assert.equal(screenHoldOf(chat.mode).region, undefined);
			release.resolve();
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
