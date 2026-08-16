import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { TuiInputListener } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./suite/harness.ts";

type EscapeEditor = {
	onEscape?: () => void;
	onAction: (action: string, handler: () => void) => void;
	getText: () => string;
	setText: (text: string) => void;
	addToHistory: (text: string) => void;
};

type EscapeHost = {
	session: AgentSession;
	runtimeHost: object;
	ui: { onDebug?: () => void; addInputListener: (l: TuiInputListener) => () => void; requestRender: () => void };
	keybindings: { matches: () => boolean };
	settingsManager: { getDoubleEscapeAction: () => "none" };
	defaultEditor: EscapeEditor;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	editor: EscapeEditor;
	lastEscapeTime: number;
	clearAllQueues: (o?: { preserveUnprotectedCustomMessages?: boolean }) => { steering: string[]; followUp: string[] };
	restoreQueuedMessagesToEditor: (o?: { preserveUnprotectedCustomMessages?: boolean }) => number;
	updatePendingMessagesDisplay: () => void;
	showWorkingLoaderNow: () => void;
	stopWorkingLoader: () => void;
	deferredStartupPending: boolean;
	deferredStartupPromise: Promise<void> | undefined;
	discardDeferredRenderedUserInput: () => void;
	showError: (message: string) => void;
	isExtensionCommand(text: string): boolean;
	tuiInputSubscriptions: Set<{ handler: TuiInputListener; unsubscribe: () => void }>;
	addTuiInputListener: (handler: TuiInputListener) => () => void;
};

const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: EscapeHost) => void;
const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
	this: EscapeHost,
	options?: { preserveUnprotectedCustomMessages?: boolean },
) => number;
const clearAllQueues = Reflect.get(InteractiveMode.prototype, "clearAllQueues") as (
	this: EscapeHost,
	options?: { preserveUnprotectedCustomMessages?: boolean },
) => { steering: string[]; followUp: string[] };

function createEscapeHost(session: AgentSession): EscapeHost {
	let text = "";
	const editor: EscapeEditor = {
		onAction() {},
		getText: () => text,
		setText: (next) => {
			text = next;
		},
		addToHistory() {},
	};
	const host: EscapeHost = {
		session,
		runtimeHost: {},
		ui: { addInputListener: () => () => {}, requestRender() {} },
		keybindings: { matches: () => false },
		settingsManager: { getDoubleEscapeAction: () => "none" },
		defaultEditor: editor,
		compactionQueuedMessages: [],
		editor,
		lastEscapeTime: 0,
		clearAllQueues: (options) => clearAllQueues.call(host, options),
		restoreQueuedMessagesToEditor: (options) => restoreQueuedMessagesToEditor.call(host, options),
		updatePendingMessagesDisplay() {},
		showWorkingLoaderNow() {},
		stopWorkingLoader() {},
		deferredStartupPending: false,
		deferredStartupPromise: undefined,
		isExtensionCommand: () => false,
		discardDeferredRenderedUserInput() {},
		showError(message) {
			throw new Error(message);
		},
		tuiInputSubscriptions: new Set(),
		addTuiInputListener: InteractiveMode.prototype.addTuiInputListener,
	};
	setupKeyHandlers.call(host);
	return host;
}

/** A blocking stand-in for the questionnaire tool: same name, same result envelope. */
function createAskUserQuestionTool(handles: {
	opened: PromiseWithResolvers<void>;
	answered: PromiseWithResolvers<void>;
}): AgentTool {
	return {
		name: "ask_user_question",
		label: "Ask User Question",
		description: "Blocking questionnaire stand-in",
		parameters: Type.Object({ q: Type.String() }),
		execute: async (_id, _params, signal) => {
			handles.opened.resolve();
			await Promise.race([
				handles.answered.promise,
				new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				}),
			]);
			return {
				content: [{ type: "text", text: 'User has answered your questions: "Approach"="Option Alpha".' }],
				details: {},
			};
		},
	};
}

