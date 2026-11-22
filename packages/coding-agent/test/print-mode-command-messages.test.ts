/** `atomic -p` prints what an extension command answers with a message it queues (#6113). */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { removeTestDirectory } from "../../../test/helpers/test-directory-removal.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const directories: string[] = [];
const timers = new Set<ReturnType<typeof setInterval>>();
afterEach(async () => {
	for (const timer of timers) clearInterval(timer);
	timers.clear();
	vi.restoreAllMocks();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (directories.length > 0) removeTestDirectory(directories.pop()!, { retries: 10, retryDelayMs: 100 });
});

/** Commands that answer the way `/curator` and `/google-account` do: with a message they send and do not await. */
function answeringCommands(atomic: ExtensionAPI): void {
	atomic.registerCommand("toggle", {
		description: "Confirms with a message that starts no turn",
		handler: async () => {
			void atomic.sendMessage(
				{ customType: "toggle", content: [{ type: "text", text: "Toggle disabled" }], display: true },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		},
	});
	atomic.registerCommand("account", {
		description: "Answers with a message that starts a turn",
		handler: async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			void atomic.sendMessage(
				{
					customType: "account",
					content: [{ type: "text", text: "Active account: a@example.com" }],
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
	atomic.registerCommand("broken", {
		description: "Confirms with a message that cannot be saved",
		handler: async () => {
			void atomic.sendMessage(
				{ customType: "broken", content: "Toggle disabled", display: true, details: { size: 1n } },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		},
	});
	atomic.registerCommand("quiet", {
		description: "Catches the failure of a message that cannot be saved and answers nothing else",
		handler: async () => {
			try {
				await atomic.sendMessage({ customType: "broken", content: "first", display: true, details: { size: 1n } });
			} catch {}
		},
	});
	atomic.registerCommand("recover", {
		description: "Answers again when its first message cannot be saved",
		handler: async () => {
			try {
				await atomic.sendMessage({ customType: "broken", content: "first", display: true, details: { size: 1n } });
			} catch {
				await atomic.sendMessage({ customType: "recovered", content: "Recovered", display: true });
			}
		},
	});
	const settledWaiters: Array<() => void> = [];
	atomic.on("agent_settled", () => {
		for (const settled of settledWaiters.splice(0)) settled();
	});
	atomic.registerCommand("summary", {
		description: "Starts a turn, waits until it settles, then adds a hidden note",
		handler: async () => {
			const settled = new Promise<void>((resolve) => settledWaiters.push(resolve));
			await atomic.sendMessage(
				{ customType: "summary", content: "Summarize", display: true },
				{ triggerTurn: true },
			);
			await settled;
			await atomic.sendMessage({ customType: "summary-note", content: "noted", display: false });
		},
	});
	atomic.registerCommand("noop", { description: "Answers nothing", handler: async () => {} });
	// Preparing the user message's turn takes a moment, as a hook that reads a file does.
	atomic.on("before_agent_start", async (event) => {
		if (event.messageType === "user") await new Promise((resolve) => setTimeout(resolve, 0));
	});
	atomic.registerCommand("ask", {
		description: "Asks the model as the user would",
		handler: async () => {
			atomic.sendUserMessage("Which account am I using?", { deliverAs: "followUp" });
		},
	});
	atomic.registerCommand("urgent", {
		description: "Answers with a message that interrupts",
		handler: async () => {
			void atomic.sendMessage(
				{ customType: "urgent", content: "Check the account now", display: true },
				{ triggerTurn: true, deliverAs: "interrupt" },
			);
		},
	});
	atomic.registerCommand("ticker", {
		description: "Confirms, and leaves a timer that keeps sending messages that start turns",
		handler: async () => {
			void atomic.sendMessage(
				{ customType: "toggle", content: [{ type: "text", text: "Ticker started" }], display: true },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
			const timer = setInterval(() => {
				try {
					void Promise.resolve(
						atomic.sendMessage(
							{ customType: "tick", content: "tick", display: true },
							{ triggerTurn: true, deliverAs: "followUp" },
						),
					).catch(() => {});
				} catch {}
			}, 50);
			timers.add(timer);
		},
	});
	atomic.registerCommand("later", {
		description: "Adds context to the next turn only",
		handler: async () => {
			void atomic.sendMessage(
				{ customType: "later", content: [{ type: "text", text: "Use the staging account" }], display: true },
				{ deliverAs: "nextTurn" },
			);
		},
	});
}

/**
 * A session saved in session files that already holds an earlier exchange, as `atomic --session <id> -p` resumes one.
 * Its writes take file I/O, as a real session's do.
 */
async function sessionWithEarlierReply(earlier: AssistantMessage, ...replies: FauxResponseStep[]): Promise<Harness> {
	const directory = mkdtempSync(join(tmpdir(), "print-command-messages-"));
	directories.push(directory);
	const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
	const earlierRun = await SessionManager.create(store, directory);
	await earlierRun.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	await earlierRun.appendMessage(earlier);
	const sessionManager = await SessionManager.open(store, earlierRun.getSessionId());
	const harness = await createHarness({ sessionManager, extensionFactories: [answeringCommands] });
	harnesses.push(harness);
	harness.session.refreshContext();
	harness.setResponses(replies);
	return harness;
}

function runtimeHostFor(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		setRebindSession: () => {},
		dispose: () => harness.session.dispose(),
	} as unknown as AgentSessionRuntime;
}

function captureOutput(): { stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			stdout.push(String(chunk));
			if (typeof encodingOrCallback === "function") encodingOrCallback();
			else callback?.();
			return true;
		},
	);
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderr.push(args.map(String).join(" "));
	});
	return { stdout, stderr };
}

function lastSavedMessage(harness: Harness) {
	const messages = harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	return messages[messages.length - 1];
}

test("prints the confirmation a command queues without a turn, not the earlier reply (#6113)", async () => {
	const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier answer"));
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/toggle" });

	assert.equal(exitCode, 0);
	assert.equal(output.stdout.join(""), "Toggle disabled\n");
	assert.deepEqual(output.stderr, []);
});

test("prints the reply of the turn a command's message starts, and saves no aborted turn (#6113)", async () => {
	const harness = await sessionWithEarlierReply(
		fauxAssistantMessage("earlier answer"),
		fauxAssistantMessage("You are signed in as a@example.com."),
	);
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/account" });

	assert.equal(exitCode, 0);
	assert.equal(output.stdout.join(""), "You are signed in as a@example.com.\n");
	assert.deepEqual(output.stderr, []);
	const saved = lastSavedMessage(harness);
	assert.equal(saved?.role, "assistant");
	assert.equal((saved as AssistantMessage).stopReason, "stop");
	assert.equal(harness.getPendingResponseCount(), 0);
});

for (const [command, how] of [
	["ask", "a user message"],
	["urgent", "an interrupting message"],
] as const) {
	test(`prints the reply to ${how} a command sends (#6113)`, async () => {
		const harness = await sessionWithEarlierReply(
			fauxAssistantMessage("earlier answer"),
			fauxAssistantMessage("You are signed in as a@example.com."),
		);
		const output = captureOutput();

		const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: `/${command}` });

		assert.equal(exitCode, 0);
		assert.equal(output.stdout.join(""), "You are signed in as a@example.com.\n");
		assert.deepEqual(output.stderr, []);
	});
}

