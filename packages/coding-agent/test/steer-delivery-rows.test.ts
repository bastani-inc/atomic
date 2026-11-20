/**
 * A queued message the subagent takes stays on screen until its own row is in the transcript. Its session lists the
 * queue without it as soon as the turn takes it, then runs the extensions' `message_start` hooks before the message is
 * shown, so a hook that waits held a frame with the message nowhere: not queued, not in the transcript.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/index.js";
import { createGate, type Gate, releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import { type SubagentSteeringChat, subagentChat, userTexts } from "./helpers/steering-chats.js";
import { getMessageText } from "./suite/harness.js";

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

	async function openChat(extension: ExtensionFactory): Promise<SubagentSteeringChat> {
		const chat = await subagentChat({ extensions: [extension] });
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
});
