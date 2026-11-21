/**
 * A queued message the main chat's session takes stays on screen until its own row is in the transcript. The session
 * lists its queue without the message as soon as the turn takes it, then runs the extensions' `message_start` hooks
 * before the message is shown; on the isolated host the two also reach the host as separate lines, so the host can
 * paint between them.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { waitFor } from "./helpers/busy-submission-rig.js";
import { type MainChatTerminal, startMainChat } from "./helpers/main-chat-terminal.js";
import { DEQUEUE_KEY, FOLLOW_UP_KEY } from "./helpers/steering-chats.js";
import { getMessageText } from "./suite/harness.js";

/** A real interactive mode on a terminal, and a turn or two of the faux model: never the default budget. */
const MAIN_CHAT_TEST_TIMEOUT_MS = 90_000;

interface Gate {
	readonly entered: PromiseWithResolvers<void>;
	readonly release: PromiseWithResolvers<void>;
}

function gate(): Gate {
	return { entered: Promise.withResolvers(), release: Promise.withResolvers() };
}

/** An extension whose `message_start` hook waits on `hold` for the user message `text`. */
function holdMessageStart(text: string, hold: Gate): ExtensionFactory {
	return (pi) => {
		pi.on("message_start", async (event) => {
			if (event.message.role !== "user" || getMessageText(event.message) !== text) return;
			hold.entered.resolve();
			await hold.release.promise;
		});
	};
}

/** How often `text` is the user's own row in the transcript, and how often it is listed as queued. */
function shown(lines: readonly string[], text: string): { echoes: number; rows: number } {
	const trimmed = lines.map((line) => stripVTControlCharacters(line).trim());
	return {
		echoes: trimmed.filter((line) => line === text).length,
		rows: trimmed.filter((line) => line === `Steering: ${text}` || line === `Follow-up: ${text}`).length,
	};
}

/** A screen that shows `text` as the user's own row in the transcript. */
function echoOf(text: string): RegExp {
	return new RegExp(`^ +${text}$`, "m");
}

const chats: MainChatTerminal[] = [];
const gates: Gate[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const open of gates.splice(0)) open.release.resolve();
	for (const cleanup of cleanups.splice(0)) cleanup();
	while (chats.length > 0) await chats.pop()?.stop();
});

async function busyChat(
	host: "in-process" | "isolated",
	options: Parameters<typeof startMainChat>[1] = {},
): Promise<MainChatTerminal> {
	const chat = await startMainChat(host, options);
	chats.push(chat);
	await chat.settled(/❯/);
	chat.press("first");
	chat.press("\r");
	await chat.gate.entered.promise;
	// The chat shows the turn running: a message typed now is queued, not sent as a prompt.
	await chat.settled(/esc to interrupt/);
	return chat;
}