test("a JSON run streams the command's turn to its end before it exits (#6113)", async () => {
	const harness = await sessionWithEarlierReply(
		fauxAssistantMessage("earlier answer"),
		fauxAssistantMessage("You are signed in as a@example.com."),
	);
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "json", initialMessage: "/account" });

	assert.equal(exitCode, 0);
	const events = output.stdout
		.join("")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { type: string; message?: { role: string; stopReason?: string } });
	const replies = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
	assert.deepEqual(
		replies.map((event) => event.message?.stopReason),
		["stop"],
	);
	assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
});

test("a later prompt in the same run waits for the command's turn instead of being refused (#6113)", async () => {
	const harness = await sessionWithEarlierReply(
		fauxAssistantMessage("earlier answer"),
		fauxAssistantMessage("You are signed in as a@example.com."),
		fauxAssistantMessage("You're welcome."),
	);
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), {
		mode: "text",
		initialMessage: "/account",
		messages: ["thanks"],
	});

	assert.equal(exitCode, 0);
	assert.equal(output.stdout.join(""), "You're welcome.\n");
	assert.deepEqual(output.stderr, []);
});

test("an earlier reply cut at the output limit does not mark a command's answer truncated (#6113)", async () => {
	const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier, cut", { stopReason: "length" }));
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/toggle" });

	assert.equal(exitCode, 0);
	assert.equal(output.stdout.join(""), "Toggle disabled\n");
	assert.deepEqual(output.stderr, []);
});

