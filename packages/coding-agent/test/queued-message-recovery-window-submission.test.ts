import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { TuiInputListener } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./suite/harness.ts";

type Editor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void> | void;
	onChange?: (text: string) => void;
	onPasteImage?: () => void;
	onAction: (action: string, handler: () => void) => void;
	getText: () => string;
	setText: (text: string) => void;
	getExpandedText?: () => string;
	addToHistory: (text: string) => void;
};

type SubmitHost = {
	session: AgentSession;
	runtimeHost: object;
	ui: {
		onDebug?: () => void;
		addInputListener: (l: TuiInputListener) => () => void;
		requestRender: () => void;
		setFocus: (target: unknown) => void;
	};
	keybindings: { matches: () => boolean };
	settingsManager: { getDoubleEscapeAction: () => "none" };
	defaultEditor: Editor;
	editor: Editor;
	editorContainer: { children: unknown[] };
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	compactionActive: boolean;
	lastEscapeTime: number;
	clearAllQueues: (o?: { preserveUnprotectedCustomMessages?: boolean }) => { steering: string[]; followUp: string[] };
	restoreQueuedMessagesToEditor: (o?: { preserveUnprotectedCustomMessages?: boolean }) => number;
	updatePendingMessagesDisplay: () => void;
	showWorkingLoaderNow: () => void;
	stopWorkingLoader: () => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	errors: string[];
	deferredStartupPending: boolean;
	deferredStartupPromise: Promise<void> | undefined;
	discardDeferredRenderedUserInput: (text: string) => void;
	discarded: string[];
	renderDeferredUserInput: (text: string) => void;
	rendered: string[];
	isExtensionCommand(text: string): boolean;
	tuiInputSubscriptions: Set<{ handler: TuiInputListener; unsubscribe: () => void }>;
	addTuiInputListener: (handler: TuiInputListener) => () => void;
	firstSubmitRecorded: boolean;
	startupReplayActiveInput: string | undefined;
	startupReplayInputs: string[];
	startupCookedInputRecovered: boolean;
	isCompacting: boolean;
	flushPendingBashComponents(): void;
	onInputCallback: ((submission: { text: string; draft: string }) => void) | undefined;
	pendingUserInputs: Array<{ text: string; draft: string }>;
	advanceStartupInputReplay(text: string): void;
	isBashMode: boolean;
	updateEditorBorderColor(): void;
};

const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: SubmitHost) => void;
const setupEditorSubmitHandler = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
	this: SubmitHost,
) => void;
const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
	this: SubmitHost,
	options?: { preserveUnprotectedCustomMessages?: boolean },
) => number;
const clearAllQueues = Reflect.get(InteractiveMode.prototype, "clearAllQueues") as (
	this: SubmitHost,
	options?: { preserveUnprotectedCustomMessages?: boolean },
) => { steering: string[]; followUp: string[] };
const runUserPromptTurn = Reflect.get(InteractiveMode.prototype, "runUserPromptTurn") as (
	this: SubmitHost,
	input: { text: string; draft: string } | string,
) => Promise<void>;

function createSubmitHost(session: AgentSession): SubmitHost {
	let text = "";
	const editor: Editor = {
		onAction() {},
		getText: () => text,
		setText: (next) => {
			text = next;
		},
		addToHistory() {},
	};
	const host: SubmitHost = {
		session,
		runtimeHost: {},
		ui: { addInputListener: () => () => {}, requestRender() {}, setFocus() {} },
		keybindings: { matches: () => false },
		settingsManager: { getDoubleEscapeAction: () => "none" },
		defaultEditor: editor,
		editor,
		editorContainer: { children: [editor] },
		compactionQueuedMessages: [],
		compactionActive: false,
		lastEscapeTime: 0,
		clearAllQueues: (options) => clearAllQueues.call(host, options),
		restoreQueuedMessagesToEditor: (options) => restoreQueuedMessagesToEditor.call(host, options),
		updatePendingMessagesDisplay() {},
		showWorkingLoaderNow() {},
		stopWorkingLoader() {},
		showWarning() {},
		errors: [],
		showError(message) {
			host.errors.push(message);
		},
		deferredStartupPending: false,
		deferredStartupPromise: undefined,
		discarded: [],
		discardDeferredRenderedUserInput(value) {
			host.discarded.push(value);
		},
		rendered: [],
		renderDeferredUserInput(value) {
			host.rendered.push(value);
		},
		isExtensionCommand: () => false,
		tuiInputSubscriptions: new Set(),
		addTuiInputListener: InteractiveMode.prototype.addTuiInputListener,
		firstSubmitRecorded: true,
		startupReplayActiveInput: undefined,
		startupReplayInputs: [],
		startupCookedInputRecovered: false,
		isCompacting: false,
		flushPendingBashComponents() {},
		onInputCallback: undefined,
		pendingUserInputs: [],
		advanceStartupInputReplay() {},
		isBashMode: false,
		updateEditorBorderColor() {},
	};
	setupKeyHandlers.call(host);
	setupEditorSubmitHandler.call(host);
	return host;
}