describe.each(["in-process", "isolated"] as const)(
	"a queued message the main chat's session takes (%s host)",
	(host) => {
		for (const [lane, key, row] of [
			["steering", "\r", "Steering: later one"],
			["follow-up", FOLLOW_UP_KEY, "Follow-up: later one"],
		] as const) {
			test(
				`stays listed as a ${lane} row while its message_start hooks run, and leaves when its row shows (#6080)`,
				async () => {
					const hook = gate();
					gates.push(hook);
					const chat = await busyChat(host, { extensions: [holdMessageStart("later one", hook)] });
					chat.press("later one");
					chat.press(key);
					await chat.settled(new RegExp(row));

					chat.gate.release.resolve();
					await hook.entered.promise;
					// The session took the message and its hooks hold it back from the transcript: it is still queued on screen.
					const held = await chat.settled();
					assert.deepEqual(shown(held, "later one"), { echoes: 0, rows: 1 }, held.join("\n"));

					hook.release.resolve();
					const delivered = await chat.settled(echoOf("later one"));
					assert.deepEqual(shown(delivered, "later one"), { echoes: 1, rows: 0 }, delivered.join("\n"));
				},
				MAIN_CHAT_TEST_TIMEOUT_MS,
			);
		}

		test(
			"taken together with the next one, each stays listed until its own row shows (#6080)",
			async () => {
				const hook = gate();
				gates.push(hook);
				const chat = await busyChat(host, {
					extensions: [holdMessageStart("first steer", hook)],
					settings: { steeringMode: "all" },
				});
				chat.press("first steer");
				chat.press("\r");
				chat.press("second steer");
				chat.press("\r");
				await chat.settled(/Steering: second steer/);

				chat.gate.release.resolve();
				await hook.entered.promise;
				const held = await chat.settled();
				assert.deepEqual(shown(held, "first steer"), { echoes: 0, rows: 1 }, held.join("\n"));
				assert.deepEqual(shown(held, "second steer"), { echoes: 0, rows: 1 }, held.join("\n"));

				hook.release.resolve();
				const delivered = await chat.settled(echoOf("second steer"));
				assert.deepEqual(shown(delivered, "first steer"), { echoes: 1, rows: 0 }, delivered.join("\n"));
				assert.deepEqual(shown(delivered, "second steer"), { echoes: 1, rows: 0 }, delivered.join("\n"));
			},
			MAIN_CHAT_TEST_TIMEOUT_MS,
		);

		test(
			"a message whose message_start never reaches the chat leaves the rows with the session's next event (#6080)",
			async () => {
				const chat = await busyChat(host);
				const session = chat.pair?.engine.session ?? chat.mode.session;
				// Its message_start fails on its way to the listeners, as a failing hook or image normalization does.
				const emit = session._emitExtensionEvent.bind(session);
				Object.assign(session, {
					_emitExtensionEvent: async (event: Parameters<typeof emit>[0]) => {
						if (
							event.type === "message_start" &&
							event.message.role === "user" &&
							getMessageText(event.message) === "later one"
						)
							throw new Error("message_start failed");
						return emit(event);
					},
				});
				chat.press("later one");
				chat.press("\r");
				await chat.settled(/Steering: later one/);

				chat.gate.release.resolve();
				const replied = await chat.settled(/answer 2/);
				assert.deepEqual(shown(replied, "later one"), { echoes: 0, rows: 0 }, replied.join("\n"));
			},
			MAIN_CHAT_TEST_TIMEOUT_MS,
		);

		test(
			"taken and lost twice before it is sent, it comes back to the editor as typed, with a notice",
			async () => {
				const chat = await busyChat(host);
				const session = chat.pair?.engine.session ?? chat.mode.session;
				const agent = session.agent;
				// The turn after the tool call fails while it prepares, and from then on every run fails as it starts,
				// before the queued message does: taken and lost once (queued again), then a second time (dropped).
				const prepare = agent.prepareNextTurnWithContext;
				let failedPreparation = false;
				agent.prepareNextTurnWithContext = async (context, signal) => {
					if (!failedPreparation) {
						failedPreparation = true;
						throw new Error("turn preparation failed");
					}
					return prepare?.(context, signal);
				};
				let refusals = 0;
				const stopRefusing = agent.subscribe((event) => {
					if (event.type === "agent_start" && failedPreparation) {
						refusals++;
						throw new Error("refused at start");
					}
				});
				cleanups.push(stopRefusing);
				chat.press("later one");
				chat.press("\r");
				await chat.settled(/Steering: later one/);

				chat.gate.release.resolve();
				const returned = await chat.settled(/1 queued message wasn't sent and is back in the editor/);
				// Lost as its turn failed to prepare, queued again, and lost as the next run started: no run tries it again.
				assert.equal(refusals, 1);
				assert.equal(chat.mode.editor.getText(), "later one", returned.join("\n"));
				assert.deepEqual(shown(returned, "later one"), { echoes: 0, rows: 0 }, returned.join("\n"));
				assert.equal(
					chat.requests.filter((request) => request.includes("later one")).length,
					0,
					chat.requests.join("\n"),
				);
			},
			MAIN_CHAT_TEST_TIMEOUT_MS,
		);

		test(
			"two messages each lost twice come back in the order they were queued, ahead of what is being typed",
			async () => {
				const chat = await busyChat(host, { settings: { steeringMode: "one-at-a-time" } });
				const session = chat.pair?.engine.session ?? chat.mode.session;
				const agent = session.agent;
				// As above, for each message in turn: the first loss as its turn fails to prepare or its run starts, the
				// second as the next run starts.
				const prepare = agent.prepareNextTurnWithContext;
				let failedPreparation = false;
				agent.prepareNextTurnWithContext = async (context, signal) => {
					if (!failedPreparation) {
						failedPreparation = true;
						throw new Error("turn preparation failed");
					}
					return prepare?.(context, signal);
				};
				cleanups.push(
					agent.subscribe((event) => {
						if (event.type === "agent_start" && failedPreparation) throw new Error("refused at start");
					}),
				);
				chat.press("first steer");
				chat.press("\r");
				chat.press("second steer");
				chat.press("\r");
				await chat.settled(/Steering: second steer/);
				chat.press("unfinished draft");

				chat.gate.release.resolve();
				await vi.waitFor(() => assert.match(chat.mode.editor.getText(), /second steer/), { timeout: 20_000 });
				const returned = await chat.settled();
				assert.equal(
					chat.mode.editor.getText(),
					"first steer\n\nsecond steer\n\nunfinished draft",
					returned.join("\n"),
				);
				assert.equal(
					chat.requests.filter((request) => request.includes("steer")).length,
					0,
					chat.requests.join("\n"),
				);
			},
			MAIN_CHAT_TEST_TIMEOUT_MS,
		);

		test(
			"Alt+Up while it is taken gives nothing back and it is sent once, as before the row stayed",
			async () => {
				const hook = gate();
				gates.push(hook);
				const chat = await busyChat(host, { extensions: [holdMessageStart("later one", hook)] });
				chat.press("later one");
				chat.press("\r");
				await chat.settled(/Steering: later one/);

				chat.gate.release.resolve();
				await hook.entered.promise;
				chat.press(DEQUEUE_KEY);
				const afterDequeue = await chat.settled();
				// The session already took the message: the dequeue key has nothing to give back.
				assert.equal(chat.mode.editor.getText(), "");
				assert.deepEqual(shown(afterDequeue, "later one"), { echoes: 0, rows: 1 }, afterDequeue.join("\n"));

				hook.release.resolve();
				const delivered = await chat.settled(echoOf("later one"));
				assert.deepEqual(shown(delivered, "later one"), { echoes: 1, rows: 0 }, delivered.join("\n"));
				assert.equal(
					chat.requests.filter((request) => request.includes("later one")).length,
					1,
					chat.requests.join("\n"),
				);
			},
			MAIN_CHAT_TEST_TIMEOUT_MS,
		);
	},
);

describe("a queued message the isolated engine's main session takes", () => {
	test(
		"stays on screen while a compaction's end holds the engine's events back from the chat (#6080)",
		async () => {
			const chat = await busyChat("isolated");
			const pair = chat.pair;
			assert.ok(pair);
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: later one/);
			// A compaction ended: the host holds later events until its session view caught up, which here it never does.
			const viewCaughtUp = Promise.withResolvers<void>();
			Object.assign(pair.runtime, { refreshSessionView: () => viewCaughtUp.promise });
			cleanups.push(() => viewCaughtUp.resolve());
			pair.engineOutput({
				type: "compaction_end",
				reason: "threshold",
				result: { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1 },
				aborted: false,
				willRetry: false,
			});
			await pair.drain();

			// The turn takes the message; the host reads its queue_update and its message_start, and holds both.
			chat.gate.release.resolve();
			await waitFor("the engine to show the message", () =>
				pair.engine.session.messages.some((message) => getMessageText(message) === "later one"),
			);
			await pair.drain();
			// Something redraws the rows meanwhile, as a key or a view switch can.
			chat.mode.updatePendingMessagesDisplay();
			const rows = shown(chat.mode.pendingMessagesContainer.render(120), "later one").rows;
			const echoes = shown(chat.mode.chatContainer.render(120), "later one").echoes;
			// Queued or in the transcript, once (the hold may have timed out on a slow machine: then it is in the transcript).
			assert.equal(rows + echoes, 1, `${rows} queued, ${echoes} in the transcript`);
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);

	test(
		"is no longer listed once the engine retires the session while delivering it, as before (#6080)",
		async () => {
			const hook = gate();
			gates.push(hook);
			const chat = await busyChat("isolated", { extensions: [holdMessageStart("later one", hook)] });
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: later one/);
			chat.gate.release.resolve();
			await hook.entered.promise;
			await chat.settled();

			chat.pair?.engineMessage({ type: "engine_extension_ui_reset" });
			const after = await chat.settled();
			// Its session will never show it here: nothing lists it, and nothing gives it back.
			assert.deepEqual(shown(after, "later one"), { echoes: 0, rows: 0 }, after.join("\n"));
			assert.equal(chat.mode.editor.getText(), "");
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);

	test(
		"is listed in full as unconfirmed, and neither given back nor sent again, once the engine is lost while delivering it",
		async () => {
			const hook = gate();
			gates.push(hook);
			const chat = await busyChat("isolated", { extensions: [holdMessageStart("later one", hook)] });
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: later one/);
			chat.gate.release.resolve();
			await hook.entered.promise;
			await chat.settled();
			chat.mode.editor.setText("draft");

			chat.pair?.crash();
			// The engine took it: it may have saved it, and the replacement's history cannot always tell.
			const after = await chat.settled(/may not have been delivered/);
			assert.match(after.join("\n"), /this message may not have been delivered:\s+later one/);
			assert.equal(shown(after, "later one").rows, 0, "no longer drawn as queued");
			assert.equal(chat.mode.editor.getText(), "draft", "not given back to edit");
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);

	test(
		"comes back to the editor, as typed, when the replacement's saved session shows the lost engine never saved it",
		async () => {
			const hook = gate();
			gates.push(hook);
			const chat = await busyChat("isolated", { extensions: [holdMessageStart("later one", hook)] });
			// The engine's session is kept the way a session file keeps it: what the lost engine did not write by the time it
			// exited is not there. (Its replacement here reads the same store, as a replacement reads the lost one's file.)
			const store = chat.pair?.engine.sessionManager.getSessionStore();
			assert.ok(store);
			Object.defineProperty(store, "descriptor", { value: { adapter: "jsonl", location: "sessions" } });
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: later one/);
			chat.gate.release.resolve();
			await hook.entered.promise;
			await chat.settled();
			chat.mode.editor.setText("draft");

			chat.pair?.crash();
			// The lost engine took it and never saved it, and its session files say so: nothing to report as unconfirmed.
			const after = await chat.settled(/wasn't sent and is back in the\s+editor/);
			assert.match(after.join("\n"), /1 queued message wasn't sent and is back in the\s+editor/);
			assert.doesNotMatch(after.join("\n"), /may not have been delivered/);
			assert.equal(chat.mode.editor.getText(), "later one\n\ndraft");
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);

	test(
		"rewritten by an input hook, comes back once, as typed, when the lost engine never saved it",
		async () => {
			const hook = gate();
			gates.push(hook);
			const rewrite: ExtensionFactory = (pi) => {
				pi.on("input", (event) => ({ action: "transform", text: `rewritten: ${event.text}` }));
			};
			const chat = await busyChat("isolated", {
				extensions: [rewrite, holdMessageStart("rewritten: later one", hook)],
			});
			const store = chat.pair?.engine.sessionManager.getSessionStore();
			assert.ok(store);
			Object.defineProperty(store, "descriptor", { value: { adapter: "jsonl", location: "sessions" } });
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: rewritten: later one/);
			chat.gate.release.resolve();
			await hook.entered.promise;
			await chat.settled();

			chat.pair?.crash();
			const after = await chat.settled(/wasn't sent and is back in the\s+editor/);
			assert.equal(chat.mode.editor.getText(), "later one", after.join("\n"));
			assert.doesNotMatch(after.join("\n"), /may not have been delivered/);
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);

	test(
		"is neither given back nor reported once the replacement's session shows the lost engine saved it",
		async () => {
			const chat = await busyChat("isolated");
			const pair = chat.pair;
			assert.ok(pair);
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: later one/);
			// The engine saves it, but its message_end never reaches the host before the engine is lost.
			pair.holdHostTrafficFrom(
				(record) =>
					record.type === "message_end" &&
					"message" in record &&
					record.message.role === "user" &&
					getMessageText(record.message) === "later one",
			);
			chat.gate.release.resolve();
			// The chat shows the message as its turn starts it.
			await chat.settled(echoOf("later one"));
			await waitFor("the engine to save the message", () =>
				pair.engine.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && getMessageText(entry.message) === "later one"),
			);
			chat.mode.editor.setText("draft");
			// The chat accounts for the lost engine's messages once the replacement answered which it saved.
			const answered = Promise.withResolvers<void>();
			const find = pair.runtime.findQueuedMessages.bind(pair.runtime);
			Object.assign(pair.runtime, {
				findQueuedMessages: async (messages: Parameters<typeof find>[0]) => {
					try {
						return await find(messages);
					} finally {
						answered.resolve();
					}
				},
			});

			pair.crash();
			await answered.promise;
			const after = await chat.settled();
			assert.doesNotMatch(after.join("\n"), /may not have been delivered|back in the\s+editor/);
			assert.equal(chat.mode.editor.getText(), "draft");
			assert.equal(
				chat.requests.filter((request) => request.includes("later one")).length,
				1,
				chat.requests.join("\n"),
			);
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);

	test(
		"is on the host's screen after every event line the host reads, queued or in the transcript (#6080)",
		async () => {
			const chat = await busyChat("isolated");
			chat.press("later one");
			chat.press("\r");
			await chat.settled(/Steering: later one/);
			// After the chat handled each event line, as the host could paint before reading the next one.
			const gaps: string[] = [];
			const unsubscribe = chat.mode.session.subscribe((event) => {
				const rows = shown(chat.mode.pendingMessagesContainer.render(120), "later one").rows;
				const echoes = shown(chat.mode.chatContainer.render(120), "later one").echoes;
				if (rows + echoes !== 1) gaps.push(`${event.type}: ${rows} queued, ${echoes} in the transcript`);
			});
			try {
				chat.gate.release.resolve();
				await chat.settled(echoOf("later one"));
				assert.deepEqual(gaps, []);
			} finally {
				unsubscribe();
			}
		},
		MAIN_CHAT_TEST_TIMEOUT_MS,
	);
});
