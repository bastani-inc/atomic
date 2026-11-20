import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { subagentChatCommand } from "../src/modes/interactive/subagent-chat-commands.js";
import { releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import { CTRL_F, type SubagentSteeringChat, subagentChat, userTexts } from "./helpers/steering-chats.js";

/** What a subagent's chat has that the main chat does not: built-ins that belong to the main chat are refused there. */
describe("a subagent's chat", () => {
	const chats: SubagentSteeringChat[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (chats.length > 0) await chats.pop()?.stop();
	});

	async function openChat(): Promise<SubagentSteeringChat> {
		const chat = await subagentChat();
		chats.push(chat);
		return chat;
	}

	test("Ctrl+F moves the cursor right, as in the main chat's prompt, and sends nothing", async () => {
		const chat = await openChat();
		await chat.type("ab");
		await chat.press("\x01");
		await chat.press(CTRL_F);
		await chat.type("X");
		assert.equal(chat.editorText(), "aXb");
		assert.deepEqual(chat.engine.session.getFollowUpMessages(), []);
		assert.deepEqual(userTexts(chat.engine), []);
	});

	test("/model is refused with a notice and never reaches the subagent", async () => {
		const chat = await openChat();
		await chat.startBusyTurn();
		await chat.enter("/model other-model");
		assert.match(chat.screen(), /\/model is not available in a subagent chat/);
		assert.deepEqual(chat.engine.session.getSteeringMessages(), []);
		assert.deepEqual(chat.queuedRows(), []);
		chat.finishTurn();
		await waitFor("the turn to end", () => !chat.engine.session.isStreaming);
		assert.deepEqual(userTexts(chat.engine), ["first"]);
	});

	test("a ! shell command stays in the prompt with a notice; the subagent's shell is not the chat's to run", async () => {
		const chat = await openChat();
		await chat.type("!ls");
		await chat.press("\r");
		assert.equal(chat.editorText(), "!ls");
		assert.match(chat.screen(), /! shell commands are not available in this chat/);
		assert.deepEqual(userTexts(chat.engine), []);
	});
});

describe("slash commands in a subagent's chat", () => {
	test("every built-in either runs in the chat or is refused there; none reaches the subagent as text", () => {
		for (const { name } of BUILTIN_SLASH_COMMANDS) {
			assert.notEqual(subagentChatCommand(`/${name}`).kind, "agent", `/${name}`);
		}
	});

	test("/tasks, /copy and /hotkeys run in the chat; the main chat's own built-ins are refused", () => {
		assert.deepEqual(subagentChatCommand("/tasks"), { kind: "local", name: "tasks" });
		assert.deepEqual(subagentChatCommand("/tasks task-1"), { kind: "local", name: "tasks" });
		assert.deepEqual(subagentChatCommand("/copy"), { kind: "local", name: "copy" });
		assert.deepEqual(subagentChatCommand("/hotkeys"), { kind: "local", name: "hotkeys" });
		for (const text of [
			"/model",
			"/model other",
			"/new",
			"/resume abc",
			"/fork",
			"/tree",
			"/quit",
			"/compact keep it",
		])
			assert.equal(subagentChatCommand(text).kind, "unavailable", text);
		assert.deepEqual(subagentChatCommand("/settings"), { kind: "unavailable", name: "settings" });
	});

	test("text the main chat would send to its model goes to the subagent: skills, templates, and built-in names with arguments they do not take", () => {
		for (const text of [
			"/skill:review the diff",
			"/review src/a.ts",
			"/copy that paragraph",
			"/new idea: cache it",
			"hello",
		])
			assert.deepEqual(subagentChatCommand(text), { kind: "agent" }, text);
	});
});
