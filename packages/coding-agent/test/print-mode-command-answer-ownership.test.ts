/**
 * `atomic -p` prints an extension command's own answer: the message it saved, or the reply of the turn its message
 * started, even when another sender saves a message after it, and waits for a turn its message asks for while the
 * session finishes an earlier run (#6113).
 */
import assert from "node:assert/strict";
import { type FauxResponseStep, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/index.js";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	vi.restoreAllMocks();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

/** A gate a test opens; opened at the latest when the test ends. */
function gate(): PromiseWithResolvers<void> {
	const opened = Promise.withResolvers<void>();
	releases.push(() => opened.resolve());
	return opened;
}

async function harnessWith(extension: ExtensionFactory, ...replies: FauxResponseStep[]): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [extension] });
	harnesses.push(harness);
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

/** A notice another sender saves to the session, outside any command. */
function foreignNotice(pi: ExtensionAPI): Promise<void> {
	return pi.sendMessage({ customType: "notice", content: "Unrelated notice", display: true });
}

/**
 * `/answer` answers as `how` says, then waits until the test lets it return; `answered` opens once its answer is
 * saved.
 */
function answeringCommand(
	how: "message" | "turn",
	answered: PromiseWithResolvers<void>,
	finish: PromiseWithResolvers<void>,
	api: { pi?: ExtensionAPI },
): ExtensionFactory {
	return (pi) => {
		api.pi = pi;
		pi.registerCommand("answer", {
			description: "Answers, then waits",
			handler: async () => {
				if (how === "message") {
					await pi.sendMessage({ customType: "answer", content: "Own answer", display: true });
				} else {
					const settled = new Promise<void>((resolve) => {
						const stop = pi.on("agent_settled", () => {
							stop?.();
							resolve();
						});
					});
					await pi.sendMessage(
						{ customType: "question", content: "Which account?", display: true },
						{ triggerTurn: true },
					);
					await settled;
				}
				answered.resolve();
				await finish.promise;
			},
		});
	};
}

for (const how of ["message", "turn"] as const) {
	test(`prints the command's own ${how === "message" ? "message" : "turn's reply"}, not a message another sender saved after it`, async () => {
		const answered = gate();
		const finish = gate();
		const api: { pi?: ExtensionAPI } = {};
		const harness = await harnessWith(
			answeringCommand(how, answered, finish, api),
			fauxAssistantMessage("Signed in as a@example.com."),
		);
		const output = captureOutput();

		const run = runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/answer" });
		await answered.promise;
		await foreignNotice(api.pi!);
		finish.resolve();

		assert.equal(await run, 0);
		assert.equal(output.stdout.join(""), how === "message" ? "Own answer\n" : "Signed in as a@example.com.\n");
		assert.deepEqual(output.stderr, []);
	});
}

for (const mode of ["text", "json"] as const) {
	test(`a command whose turn failed fails the run (${mode}) though another sender saved a message after it`, async () => {
		const answered = gate();
		const finish = gate();
		const api: { pi?: ExtensionAPI } = {};
		const harness = await harnessWith(
			answeringCommand("turn", answered, finish, api),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "account service unavailable" }),
		);
		const output = captureOutput();

		const run = runPrintMode(runtimeHostFor(harness), { mode, initialMessage: "/answer" });
		await answered.promise;
		await foreignNotice(api.pi!);
		finish.resolve();

		assert.equal(await run, 1);
		if (mode === "text") {
			assert.equal(output.stdout.join(""), "");
			assert.equal(output.stderr.length, 1);
			assert.match(output.stderr[0] ?? "", /^Model faux\/faux-1 failed: /);
		}
	});
}

test("a JSON run still fails when the session's last message is another run's failed reply", async () => {
	const answered = gate();
	const finish = gate();
	const api: { pi?: ExtensionAPI } = {};
	const harness = await harnessWith(
		answeringCommand("message", answered, finish, api),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exceeded" }),
	);
	const output = captureOutput();

	const run = runPrintMode(runtimeHostFor(harness), { mode: "json", initialMessage: "/answer" });
	await answered.promise;
	// Another run fails after the command answered: the JSON stream shows it as the session's last message.
	await harness.session.prompt("another question").catch(() => {});
	finish.resolve();

	assert.equal(await run, 1);
	assert.ok(output.stdout.join("").includes("quota exceeded"));
});

