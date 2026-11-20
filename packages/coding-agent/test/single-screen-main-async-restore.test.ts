import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, test } from "vitest";
import type { TaskId } from "../src/core/tasks/contracts.js";
import type { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import {
	ALT_ENTER,
	CTRL_C,
	ESCAPE,
	type MainChatTerminal,
	OriginRecording,
	RECORDED_ON_OTHER_PLATFORM,
	startMainChat,
} from "./helpers/main-chat-terminal.js";

/**
 * The main chat gives a message back to its prompt only after an answer that can arrive late: Escape's queue, a send the
 * engine refuses, the queue of an engine that died. While a subagent is shown on the one screen the prompt is that
 * subagent's, so the answer must land in main's draft and leave the subagent's prompt as it is; back on main, every
 * frame and request is origin/main's. The frames were recorded by running this file on origin/main 92bb3108a4, which
 * has no single screen, with `SINGLE_SCREEN_RESTORE_RECORD=1`; there the cases run without the switch.
 */

const INSTALL = new URL("../src/modes/interactive/agent-view/install.ts", import.meta.url);
const FAKE_PORT = new URL("./helpers/fake-agent-view-port.ts", import.meta.url);
/** Whether this tree has the single chat screen (origin/main, where the frames were recorded, does not). */
const SINGLE_SCREEN = existsSync(fileURLToPath(INSTALL));
const origin = new OriginRecording(
	fileURLToPath(new URL("./fixtures/single-screen-main-async-restore.json", import.meta.url)),
	process.env.SINGLE_SCREEN_RESTORE_RECORD === "1",
);
const AGENT = "task-agent-1" as TaskId;

interface Shown {
	/** Show the subagent and type `draft` into its prompt. */
	showAgent(draft: string): Promise<void>;
	/** The prompt's text now (the shown subagent's while it is shown). */
	promptText(): string;
	showMain(): Promise<void>;
	/** What the subagent was sent (prompt, resume, clearQueue, pause). */
	agentCalls(): readonly object[];
}

const chats: MainChatTerminal[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	while (chats.length > 0) await chats.pop()?.stop();
});

/** The main chat, with one subagent the screen can show (a fake port) where the single screen exists. */
async function mainChatWithAgent(host: "in-process" | "isolated"): Promise<{ chat: MainChatTerminal; shown: Shown }> {
	let fake: { calls: readonly object[]; status(): { taskId: TaskId } } | undefined;
	let switcher: { view(taskId: TaskId | undefined): Promise<boolean> } | undefined;
	const chat = await startMainChat(host, {
		beforeRun: async (mode: InteractiveMode) => {
			if (!SINGLE_SCREEN) return;
			const { agentViewSwitcher } = (await import(
				INSTALL.href
			)) as typeof import("../src/modes/interactive/agent-view/install.ts");
			const { FakeAgentViewPort } = (await import(
				FAKE_PORT.href
			)) as typeof import("./helpers/fake-agent-view-port.ts");
			const port = new FakeAgentViewPort({ taskId: AGENT, name: "worker" });
			fake = port;
			switcher = agentViewSwitcher(mode as never, async (taskId) => (taskId === AGENT ? port : undefined));
		},
	});
	chats.push(chat);
	const shown: Shown = {
		async showAgent(draft) {
			if (!switcher) return;
			assert.equal(await switcher.view(AGENT), true, "the subagent is shown");
			chat.press(draft);
			await chat.settled();
		},
		promptText: () => chat.mode.editor.getText(),
		async showMain() {
			if (!switcher) return;
			await switcher.view(undefined);
		},
		agentCalls: () => fake?.calls ?? [],
	};
	return { chat, shown };
}

/** Send `first` and wait until its turn holds in its tool call. */
async function busy(chat: MainChatTerminal): Promise<void> {
	chat.press("first");
	chat.press("\r");
	await chat.gate.entered.promise;
	await chat.settled(/esc to interrupt/);
}

describe.skipIf(RECORDED_ON_OTHER_PLATFORM).each(["in-process", "isolated"] as const)(
	"main's late answers while a subagent is shown (%s host)",
	(host) => {
		test("Escape's queue comes back to main's prompt, not the shown subagent's, and main draws origin/main's frames", async () => {
			const { chat, shown } = await mainChatWithAgent(host);
			await busy(chat);
			chat.press("steer one");
			chat.press("\r");
			chat.press("follow two");
			chat.press(ALT_ENTER);
			chat.press("draft");
			await chat.frame("queued", /Follow-up: follow two/);
			// The engine's answers wait: the queue comes back only after Escape's round trip.
			chat.pair?.holdHostTrafficFrom(() => true);
			chat.press(ESCAPE);
			await shown.showAgent("agent draft");
			await chat.pair?.releaseHostTraffic();
			await chat.settled();
			if (SINGLE_SCREEN) {
				assert.equal(shown.promptText(), "agent draft", "the subagent's prompt keeps what was typed into it");
				assert.deepEqual(shown.agentCalls(), [], "nothing reached the subagent");
			}
			await shown.showMain();
			await chat.frame("escape answered", /❯ steer one/);
			chat.press(CTRL_C);
			chat.press("next");
			chat.press("\r");
			await chat.frame("next turn", /answer \d/);
			origin.matches(`escape-${host}`, chat);
		}, 90_000);

		test.runIf(host === "isolated")(
			"a message the engine refuses comes back to main's prompt, not the shown subagent's",
			async () => {
				const { chat, shown } = await mainChatWithAgent(host);
				await busy(chat);
				chat.pair?.failCommand("prompt", "engine refused the message");
				chat.pair?.holdHostTrafficFrom(() => true);
				chat.press("typed while busy");
				chat.press("\r");
				await shown.showAgent("agent draft");
				await chat.pair?.releaseHostTraffic();
				await chat.settled();
				if (SINGLE_SCREEN) {
					assert.equal(shown.promptText(), "agent draft", "the subagent's prompt keeps what was typed into it");
					assert.deepEqual(shown.agentCalls(), [], "nothing reached the subagent");
				}
				await shown.showMain();
				await chat.frame("refused", /❯ typed while busy/);
				chat.pair?.failCommand("prompt", undefined);
				chat.gate.release.resolve();
				await chat.frame("turn ends", /answer \d/);
				origin.matches(`refused-${host}`, chat);
			},
			90_000,
		);

		test.runIf(host === "isolated")(
			"a crashed engine's queue comes back to main's prompt while a subagent was shown, and main is shown again",
			async () => {
				const { chat, shown } = await mainChatWithAgent(host);
				await busy(chat);
				chat.press("steer alpha");
				chat.press("\r");
				chat.press("follow beta");
				chat.press(ALT_ENTER);
				chat.press("half typed");
				await chat.frame("queued", /Follow-up: follow beta/);
				await shown.showAgent("");
				chat.pair?.crash();
				chat.gate.release.resolve();
				await chat.frame("recovered", /Engine restarted/);
				if (SINGLE_SCREEN) assert.deepEqual(shown.agentCalls(), [], "nothing reached the subagent");
				origin.matches(`crash-${host}`, chat);
			},
			90_000,
		);
	},
);