function askUserQuestionTool(handles: {
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

describe("submitting while the admitted-message recovery turn streams (issue 2362)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("a message submitted while the recovery turn streams still reaches an assistant turn", async () => {
		const opened = Promise.withResolvers<void>();
		const answered = Promise.withResolvers<void>();
		const postDialogStreamStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const recoveryStreamStarted = Promise.withResolvers<void>();
		const releaseRecoveryStream = Promise.withResolvers<void>();
		const harness = await createHarness({ tools: [askUserQuestionTool({ opened, answered })] });
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
			async () => {
				recoveryStreamStarted.resolve();
				await releaseRecoveryStream.promise;
				return fauxAssistantMessage("recovery reply to the queued message");
			},
			fauxAssistantMessage("reply to the typed message"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		const activeTurn = harness.session.prompt("start the ask_user_question turn");
		await opened.promise;
		const host = createSubmitHost(harness.session);
		await harness.session.steer("QUEUED-MESSAGE-XYZ");
		answered.resolve();
		await postDialogStreamStarted.promise;
		host.defaultEditor.onEscape?.();
		await abortObserved.promise;

		// The recovery turn is now streaming while the queue is still paused, which
		// is the window the interactive submit handler cannot route as a steer. The
		// recovery starts inside the turn above, so the outer prompt settling first
		// means there is no window at all — race them rather than waiting forever.
		const recoveryWindow = await Promise.race([
			recoveryStreamStarted.promise.then(() => "recovery" as const),
			activeTurn.then(() => "no recovery turn" as const),
		]);
		assert.equal(recoveryWindow, "recovery", "the admitted-message recovery turn never started");
		assert.equal(harness.session.isStreaming, true);
		assert.equal(harness.session.queuedMessagesPaused, true);

		await host.defaultEditor.onSubmit?.("TYPED-INSIDE-RECOVERY-WINDOW");
		const submission = host.pendingUserInputs.shift();
		assert.deepEqual(submission, {
			text: "TYPED-INSIDE-RECOVERY-WINDOW",
			draft: "TYPED-INSIDE-RECOVERY-WINDOW",
		});
		const submissionTurn =
			submission === undefined ? Promise.resolve() : runUserPromptTurn.call(host, submission).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 25));
		releaseRecoveryStream.resolve();
		await Promise.all([activeTurn, submissionTurn]);
		for (let i = 0; i < 40 && harness.getPendingResponseCount() > 1; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.deepEqual(host.errors, [], `submission failed with: ${host.errors.join(" | ")}`);
		assert.deepEqual(host.discarded, [], "the submitted text was rendered and then discarded");
		assert.equal(
			harness.session.messages.filter((message) => getMessageText(message) === "TYPED-INSIDE-RECOVERY-WINDOW")
				.length,
			1,
			`the submitted text never reached the session; transcript=${JSON.stringify(
				harness.session.messages.map((message) => `${message.role}:${getMessageText(message)}`),
			)}`,
		);
		assert.ok(
			getAssistantTexts(harness).includes("reply to the typed message"),
			`the submitted text never reached an assistant turn; assistantTexts=${JSON.stringify(
				getAssistantTexts(harness),
			)}`,
		);
		assert.ok(
			getAssistantTexts(harness).includes("recovery reply to the queued message"),
			"the admitted queued message lost its recovery reply",
		);
	});
});