/** Let the session settle without any further user action. */
async function settleWithoutUserAction(harness: Harness, expectedRemainingResponses: number): Promise<void> {
	for (let i = 0; i < 20 && harness.getPendingResponseCount() > expectedRemainingResponses; i++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
/** Long enough that the interrupt lands after some deltas but before the stream ends. */
const PARTIAL_REPLY = "partial reply that the interrupt cuts short after some visible output";

describe("escape with a queued message during an ask_user_question turn (issue 2362)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("a queued message admitted by the ask_user_question answer still reaches an assistant turn after Escape", async () => {
		const dialogOpened = Promise.withResolvers<void>();
		const dialogAnswered = Promise.withResolvers<void>();
		const postDialogStreamStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const askUserQuestion = createAskUserQuestionTool({ opened: dialogOpened, answered: dialogAnswered });
		const harness = await createHarness({ tools: [askUserQuestion] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user_question", { q: "Approach?" })], { stopReason: "toolUse" }),
			async (_context, options) => {
				postDialogStreamStarted.resolve();
				await new Promise<void>((resolve) => {
					const observe = () => {
						abortObserved.resolve();
						resolve();
					};
					if (options?.signal?.aborted) observe();
					else options?.signal?.addEventListener("abort", observe, { once: true });
				});
				return fauxAssistantMessage("aborted before any output");
			},
			fauxAssistantMessage("answer to the queued message"),
		]);

		const activeTurn = harness.session.prompt("start the ask_user_question turn");
		await dialogOpened.promise;
		const host = createEscapeHost(harness.session);
		await harness.session.steer("QUEUED-MESSAGE-XYZ");

		// The user answers the questionnaire; the agent loop admits the queued
		// steering message and opens the next provider request for it.
		dialogAnswered.resolve();
		await postDialogStreamStarted.promise;

		// Real Escape path: defaultEditor.onEscape -> pauseAndAbortInteractiveSession.
		host.defaultEditor.onEscape?.();
		await abortObserved.promise;
		await activeTurn;

		// No further user action from here on.
		await settleWithoutUserAction(harness, 1);

		assert.deepEqual(getUserTexts(harness), ["start the ask_user_question turn", "QUEUED-MESSAGE-XYZ"]);
		assert.equal(
			host.editor.getText(),
			"",
			"the queued message was admitted into the transcript, so it is not recoverable from the editor",
		);
		assert.ok(
			getAssistantTexts(harness).includes("answer to the queued message"),
			`queued message never reached an assistant turn; assistant texts=${JSON.stringify(
				getAssistantTexts(harness),
			)} paused=${harness.session.queuedMessagesPaused} hasQueued=${harness.session.agent.hasQueuedMessages()}`,
		);
	});

	// Timing (a): the queued message is still in the queue when Escape lands, so the
	// documented contract applies unchanged — restore it to the editor, start nothing.
	test("Escape while streaming before the dialog restores the queued message to the editor", async () => {
		const dialogOpened = Promise.withResolvers<void>();
		const dialogAnswered = Promise.withResolvers<void>();
		const firstStreamStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const harness = await createHarness({
			tools: [createAskUserQuestionTool({ opened: dialogOpened, answered: dialogAnswered })],
		});
		harnesses.push(harness);
		harness.setResponses([
			async (_context, options) => {
				firstStreamStarted.resolve();
				await new Promise<void>((resolve) => {
					const observe = () => {
						abortObserved.resolve();
						resolve();
					};
					if (options?.signal?.aborted) observe();
					else options?.signal?.addEventListener("abort", observe, { once: true });
				});
				return fauxAssistantMessage("aborted before any output");
			},
			fauxAssistantMessage("must not be consumed"),
		]);

		const activeTurn = harness.session.prompt("start the turn");
		await firstStreamStarted.promise;
		const host = createEscapeHost(harness.session);
		await harness.session.steer("QUEUED-PLAIN");

		host.defaultEditor.onEscape?.();
		await abortObserved.promise;
		await activeTurn;
		await settleWithoutUserAction(harness, 1);

		assert.deepEqual(getUserTexts(harness), ["start the turn"]);
		assert.equal(host.editor.getText(), "QUEUED-PLAIN");
		assert.equal(harness.session.queuedMessagesPaused, true);
		assert.equal(harness.getPendingResponseCount(), 1, "no turn may be scheduled for a still-queued message");
	});

	// Timing (c): the dialog is open and Escape reaches the editor handler. The queued
	// message has not been polled yet, so it is recoverable and must be restored.
	test("Escape reaching the editor while the dialog is open restores the queued message", async () => {
		const dialogOpened = Promise.withResolvers<void>();
		const dialogAnswered = Promise.withResolvers<void>();
		const harness = await createHarness({
			tools: [createAskUserQuestionTool({ opened: dialogOpened, answered: dialogAnswered })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user_question", { q: "Approach?" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be consumed"),
		]);

		const activeTurn = harness.session.prompt("start the ask_user_question turn");
		await dialogOpened.promise;
		const host = createEscapeHost(harness.session);
		await harness.session.steer("QUEUED-DURING-DIALOG");

		host.defaultEditor.onEscape?.();
		await activeTurn;
		await settleWithoutUserAction(harness, 1);

		assert.deepEqual(getUserTexts(harness), ["start the ask_user_question turn"]);
		assert.equal(host.editor.getText(), "QUEUED-DURING-DIALOG");
		assert.equal(harness.session.queuedMessagesPaused, true);
		// The aborted turn drains the scripted step without streaming it, so assert on
		// the transcript rather than on the remaining response count.
		assert.ok(!getAssistantTexts(harness).includes("must not be consumed"));
	});

	// Timings (d) and (e): Escape when the session is idle, once against a live pause
	// holding a late steer and once again as the second press of a double Escape.
	test("Escape while idle and paused keeps late queued work held and starts no turn", async () => {
		const firstStreamStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async (_context, options) => {
				firstStreamStarted.resolve();
				await new Promise<void>((resolve) => {
					const observe = () => {
						abortObserved.resolve();
						resolve();
					};
					if (options?.signal?.aborted) observe();
					else options?.signal?.addEventListener("abort", observe, { once: true });
				});
				return fauxAssistantMessage("aborted before any output");
			},
			fauxAssistantMessage("must not be consumed"),
		]);

		const activeTurn = harness.session.prompt("start the turn");
		await firstStreamStarted.promise;
		const host = createEscapeHost(harness.session);
		host.defaultEditor.onEscape?.();
		await abortObserved.promise;
		await activeTurn;

		// (d) A late steer arrives against the live pause, then Escape lands while idle.
		await harness.session.steer("LATE-AFTER-PAUSE");
		assert.equal(harness.session.isStreaming, false);
		host.defaultEditor.onEscape?.();
		await settleWithoutUserAction(harness, 1);
		assert.equal(harness.session.queuedMessagesPaused, true);
		assert.equal(harness.getPendingResponseCount(), 1, "an idle Escape must not start a turn");

		// (e) Second press of a double Escape, still idle and still paused.
		host.defaultEditor.onEscape?.();
		await settleWithoutUserAction(harness, 1);
		assert.equal(harness.session.queuedMessagesPaused, true);
		assert.deepEqual(getUserTexts(harness), ["start the turn"]);
		assert.equal(harness.getPendingResponseCount(), 1);
	});

	// Negative: an admitted message whose reply already produced output has been
	// answered. Escape must abort it for good rather than restarting the reply.
	test("Escape does not restart a partially streamed reply to an admitted queued message", async () => {
		const dialogOpened = Promise.withResolvers<void>();
		const dialogAnswered = Promise.withResolvers<void>();
		const firstDeltaSeen = Promise.withResolvers<void>();
		const harness = await createHarness({
			tools: [createAskUserQuestionTool({ opened: dialogOpened, answered: dialogAnswered })],
			// Space the deltas out so Escape can land mid-stream rather than before it.
			fauxProvider: { tokensPerSecond: 40, tokenSize: { min: 1, max: 2 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user_question", { q: "Approach?" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(PARTIAL_REPLY),
			fauxAssistantMessage("must not be consumed"),
		]);
		harness.session.subscribe((event) => {
			if (event.type !== "message_update") return;
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" && update.partial.content.length > 0) firstDeltaSeen.resolve();
		});

		const activeTurn = harness.session.prompt("start the ask_user_question turn");
		await dialogOpened.promise;
		const host = createEscapeHost(harness.session);
		await harness.session.steer("QUEUED-PARTIALLY-ANSWERED");
		dialogAnswered.resolve();
		await firstDeltaSeen.promise;

		host.defaultEditor.onEscape?.();
		await activeTurn;
		await settleWithoutUserAction(harness, 1);

		assert.deepEqual(getUserTexts(harness), ["start the ask_user_question turn", "QUEUED-PARTIALLY-ANSWERED"]);
		const replies = getAssistantTexts(harness);
		const reply = replies[replies.length - 1];
		// How many deltas landed before the interrupt is timing dependent; that some
		// output was already shown is not.
		assert.ok(reply !== undefined && reply.length > 0, `expected a partially streamed reply, got ${reply}`);
		assert.ok(PARTIAL_REPLY.startsWith(reply), `expected a prefix of the scripted reply, got ${reply}`);
		assert.equal(
			harness.getPendingResponseCount(),
			1,
			"a reply that already produced output must not be restarted by the interrupt",
		);
	});
});
