import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage } from "@bastani/pi-ai/compat";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import { ChatSessionHost, type ChatSessionHostStyle } from "../../packages/coding-agent/src/index.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.ts";
import { deferred, waitForMicrotasks } from "./executor-shared.ts";

beforeAll(() => initTheme("dark", false));

const style: ChatSessionHostStyle = {
	dim: (text) => text,
	text: (text) => text,
	textMuted: (text) => text,
	accent: (text) => text,
	accentBold: (text) => text,
	rule: (_hex, text) => text,
	cursor: () => "▌",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
		normal: (text: string) => text,
	},
} as EditorTheme;

function abortableResponse(
	started: PromiseWithResolvers<void>,
	finish: PromiseWithResolvers<void>,
): FauxResponseFactory {
	return async (_context, options) => {
		started.resolve();
		await new Promise<void>((resolve) => {
			const observeAbort = () => {
				void finish.promise.then(resolve);
			};
			if (options?.signal?.aborted) observeAbort();
			else options?.signal?.addEventListener("abort", observeAbort, { once: true });
		});
		return fauxAssistantMessage("interrupted");
	};
}

test("ChatSessionHost submits through one resume before and after Escape settlement", async () => {
	const harness = await createHarness();
	try {
		const firstStarted = deferred<void>();
		const finishFirstAbort = deferred<void>();
		const secondStarted = deferred<void>();
		const finishSecondAbort = deferred<void>();
		harness.setResponses([
			abortableResponse(firstStarted, finishFirstAbort),
			fauxAssistantMessage("immediate resume accepted"),
			abortableResponse(secondStarted, finishSecondAbort),
			fauxAssistantMessage("settled resume accepted"),
		]);
		let paused = false;
		let resumeCalls = 0;
		let interruptCalls = 0;
		let interruptAcknowledged = deferred<void>();
		const host = new ChatSessionHost({
			style,
			editorTheme,
			getAgentSession: () => harness.session,
			isStreaming: () => harness.session.isStreaming,
			isPaused: () => paused,
			commands: {
				async interrupt() {
					interruptCalls += 1;
					await harness.session.abort();
					paused = true;
					interruptAcknowledged.resolve();
				},
				async resume(text) {
					resumeCalls += 1;
					assert.equal(paused, true);
					if (text === undefined) throw new Error("resume text is required");
					await harness.session.resumeQueuedMessages();
					paused = false;
					await harness.session.prompt(text);
				},
			},
		});

		const firstTurn = harness.session.prompt("first active turn");
		await firstStarted.promise;
		host.setInputText("submit before abort settles");
		host.handleInput("\x1b");
		const immediateSubmit = host.submit();
		await waitForMicrotasks();

		assert.equal(resumeCalls, 0);
		assert.equal(host.inputText(), "submit before abort settles");
		assert.equal(harness.getPendingResponseCount(), 3);

		finishFirstAbort.resolve();
		await Promise.all([firstTurn, immediateSubmit]);
		assert.equal(resumeCalls, 1);
		assert.equal(host.inputText(), "");

		const secondTurn = harness.session.prompt("second active turn");
		await secondStarted.promise;
		interruptAcknowledged = deferred<void>();
		host.handleInput("\x1b");
		finishSecondAbort.resolve();
		await Promise.all([secondTurn, interruptAcknowledged.promise]);
		assert.equal(paused, true);

		host.setInputText("submit after abort settles");
		await host.submit();

		assert.equal(interruptCalls, 2);
		assert.equal(resumeCalls, 2);
		assert.equal(harness.session.queuedMessagesPaused, false);
		assert.equal(harness.session.agent.hasQueuedMessages(), false);
		assert.deepEqual(
			getUserTexts(harness).filter((text) => text.startsWith("submit ")),
			["submit before abort settles", "submit after abort settles"],
		);
		host.dispose();
	} finally {
		harness.cleanup();
	}
});