test("a command whose message cannot be saved fails the run and never prints the earlier reply (#6113)", async () => {
	const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier answer"));
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/broken" });

	assert.equal(exitCode, 1);
	assert.equal(output.stdout.join(""), "");
	assert.equal(output.stderr.length, 1);
	assert.match(output.stderr[0] ?? "", /^Extension error \(<runtime>\): /);
});

for (const command of ["broken", "quiet"]) {
	test(`a JSON run keeps exit 0 when /${command}'s message cannot be saved (#6113)`, async () => {
		const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier answer"));
		const output = captureOutput();

		const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "json", initialMessage: `/${command}` });

		assert.equal(exitCode, 0);
		assert.equal(output.stderr.length, 1);
		assert.match(output.stderr[0] ?? "", /^Extension error \(<runtime>\): /);
		const events = output.stdout
			.join("")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string } });
		assert.deepEqual(
			events.filter((event) => event.type === "message_end").map((event) => event.message?.role),
			[],
		);
	});
}

test("a command that answers again after its first message fails prints that answer (#6113)", async () => {
	const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier answer"));
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/recover" });

	assert.equal(exitCode, 0);
	assert.equal(output.stdout.join(""), "Recovered\n");
	assert.equal(output.stderr.length, 1);
	assert.match(output.stderr[0] ?? "", /^Extension error \(<runtime>\): /);
});

test("a reply the command's own turn cut at the output limit is still reported behind its hidden note (#6113)", async () => {
	// A cut reply is continued once; the continuation is cut again.
	const harness = await sessionWithEarlierReply(
		fauxAssistantMessage("earlier answer"),
		fauxAssistantMessage("Summary, cut", { stopReason: "length" }),
		fauxAssistantMessage("Summary, cut again", { stopReason: "length" }),
	);
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/summary" });

	const last = harness.session.state.messages[harness.session.state.messages.length - 1];
	assert.equal(last?.role === "custom" ? last.customType : last?.role, "summary-note");
	assert.equal(exitCode, 1);
	assert.equal(output.stdout.join(""), "");
	assert.deepEqual(output.stderr, ["Response was truncated: the model reached its output token limit."]);
});

test("a command that answers nothing still reports an earlier reply cut at the output limit (#6113)", async () => {
	const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier, cut", { stopReason: "length" }));
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/noop" });

	assert.equal(exitCode, 1);
	assert.equal(output.stdout.join(""), "earlier, cut\n");
	assert.deepEqual(output.stderr, ["Response was truncated: the model reached its output token limit."]);
});

test("a timer a command leaves running does not keep the run going (#6113)", async () => {
	// Each tick's turn outlasts the tick interval, and saving the command's confirmation takes a moment, so ticks keep
	// arriving while the run waits for that confirmation. The model answers every tick for far longer than the test may
	// run: a run that waited for the ticks would never end.
	const harness = await sessionWithEarlierReply(
		fauxAssistantMessage("earlier answer"),
		...Array.from({ length: 2000 }, () => async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			return fauxAssistantMessage("tock");
		}),
	);
	const append = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
	vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementation(async (customType, ...rest) => {
		if (customType === "toggle") await new Promise((resolve) => setTimeout(resolve, 150));
		return append(customType, ...rest);
	});
	captureOutput();

	await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/ticker" });

	for (const timer of timers) clearInterval(timer);
	assert.ok(
		harness.sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom_message" && entry.customType === "toggle"),
	);
});

test("a command that only adds context to the next turn starts no turn (#6113)", async () => {
	const harness = await sessionWithEarlierReply(
		fauxAssistantMessage("earlier answer"),
		fauxAssistantMessage("unused"),
	);
	const output = captureOutput();

	const exitCode = await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/later" });

	assert.equal(exitCode, 0);
	assert.equal(harness.getPendingResponseCount(), 1);
	assert.equal(output.stdout.join(""), "earlier answer\n");
});

test("outside print mode a command still returns before the turn its message starts (#6113)", async () => {
	const reply = Promise.withResolvers<void>();
	const harness = await sessionWithEarlierReply(fauxAssistantMessage("earlier answer"), async () => {
		await reply.promise;
		return fauxAssistantMessage("You are signed in as a@example.com.");
	});
	let ended = false;
	const turnEnded = new Promise<void>((resolve) => {
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			ended = true;
			resolve();
		});
	});

	// The reply cannot arrive before it is released below: waiting for the turn here would never return.
	await harness.session.prompt("/account");

	assert.equal(ended, false);
	reply.resolve();
	await turnEnded;
	assert.equal(lastSavedMessage(harness)?.role, "assistant");
});
