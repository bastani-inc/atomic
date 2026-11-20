import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { type RecordedChat, startRecordedChat } from "./helpers/painted-frames.js";

/**
 * The working row under the prompt stays on screen from a run's first turn to its end. Between two turns of one run
 * (a tool call answered, the next request not sent yet) no frame drops it, so the chat above does not jump down by
 * its rows and back up when the next turn starts.
 */

const WORKING = /^ ∀ \S.*…/;
const WORKED = /^ ∀ \S+ for /;

const pingTool: AgentTool = {
	name: "ping",
	label: "Ping",
	description: "Answers at once",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
};

const statusRow = (screen: readonly string[]) => screen.find((line) => WORKING.test(line) || WORKED.test(line));

/** Stopping the interactive mode and the engine pair takes longer than the default hook budget. */
const STOP_TIMEOUT_MS = 60_000;
const chats: RecordedChat[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	while (chats.length > 0) await chats.pop()?.stop();
}, STOP_TIMEOUT_MS);

describe.each(["in-process", "isolated"] as const)("the working row between two turns (%s host)", (host) => {
	test("no frame between a turn's end and the next turn's start drops the working row", async () => {
		const nextTurn = Promise.withResolvers<void>();
		const betweenTurns = Promise.withResolvers<void>();
		// An extension's turn_start handler runs before the session announces the turn, so holding it holds the chat
		// between the first turn's end and the second turn's start, for as long as a slow next request would.
		const holdSecondTurn: ExtensionFactory = (pi) => {
			pi.on("turn_start", async (event) => {
				if (event.turnIndex < 1) return;
				betweenTurns.resolve();
				await nextTurn.promise;
			});
		};
		const chat = await startRecordedChat(host, {
			tools: [pingTool],
			extensions: [holdSecondTurn],
			responses: [
				fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("all done"),
			],
		});
		chats.push(chat);
		chat.beforeStop(() => nextTurn.resolve());
		await chat.settled(/❯/);
		chat.terminal.sendInput("go");
		chat.terminal.sendInput("\r");
		await betweenTurns.promise;
		const between = await chat.settled(/esc to interrupt/);
		assert.ok(
			between.some((line) => WORKING.test(line)),
			`the working row is gone between the turns:\n${between.join("\n")}`,
		);

		const mark = chat.terminal.mark();
		nextTurn.resolve();
		const ended = await chat.settled(/^ ∀ \S+ for /m);
		assert.match(ended.join("\n"), /all done/);
		for (const screen of await chat.terminal.screensSince(mark)) {
			assert.ok(statusRow(screen), `a frame drew no status row:\n${screen.join("\n")}`);
		}
	});
});