for (const submitTiming of ["before", "after"] as const) {
	test(`ChatSessionHost preserves verbatim input when pause rejects ${submitTiming} settlement`, async () => {
		const harness = await createHarness();
		try {
			const pauseError = new Error(`pause failed ${submitTiming} settlement`);
			const interruptStarted = deferred<void>();
			const rejectInterrupt = deferred<void>();
			let resumeCalls = 0;
			harness.setResponses([fauxAssistantMessage("recovered submit accepted")]);
			const host = new ChatSessionHost({
				style,
				editorTheme,
				getAgentSession: () => harness.session,
				isPaused: () => false,
				commands: {
					async interrupt() {
						interruptStarted.resolve();
						await rejectInterrupt.promise;
						throw pauseError;
					},
					async resume() {
						resumeCalls += 1;
					},
					async prompt(text) {
						await harness.session.prompt(text);
					},
				},
			});
			const verbatimInput = "\tverbatim recovery draft  \n";
			host.setInputText(verbatimInput);
			const interrupt = host.interrupt();
			const interruptFailure = assert.rejects(interrupt, (error) => error === pauseError);
			await interruptStarted.promise;

			let failedSubmit: Promise<void>;
			if (submitTiming === "before") {
				failedSubmit = host.submit();
				await waitForMicrotasks();
				rejectInterrupt.resolve();
				await interruptFailure;
			} else {
				rejectInterrupt.resolve();
				await interruptFailure;
				await waitForMicrotasks();
				failedSubmit = host.submit();
			}
			await failedSubmit;

			assert.equal(resumeCalls, 0);
			assert.equal(host.inputText(), verbatimInput);
			assert.equal(host.statusText(), pauseError.message);
			assert.deepEqual(getUserTexts(harness), []);

			await harness.session.resumeQueuedMessages();
			await host.submit();

			assert.equal(host.inputText(), "");
			assert.deepEqual(getUserTexts(harness), [verbatimInput.trim()]);
			host.dispose();
		} finally {
			harness.cleanup();
		}
	});
}

test("disabled chat composers still dispatch local slash commands, but disposed hosts do not", async () => {
	const commands: string[] = [];
	const host = new ChatSessionHost({
		style,
		editorTheme,
		isDisabled: () => true,
		commands: {
			async handleSlashCommand(text) {
				commands.push(text);
				return true;
			},
		},
	});
	try {
		await host.submit("auto", "/quit");
		assert.deepEqual(commands, ["/quit"]);
		host.dispose();
		await host.submit("auto", "/tasks");
		assert.deepEqual(commands, ["/quit"]);
	} finally {
		host.dispose();
	}
});

test.each(["idle", "streaming", "local"] as const)("warnings clear on later %s input, not cleanup", async (path) => {
	const host = new ChatSessionHost({
		style,
		editorTheme,
		isStreaming: () => path === "streaming",
		commands: {
			async prompt() {},
			async steer() {},
			handleSlashCommand: () => true,
		},
	});
	try {
		host.showWarning("Task inspection is unavailable in this host.");
		host.clearBusyForTerminalWorkflowStage();
		assert.equal(host.statusText(), "Task inspection is unavailable in this host.");
		await host.submit("auto", path === "local" ? "/quit" : "next input");
		assert.equal(host.statusText(), "");
		host.clearBusyForTerminalWorkflowStage();
		assert.equal(host.statusText(), "");
	} finally {
		host.dispose();
	}
});

test.each(["auto", "followUp"] as const)("interrupt settlement retains %s intent and new warnings", async (mode) => {
	const release = Promise.withResolvers<void>();
	const calls: Array<{ text?: string; mode?: string }> = [];
	const host = new ChatSessionHost({
		style,
		editorTheme,
		commands: {
			interrupt: () => release.promise,
			async resume(text, submitMode) {
				calls.push({ text, mode: submitMode });
				host.showWarning("Unknown skill selector after pause");
			},
		},
	});
	try {
		const interrupt = host.interrupt();
		const submit = host.submit(mode, "/skill:fixture@unknown");
		assert.deepEqual(calls, []);
		release.resolve();
		await Promise.all([interrupt, submit]);
		assert.deepEqual(calls, [{ text: "/skill:fixture@unknown", mode }]);
		assert.equal(host.statusText(), "Unknown skill selector after pause");
	} finally {
		release.resolve();
		host.dispose();
	}
});
