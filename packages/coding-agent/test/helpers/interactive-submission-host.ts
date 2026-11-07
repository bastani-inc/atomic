import { type Component, Container } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import type { InteractiveSubmission } from "../../src/modes/interactive/interactive-submission.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

type Editor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void> | void;
	onChange?: (text: string) => void;
	onPasteImage?: () => void;
	onAction: (action: string, handler: () => void) => void;
	/** Handlers registered through `onAction`, so a test can press a key action as the editor would. */
	actions: Map<string, () => void>;
	getText: () => string;
	setText: (text: string) => void;
	getExpandedText?: () => string;
	addToHistory: (text: string) => void;
};

export interface InteractiveSubmissionHost {
	session: AgentSession;
	runtimeHost: object;
	ui: {
		onDebug?: () => void;
		addInputListener: () => () => void;
		requestRender: () => void;
		setFocus: (target: object) => void;
	};
	keybindings: { matches: () => boolean };
	settingsManager: { getDoubleEscapeAction: () => "none" };
	defaultEditor: Editor;
	editor: Editor;
	editorContainer: { children: object[] };
	pendingMessagesContainer: Container;
	pendingBashComponents: Component[];
	tuiInputSubscriptions: Set<object>;
	addTuiInputListener: () => () => void;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	compactionActive: boolean;
	compactionFlushPending: boolean;
	compactionSendFailed: boolean;
	lastEscapeTime: number;
	deferredStartupPending: boolean;
	deferredStartupPromise: Promise<void> | undefined;
	promptTurnWorkingLoaderActive: boolean;
	promptTurn: { dispatched: boolean } | undefined;
	firstSubmitRecorded: boolean;
	inputHandlerReadyRecorded: boolean;
	startupReplayActiveInput: string | undefined;
	startupReplayInputs: string[];
	isBashMode: boolean;
	onInputCallback: ((submission: InteractiveSubmission) => void) | undefined;
	pendingUserInputs: InteractiveSubmission[];
	notices: string[];
	rendered: string[];
	discarded: string[];
	getAppKeyDisplay: (action: string) => string;
	showWorkingLoaderNow: () => void;
	stopWorkingLoader: () => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ensureDeferredStartupComplete: () => Promise<void>;
	renderDeferredUserInput: (text: string) => void;
	discardDeferredRenderedUserInput: (text: string) => void;
	expectStartedUserInput: (text: string, shownBefore: number) => void;
	userMessagesShownBySession: number;
	flushPendingBashComponents: () => void;
	updateEditorBorderColor: () => void;
	isExtensionCommand: (text: string) => boolean;
	getAllQueuedMessages: () => { steering: string[]; followUp: string[] };
	clearAllQueues: (options?: { preserveUnprotectedCustomMessages?: boolean }) => {
		steering: string[];
		followUp: string[];
	};
	restoreQueuedMessagesToEditor: (options?: { preserveUnprotectedCustomMessages?: boolean }) => number;
	handleDequeue: () => void;
	updatePendingMessagesDisplay: () => void;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp") => void;
	flushCompactionQueue: (options?: { willRetry?: boolean }) => Promise<void>;
	deliverStartupReplayPrompt: (text: string) => void;
	drainStartupReplayCommands: () => Promise<void>;
	advanceStartupInputReplay: (text: string) => void;
	getUserInput: () => Promise<InteractiveSubmission>;
	runUserPromptTurn: (input: InteractiveSubmission | string) => Promise<void>;
	setupKeyHandlers: () => void;
	setupEditorSubmitHandler: () => void;
	handleFollowUp: () => Promise<void>;
	getUserMessageText: InteractiveMode["getUserMessageText"];
}

const BOUND_MODE_METHODS = [
	"getAllQueuedMessages",
	"clearAllQueues",
	"restoreQueuedMessagesToEditor",
	"handleDequeue",
	"updatePendingMessagesDisplay",
	"queueCompactionMessage",
	"flushCompactionQueue",
	"deliverStartupReplayPrompt",
	"drainStartupReplayCommands",
	"advanceStartupInputReplay",
	"getUserInput",
	"runUserPromptTurn",
	"setupKeyHandlers",
	"setupEditorSubmitHandler",
	"handleFollowUp",
	"getUserMessageText",
] as const;

