import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, test } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import {
	ALT_ENTER,
	ALT_UP,
	CTRL_C,
	ESCAPE,
	type MainChatTerminal,
	OriginRecording,
	RECORDED_ON_OTHER_PLATFORM,
	startMainChat,
} from "./helpers/main-chat-terminal.js";

/**
 * Every frame of the main chat, drawn on a terminal by the real interactive mode on both hosts while the single chat
 * screen is installed and shows main, is the frame origin/main draws; so is every model request. The frames were
 * recorded by running this file on origin/main 92bb3108a4 with `SINGLE_SCREEN_FRAMES_RECORD=1`. Only what varies
 * between runs and checkouts is masked (`normalizedFrame`).
 */

const origin = new OriginRecording(
	fileURLToPath(new URL("./fixtures/single-screen-main-frames.json", import.meta.url)),
	process.env.SINGLE_SCREEN_FRAMES_RECORD === "1",
);
const chats: MainChatTerminal[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	while (chats.length > 0) await chats.pop()?.stop();
});

describe.skipIf(RECORDED_ON_OTHER_PLATFORM).each(["in-process", "isolated"] as const)(
	"the main chat's frames with the single screen installed (%s host)",
	(host) => {
		test("typing, sending, steering, Alt+Up, Escape with a queue and the next turn draw origin/main's frames", async () => {
			const chat = await startMainChat(host);
			chats.push(chat);
			await chat.frame("startup", /❯/);
			chat.press("first");
			await chat.frame("typed", /❯ first/);
			chat.press("\r");
			await chat.gate.entered.promise;
			await chat.frame("working", /esc to interrupt/);
			chat.press("steer one");
			chat.press("\r");
			await chat.frame("steering row", /Steering: steer one/);
			chat.press("follow two");
			chat.press(ALT_ENTER);
			await chat.frame("follow-up row", /Follow-up: follow two/);
			chat.press("draft");
			chat.press(ALT_UP);
			await chat.frame("queue back in the editor", /follow two/);
			chat.press(CTRL_C);
			chat.press("steer three");
			chat.press("\r");
			await chat.frame("steering again", /Steering: steer three/);
			chat.press(ESCAPE);
			await chat.frame("escape", /steer three/);
			chat.press(CTRL_C);
			chat.press("next");
			chat.press("\r");
			await chat.frame("next turn", /answer \d/);
			origin.matches(`turns-${host}`, chat);
		}, 90_000);
	},
);
