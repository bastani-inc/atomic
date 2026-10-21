import { Container } from "@earendil-works/pi-tui";
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
	flushPendingBashComponents: () => void;
	updateEditorBorderColor: () => void;
	isExtensionCommand: (text: string) => boolean;
	getAllQueuedMessages: () => { steering: string[]; followUp: string[] };
	clearAllQueues: (options?: { preserveUnprotectedCustomMessages?: boolean }) => {
		steering: string[];
		followUp: string[];
	};
	restoreQueuedMessagesToEditor: (options?: { preserveUnprotectedCustomMessages?: boolean }) => number;
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
}

const BOUND_MODE_METHODS = [
	"getAllQueuedMessages",
	"clearAllQueues",
	"restoreQueuedMessagesToEditor",
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
] as const;

export function createInteractiveSubmissionHost(session: AgentSession): InteractiveSubmissionHost {
	initTheme("dark");
	let text = "";
	const editor: Editor = {
		onAction() {},
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
		flushPendingBashComponents() {},
		updateEditorBorderColor() {},
		isExtensionCommand: (value) => Reflect.get(InteractiveMode.prototype, "isExtensionCommand").call(host, value),
		getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		restoreQueuedMessagesToEditor: () => 0,
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