test("a command that answers and then opens a new session prints the new session, not its old answer", async () => {
	const cleanups: Harness[] = [];
	const extension: ExtensionFactory = (pi) => {
		pi.registerCommand("move", {
			description: "Answers, then leaves the conversation",
			handler: async (_args, ctx) => {
				await pi.sendMessage({ customType: "old", content: "Answer in the old session", display: true });
				await ctx.newSession();
			},
		});
	};
	const harness = await harnessWith(extension);
	const services = (target: Harness) =>
		({
			cwd: target.tempDir,
			agentDir: target.tempDir,
			modelRuntime: target.session.modelRuntime,
			settingsManager: target.settingsManager,
			resourceLoader: target.session.resourceLoader,
			diagnostics: [],
		}) as never;
	const runtime = new AgentSessionRuntime(harness.session, services(harness), async (options) => {
		const next = await createHarness({ sessionManager: options.sessionManager });
		cleanups.push(next);
		return { session: next.session, services: services(next), diagnostics: [] };
	});
	const output = captureOutput();

	try {
		assert.equal(await runPrintMode(runtime, { mode: "text", initialMessage: "/move" }), 0);
		assert.notEqual(runtime.session, harness.session, "the command moved to a new session");
		assert.equal(output.stdout.join(""), "");
	} finally {
		for (const next of cleanups) await next.cleanup();
	}
});

/**
 * `/answer` waits until an earlier run of the session is in its `agent_settled` handlers, which hold any turn asked for
 * meanwhile until they finish, then asks the model as the user would and returns.
 */
function askingWhileSettling(
	settling: PromiseWithResolvers<void>,
	finishSettling: PromiseWithResolvers<void>,
	asked: PromiseWithResolvers<void>,
	earlierDelivery?: () => Promise<void>,
): ExtensionFactory {
	return (pi) => {
		let settles = 0;
		pi.on("agent_settled", async () => {
			if (++settles !== 1) return;
			await earlierDelivery?.();
			settling.resolve();
			await finishSettling.promise;
		});
		pi.registerCommand("answer", {
			description: "Asks while an earlier run settles",
			handler: async () => {
				await settling.promise;
				pi.sendUserMessage("Which account am I using?");
				asked.resolve();
			},
		});
	};
}

for (const mode of ["text", "json"] as const) {
	test(`waits for the turn a command asks for while an earlier run settles, and prints its reply (${mode})`, async () => {
		const settling = gate();
		const finishSettling = gate();
		const asked = gate();
		const harness = await harnessWith(
			askingWhileSettling(settling, finishSettling, asked),
			fauxAssistantMessage("Earlier reply"),
			fauxAssistantMessage("Signed in as a@example.com."),
		);
		const output = captureOutput();

		const run = runPrintMode(runtimeHostFor(harness), { mode, initialMessage: "/answer" });
		const earlier = harness.session.prompt("earlier question");
		await asked.promise;
		finishSettling.resolve();
		await earlier;

		assert.equal(await run, 0);
		assert.deepEqual(getUserTexts(harness), ["earlier question", "Which account am I using?"]);
		if (mode === "text") assert.equal(output.stdout.join(""), "Signed in as a@example.com.\n");
		else {
			const ends = output.stdout
				.join("")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } })
				.filter((event) => event.type === "agent_end");
			assert.equal(ends.length, 2, "the stream reaches the end of the command's turn");
		}
	});
}

test("a turn a command asked for that never runs, because an earlier held one failed, does not keep the run going", async () => {
	const settling = gate();
	const finishSettling = gate();
	const asked = gate();
	let harness: Harness | undefined;
	// The earlier run's settled handler asks for a turn of its own too, which fails before the command's can run.
	const earlierDelivery = async () => {
		await harness?.session.prompt("/missing-command-turn", {
			preflightResult: () => {
				throw new Error("earlier delivery failed");
			},
		});
	};
	harness = await harnessWith(
		askingWhileSettling(settling, finishSettling, asked, earlierDelivery),
		fauxAssistantMessage("Earlier reply"),
		fauxAssistantMessage("never asked"),
	);
	const output = captureOutput();

	const run = runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "/answer" });
	const earlier = harness.session.prompt("earlier question").catch((error: Error) => error.message);
	await asked.promise;
	finishSettling.resolve();
	assert.equal(await earlier, "earlier delivery failed");

	// The command's message was never delivered: as when it cannot be saved, nothing earlier is printed for it.
	assert.equal(await run, 1);
	assert.equal(output.stdout.join(""), "");
	assert.deepEqual(getUserTexts(harness), ["earlier question"]);
});
