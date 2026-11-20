import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { type RecordedChat, startRecordedChat } from "./helpers/painted-frames.js";

/**
 * A sent message shows at once (its echo) with the working row under it, and both stay until the run it started takes
 * over: the run's own message replaces the echo in place and its working row replaces the row. The engine answers
 * that it started the run before it sends the run's first events, and the host can handle that answer first; no frame
 * in between may drop the message or the working row.
 */

const WORKING = /^ ∀ \S.*…/;
/** Stopping the interactive mode and the engine pair takes longer than the default hook budget. */
const STOP_TIMEOUT_MS = 60_000;
const chats: RecordedChat[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	while (chats.length > 0) await chats.pop()?.stop();
}, STOP_TIMEOUT_MS);

/** Holds the engine's `agent_start` of run `runIndex` (0-based) until `release` opens, after its answer went out. */
function holdRunStart(runIndex: number) {
	const release = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	let runs = 0;
	const extension: ExtensionFactory = (pi) => {
		pi.on("agent_start", async () => {
			if (runs++ !== runIndex) return;
			held.resolve();
			await release.promise;
		});
	};
	return { extension, release, held };
}

function assertEchoAndWorkingRow(screen: readonly string[], text: string, label: string): void {
	const shown = screen.join("\n");
	assert.ok(
		screen.some((line) => line.trimEnd() === ` ${text}`),
		`${label}: the sent message is not on screen:\n${shown}`,
	);
	assert.ok(
		screen.some((line) => WORKING.test(line)),
		`${label}: the working row is not on screen:\n${shown}`,
	);
}

describe("a prompt whose answer reaches the host before its run's first events (isolated host)", () => {
	for (const prompt of [1, 2]) {
		test(`prompt ${prompt}: no frame drops the sent message or the working row`, async () => {
			const hold = holdRunStart(prompt - 1);
			const chat = await startRecordedChat("isolated", {
				extensions: [hold.extension],
				responses: [fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")],
			});
			chats.push(chat);
			chat.beforeStop(() => hold.release.resolve());
			await chat.settled(/❯/);
			if (prompt === 2) {
				chat.terminal.sendInput("warm up");
				chat.terminal.sendInput("\r");
				await chat.settled(/^ ∀ \S+ for /m);
			}
			const mark = chat.terminal.mark();
			chat.terminal.sendInput("hello there");
			chat.terminal.sendInput("\r");
			await hold.held.promise;
			// The engine answered "started" and holds the run's agent_start: the host has the answer only.
			await vi.waitFor(() => assert.equal(chat.mode.promptTurn, undefined), { timeout: 10_000 });
			assertEchoAndWorkingRow(await chat.settled(/❯/), "hello there", "answer before the run's events");

			hold.release.resolve();
			const ended = await chat.settled(/^ ∀ \S+ for /m);
			assert.match(ended.join("\n"), prompt === 1 ? /first answer/ : /second answer/);
			const screens = await chat.terminal.screensSince(mark);
			const firstEcho = screens.findIndex((screen) => screen.some((line) => line.trimEnd() === " hello there"));
			assert.notEqual(firstEcho, -1);
			const answered = screens.findIndex((screen) =>
				screen.some((line) => line.includes(prompt === 1 ? "first answer" : "second answer")),
			);
			for (const [index, screen] of screens.slice(firstEcho, answered).entries()) {
				assertEchoAndWorkingRow(screen, "hello there", `frame ${firstEcho + index}`);
			}
		});
	}
});