export function createInteractiveSubmissionHost(session: AgentSession): InteractiveSubmissionHost {
	initTheme("dark");
	let text = "";
	const actions = new Map<string, () => void>();
	const editor: Editor = {
		onAction: (action, handler) => {
			actions.set(action, handler);
		},
		actions,
		getText: () => text,
		setText: (next) => {
			text = next;
		},
		addToHistory() {},
	};
	const host: InteractiveSubmissionHost = {
		session,
		runtimeHost: {},
		ui: { addInputListener: () => () => {}, requestRender() {}, setFocus() {} },
		keybindings: { matches: () => false },
		settingsManager: { getDoubleEscapeAction: () => "none" },
		defaultEditor: editor,
		editor,
		editorContainer: { children: [editor] },
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		tuiInputSubscriptions: new Set(),
		addTuiInputListener: () => () => {},
		compactionQueuedMessages: [],
		compactionActive: false,
		compactionFlushPending: false,
		compactionSendFailed: false,
		lastEscapeTime: 0,
		deferredStartupPending: false,
		deferredStartupPromise: undefined,
		promptTurnWorkingLoaderActive: false,
		promptTurn: undefined,
		firstSubmitRecorded: true,
		inputHandlerReadyRecorded: true,
		startupReplayActiveInput: undefined,
		startupReplayInputs: [],
		isBashMode: false,
		onInputCallback: undefined,
		pendingUserInputs: [],
		notices: [],
		rendered: [],
		discarded: [],
		getAppKeyDisplay: () => "alt+up",
		showWorkingLoaderNow() {},
		stopWorkingLoader() {},
		showWarning(message) {
			host.notices.push(`warning: ${message}`);
		},
		showStatus(message) {
			host.notices.push(`status: ${message}`);
		},
		showError(message) {
			host.notices.push(`error: ${message}`);
		},
		ensureDeferredStartupComplete: async () => {},
		renderDeferredUserInput(value) {
			host.rendered.push(value);
		},
		discardDeferredRenderedUserInput(value) {
			host.discarded.push(value);
		},
		expectStartedUserInput() {},
		userMessagesShownBySession: 0,
		flushPendingBashComponents() {},
		updateEditorBorderColor() {},
		isExtensionCommand: (value) => Reflect.get(InteractiveMode.prototype, "isExtensionCommand").call(host, value),
		getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		restoreQueuedMessagesToEditor: () => 0,
		handleDequeue() {},
		updatePendingMessagesDisplay() {},
		queueCompactionMessage() {},
		flushCompactionQueue: async () => {},
		deliverStartupReplayPrompt() {},
		drainStartupReplayCommands: async () => {},
		advanceStartupInputReplay() {},
		getUserInput: async () => ({ text: "", draft: "" }),
		runUserPromptTurn: async () => {},
		setupKeyHandlers() {},
		setupEditorSubmitHandler() {},
		handleFollowUp: async () => {},
		getUserMessageText: () => "",
	};
	for (const name of BOUND_MODE_METHODS) {
		const method: (this: InteractiveSubmissionHost, ...args: never[]) => unknown = Reflect.get(
			InteractiveMode.prototype,
			name,
		);
		Reflect.set(host, name, (...args: never[]) => method.apply(host, args));
	}
	host.setupKeyHandlers();
	host.setupEditorSubmitHandler();
	return host;
}

/** Press Alt+Up, which restores the queued messages to the editor. */
export function pressAltUp(host: InteractiveSubmissionHost): void {
	const dequeue = host.defaultEditor.actions.get("app.message.dequeue");
	if (!dequeue) throw new Error("the editor has no dequeue action registered");
	dequeue();
}

/** Type `text` and press Alt+Enter, which queues it as a follow-up while the agent works. */
export async function pressAltEnter(host: InteractiveSubmissionHost, text: string): Promise<void> {
	const followUp = host.defaultEditor.actions.get("app.message.followUp");
	if (!followUp) throw new Error("the editor has no follow-up action registered");
	host.editor.setText(text);
	await Promise.resolve(followUp());
}

type ChatLine = Component & { text: string };

/**
 * Show user messages in a chat as InteractiveMode does: the host's own echo of a submission and the session's
 * `message_start` for it go through InteractiveMode's echo bookkeeping and its `message_start` handler. Returns the
 * user messages the chat shows, in order. The host's `rendered` and `discarded` records stop being kept.
 */
export function showUserMessagesInChat(host: InteractiveSubmissionHost): () => string[] {
	const chat = new Container();
	Object.assign(host, {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: { handleEvent() {} },
		chatContainer: chat,
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map(),
		addMessageToChat: (message: Parameters<InteractiveMode["getUserMessageText"]>[0]) => {
			const text = host.getUserMessageText(message);
			const line: ChatLine = { text, render: () => [text], invalidate() {} };
			chat.addChild(line);
		},
	});
	for (const name of [
		"renderDeferredUserInput",
		"consumeDeferredRenderedUserInput",
		"discardDeferredRenderedUserInput",
		"expectStartedUserInput",
		"showSessionUserMessage",
	] as const) {
		const method: (this: InteractiveSubmissionHost, ...args: never[]) => unknown = Reflect.get(
			InteractiveMode.prototype,
			name,
		);
		Reflect.set(host, name, (...args: never[]) => method.apply(host, args));
	}
	const handleEvent: (this: InteractiveSubmissionHost, event: object) => Promise<void> = Reflect.get(
		InteractiveMode.prototype,
		"handleEvent",
	);
	host.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user") void handleEvent.call(host, event);
	});
	return () => chat.children.map((line) => (line as ChatLine).text);
}

export function startInteractiveInputLoop(host: InteractiveSubmissionHost): { stop: () => void; done: Promise<void> } {
	let stopped = false;
	const done = (async () => {
		while (!stopped) {
			const submission = await host.getUserInput();
			if (stopped) return;
			await host.runUserPromptTurn(submission);
		}
	})();
	return {
		stop: () => {
			stopped = true;
		},
		done,
	};
}
