import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { keyDisplayText } from "../src/modes/interactive/components/keybinding-hints.js";
import { releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import { type SteeringChat, steeringChats, userTexts } from "./helpers/steering-chats.js";

/**
 * SteerUxParity: what the user sees and what the agent receives while steering it are the same in the main chat and
 * in a subagent's chat. Each case runs on both chats against the same expected values, so a difference between the
 * two fails one of them.
 */
describe.each(steeringChats)("steering from the %s chat", (_kind, open) => {
	const chats: SteeringChat[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (chats.length > 0) await chats.pop()?.stop();
	});

	async function busyChat(): Promise<SteeringChat> {
		const chat = await open();
		chats.push(chat);
		await chat.startBusyTurn();
		return chat;
	}

	async function queueThree(chat: SteeringChat): Promise<void> {
		await chat.enter("steer alpha");
		await chat.enter("steer beta");
		await chat.followUp("follow gamma");
		await waitFor("the session to queue all three", () => {
			const session = chat.engine.session;
			return session.getSteeringMessages().length === 2 && session.getFollowUpMessages().length === 1;
		});
	}

	test("Enter steers and the follow-up key queues a follow-up while the agent works, each shown as a queued row", async () => {
		const chat = await busyChat();
		await queueThree(chat);
		assert.deepEqual(chat.engine.session.getSteeringMessages(), ["steer alpha", "steer beta"]);
		assert.deepEqual(chat.engine.session.getFollowUpMessages(), ["follow gamma"]);
		assert.deepEqual(chat.queuedRows(), [
			"Steering: steer alpha",
			"Steering: steer beta",
			"Follow-up: follow gamma",
			`↳ ${keyDisplayText("app.message.dequeue")} to edit all queued messages`,
		]);
	});

	test("the dequeue key takes every queued message back to the editor, steering first, and the agent receives none", async () => {
		const chat = await busyChat();
		await queueThree(chat);
		await chat.dequeue();
		await waitFor("the queue to come back to the editor", () => chat.editorText() !== "");
		assert.equal(chat.editorText(), "steer alpha\n\nsteer beta\n\nfollow gamma");
		assert.deepEqual(chat.engine.session.getSteeringMessages(), []);
		assert.deepEqual(chat.engine.session.getFollowUpMessages(), []);
		assert.deepEqual(chat.queuedRows(), []);
		chat.finishTurn();
		await waitFor("the turn to end", () => idle(chat));
		assert.deepEqual(userTexts(chat.engine), ["first"]);
	});

	test("queued messages reach the model as typed, steering messages before the follow-up", async () => {
		const chat = await busyChat();
		await queueThree(chat);
		chat.finishTurn();
		await waitFor("every queued message to be delivered", () => idle(chat) && userTexts(chat.engine).length === 4);
		assert.deepEqual(userTexts(chat.engine), ["first", "steer alpha", "steer beta", "follow gamma"]);
		assert.deepEqual(chat.queuedRows(), []);
	});
});

function idle(chat: SteeringChat): boolean {
	const session = chat.engine.session;
	return (
		!session.isStreaming &&
		session.getSteeringMessages().length === 0 &&
		session.getFollowUpMessages().length === 0 &&
		session.messages.at(-1)?.role === "assistant"
	);
}
