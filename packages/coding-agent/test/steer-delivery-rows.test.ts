/**
 * A queued message the subagent takes stays on screen until its own row is in the transcript. Its session lists the
 * queue without it as soon as the turn takes it, then runs the extensions' `message_start` hooks before the message is
 * shown, so a hook that waits held a frame with the message nowhere: not queued, not in the transcript.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { Settings } from "../src/core/settings-manager.js";
import type { ExtensionFactory } from "../src/index.js";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.js";
import { themedChatHostStyle } from "../src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { createGate, type Gate, holdTool, releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import {
	busyTurnResponses,
	DEQUEUE_KEY,
	type SubagentSteeringChat,
	subagentChat,
	userTexts,
} from "./helpers/steering-chats.js";
import { createHarness, getMessageText } from "./suite/harness.js";

/** An extension whose `message_start` hook waits on `gate` for the user message `text`. */
function holdMessageStart(text: string, gate: Gate): ExtensionFactory {
	return (pi) => {
		pi.on("message_start", async (event) => {
			if (event.message.role !== "user" || getMessageText(event.message) !== text) return;
			gate.entered.resolve();
			await gate.release.promise;
		});
	};
}

/** The rows of the chat's transcript that show `text` as the user's own message (not its queued row). */
function echoRows(chat: SubagentSteeringChat, text: string): number {
	return chat
		.screen()
		.split("\n")
		.filter((line) => line.trim() === text).length;
}

function queuedRow(chat: SubagentSteeringChat, row: string): boolean {
	return chat.queuedRows().includes(row);
}

describe("a queued message the subagent takes", () => {
	const chats: SubagentSteeringChat[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (chats.length > 0) await chats.pop()?.stop();
	});

	async function openChat(extension: ExtensionFactory, settings?: Partial<Settings>): Promise<SubagentSteeringChat> {
		const chat = await subagentChat({ extensions: [extension], ...(settings ? { settings } : {}) });
		chats.push(chat);
		return chat;
	}

	for (const [lane, row] of [
		["steering", "Steering: later one"],
		["follow-up", "Follow-up: later one"],
	] as const) {
		test(`stays listed as a ${lane} row while its message_start hooks run, and leaves in the frame its row shows (S9)`, async () => {
			const hook = createGate();
			const chat = await openChat(holdMessageStart("later one", hook));
			await chat.startBusyTurn();
			if (lane === "steering") await chat.enter("later one");
			else await chat.followUp("later one");
			await waitFor(`the ${lane} row`, () => queuedRow(chat, row));

			chat.finishTurn();
			await hook.entered.promise;
			// The session took the message and its hooks hold it back from the transcript: it is still queued on screen.
			assert.equal(echoRows(chat, "later one"), 0, chat.screen());
			assert.ok(queuedRow(chat, row), `the message is on screen neither queued nor sent:\n${chat.screen()}`);

			hook.release.resolve();
			await waitFor("the message in the transcript", () => echoRows(chat, "later one") === 1);
			// Its row went in the same frame its message appeared: never both, never neither.
			assert.equal(queuedRow(chat, row), false, chat.screen());
			assert.deepEqual(userTexts(chat.engine), ["first", "later one"]);
		});
	}

	test("taken together with the next one, each stays listed until its own row shows (S9)", async () => {
		const hook = createGate();
		const chat = await openChat(holdMessageStart("first steer", hook), { steeringMode: "all" });
		await chat.startBusyTurn();
		await chat.enter("first steer");
		await chat.enter("second steer");
		await waitFor("both rows", () => queuedRow(chat, "Steering: second steer"));

		chat.finishTurn();
		await hook.entered.promise;
		// The turn took both; the first one's hooks hold both back from the transcript.
		for (const text of ["first steer", "second steer"])
			assert.ok(
				queuedRow(chat, `Steering: ${text}`) || echoRows(chat, text) === 1,
				`"${text}" is on screen neither queued nor sent:\n${chat.screen()}`,
			);

		hook.release.resolve();
		await waitFor("both messages in the transcript", () => echoRows(chat, "second steer") === 1);
		assert.equal(echoRows(chat, "first steer"), 1, chat.screen());
		assert.deepEqual(chat.queuedRows(), [], chat.screen());
		assert.deepEqual(userTexts(chat.engine), ["first", "first steer", "second steer"]);
	});

	test("Alt+Up while it is taken gives nothing back and sends it once, as before the row stayed (S9)", async () => {
		const hook = createGate();
		const chat = await openChat(holdMessageStart("later one", hook));
		await chat.startBusyTurn();
		await chat.enter("later one");
		await waitFor("the steering row", () => queuedRow(chat, "Steering: later one"));

		chat.finishTurn();
		await hook.entered.promise;
		await chat.press(DEQUEUE_KEY);
		// The session already took the message: the dequeue key has nothing to give back.
		assert.equal(chat.editorText(), "");

		hook.release.resolve();
		await waitFor("the message in the transcript", () => echoRows(chat, "later one") === 1);
		assert.equal(chat.editorText(), "");
		assert.deepEqual(chat.queuedRows(), [], chat.screen());
		assert.deepEqual(userTexts(chat.engine), ["first", "later one"]);
	});
});

describe("a chat over an agent session it does not steer", () => {
	afterEach(() => releaseOpenGates());

	test("gives nothing back on restore while the session delivers its taken message, as before (S9)", async () => {
		initTheme("dark");
		const hook = createGate();
		const toolHold = createGate();
		const child = await createHarness({
			tools: [holdTool(toolHold)],
			extensionFactories: [holdMessageStart("later one", hook)],
		});
		child.setResponses(busyTurnResponses());
		const chat = new ChatSessionHost({
			style: themedChatHostStyle(),
			editorTheme: getEditorTheme(),
			getAgentSession: () => child.session,
		});
		const unsubscribe = child.session.subscribe((event) => chat.applyAgentEvent(event));
		try {
			const turn = child.session.prompt("first").catch(() => {});
			await toolHold.entered.promise;
			await child.session.prompt("later one", { streamingBehavior: "steer" });
			toolHold.release.resolve();
			await hook.entered.promise;

			assert.equal(chat.restoreQueuedMessagesToEditor(), false);
			assert.equal(chat.inputText(), "");

			hook.release.resolve();
			await turn;
			assert.equal(chat.inputText(), "");
			assert.deepEqual(userTexts(child), ["first", "later one"]);
		} finally {
			hook.release.resolve();
			toolHold.release.resolve();
			unsubscribe();
			chat.dispose();
			await child.cleanup();
		}
	});
});
