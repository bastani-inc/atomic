import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	createHarness,
	getMessageText,
	getUserTexts,
	type Harness,
} from "./suite/harness.ts";

type QueueHold = {
	readonly steering: AgentMessage[];
	readonly followUp: AgentMessage[];
};

type PauseAwareSession = AgentSession & {
	readonly queuedMessagesPaused?: boolean;
	readonly _activeInterruptQueueHold?: QueueHold;
};

type EscapeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void> | void;
	onChange?: (text: string) => void;
	onPasteImage?: () => void;
	onAction: (action: string, handler: () => void) => void;
	getText: () => string;
	setText: (text: string) => void;
	addToHistory: (text: string) => void;
};

type EscapeHost = {
	session: AgentSession;
	runtimeHost: object;
	ui: {
		onDebug?: () => void;
		addInputListener: (listener: (data: string) => void) => void;
		requestRender: () => void;
	};
	keybindings: { matches: () => boolean };
	settingsManager: { getDoubleEscapeAction: () => "none" };
	defaultEditor: EscapeEditor;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	editor: EscapeEditor;
	lastEscapeTime: number;
	clearAllQueues: () => { steering: string[]; followUp: string[] };
	restoreQueuedMessagesToEditor: (options?: { abort?: boolean; currentText?: string }) => number;
	updatePendingMessagesDisplay: () => void;
	showWorkingLoaderNow: () => void;
	stopWorkingLoader: () => void;
	deferredStartupPending: boolean;
	deferredStartupPromise: Promise<void> | undefined;
	deferLoadedResourcesDisclosureUntilAgentEnd: boolean;
	pendingLoadedResourcesDisclosure: boolean;
	discardDeferredRenderedUserInput: () => void;
  showError: (message: string) => void;
  isExtensionCommand(text: string): boolean;
};

type SubmitHost = EscapeHost & {
	firstSubmitRecorded: boolean;
	startupReplayActiveInput: string | undefined;
	startupReplayInputs: string[];
	isCompacting: boolean;
	isExtensionCommand(text: string): boolean;
	flushPendingBashComponents(): void;
	onInputCallback: ((text: string) => void) | undefined;
	pendingUserInputs: string[];
	advanceStartupInputReplay(text: string): void;
};

const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (
	this: EscapeHost,
) => void;
const restoreQueuedMessagesToEditor = Reflect.get(
	InteractiveMode.prototype,
	"restoreQueuedMessagesToEditor",
) as (this: EscapeHost, options?: { abort?: boolean; currentText?: string }) => number;
const clearAllQueues = Reflect.get(InteractiveMode.prototype, "clearAllQueues") as (
	this: EscapeHost,
) => { steering: string[]; followUp: string[] };
const runUserPromptTurn = Reflect.get(InteractiveMode.prototype, "runUserPromptTurn") as (
	this: EscapeHost,
	text: string,
) => Promise<void>;
const setupEditorSubmitHandler = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
	this: SubmitHost,
) => void;

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
		ui: { addInputListener() {}, requestRender() {} },
		keybindings: { matches: () => false },
		settingsManager: { getDoubleEscapeAction: () => "none" },
		defaultEditor: editor,
		compactionQueuedMessages: [],
		editor,
		lastEscapeTime: 0,
		clearAllQueues: () => clearAllQueues.call(host),
		restoreQueuedMessagesToEditor: (options) => restoreQueuedMessagesToEditor.call(host, options),
		updatePendingMessagesDisplay() {},
		showWorkingLoaderNow() {},
		stopWorkingLoader() {},
		deferredStartupPending: false,
		deferredStartupPromise: undefined,
		deferLoadedResourcesDisclosureUntilAgentEnd: false,
		pendingLoadedResourcesDisclosure: false,
		isExtensionCommand(candidate) {
			if (!candidate.startsWith("/")) return false;
			const spaceIndex = candidate.indexOf(" ");
			const commandName = spaceIndex === -1 ? candidate.slice(1) : candidate.slice(1, spaceIndex);
			return session.extensionRunner.getCommand(commandName) !== undefined;
		},
		discardDeferredRenderedUserInput() {},
		showError(message) {
			throw new Error(message);
		},
	};
	setupKeyHandlers.call(host);
	return host;
}


async function queueRawMessages(session: AgentSession): Promise<void> {
	await session.steer("first raw steering");
	await session.steer("second raw steering");
	await session.followUp("duplicate raw follow-up");
	await session.followUp("duplicate raw follow-up");
	await session.sendCustomMessage(
		{
			customType: "pause-raw-custom",
			content: [{ type: "text", text: "\traw custom content  \n" }],
			display: true,
			details: { optional: { untouched: true }, sequence: 3 },
		},
		{ deliverAs: "followUp" },
	);
}

function expectExactHeldQueue(session: AgentSession): void {
	const hold = (session as PauseAwareSession)._activeInterruptQueueHold;
	expect(hold?.steering.map(getMessageText)).toEqual([
		"first raw steering",
		"second raw steering",
	]);
	expect(hold?.followUp).toHaveLength(3);
	const [first, second, custom] = hold?.followUp ?? [];
	expect(first).not.toBe(second);
	expect([first, second].map(getMessageText)).toEqual([
		"duplicate raw follow-up",
		"duplicate raw follow-up",
	]);
	expect(custom).toMatchObject({
		role: "custom",
		customType: "pause-raw-custom",
		content: [{ type: "text", text: "\traw custom content  \n" }],
		display: true,
		details: { optional: { untouched: true }, sequence: 3 },
	});
}

describe("regular chat paused queued messages", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("Escape holds raw queued messages until the next real user prompt resumes the chat", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const providerStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const allowAbortToSettle = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				providerStarted.resolve();
				await new Promise<void>((resolve) => {
					const observeAbort = () => {
						abortObserved.resolve();
						void allowAbortToSettle.promise.then(resolve);
					};
					if (options?.signal?.aborted) observeAbort();
					else options?.signal?.addEventListener("abort", observeAbort, { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			fauxAssistantMessage("resume acknowledged"),
			fauxAssistantMessage("first steering handled"),
			fauxAssistantMessage("first duplicate handled"),
			fauxAssistantMessage("second duplicate handled"),
			fauxAssistantMessage("custom handled"),
		]);
		const activePrompt = harness.session.prompt("start regular chat");
		await providerStarted.promise;
		await queueRawMessages(harness.session);
		expect(harness.session.getSteeringMessages()).toEqual([
			"first raw steering",
			"second raw steering",
		]);
		expect(harness.session.getFollowUpMessages()).toEqual([
			"duplicate raw follow-up",
			"duplicate raw follow-up",
		]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		const host = createEscapeHost(harness.session);
		host.defaultEditor.onEscape?.();
		await abortObserved.promise;
		host.defaultEditor.onEscape?.();
		await Promise.resolve();
		expectExactHeldQueue(harness.session);
		let resumedSubmissionSettled = false;
		let resumedSubmissionError: Error | undefined;

		const settledBeforeAbort = resumedSubmissionSettled;
		const streamingBeforeAbort = harness.session.isStreaming;
		const steeringBeforeAbort = [...harness.session.getSteeringMessages()];
		const followUpBeforeAbort = [...harness.session.getFollowUpMessages()];
		const pausedBeforeAbort = (harness.session as PauseAwareSession).queuedMessagesPaused;
		const coreQueuedBeforeAbort = harness.session.agent.hasQueuedMessages();
		const responsesBeforeAbort = harness.getPendingResponseCount();
		const usersBeforeAbort = getUserTexts(harness);

		allowAbortToSettle.resolve();
		await activePrompt;
		host.defaultEditor.onEscape?.();
		await Promise.resolve();
		expectExactHeldQueue(harness.session);
		const resumedSubmission = runUserPromptTurn.call(host, "resume regular chat")
			.catch((error) => { resumedSubmissionError = error instanceof Error ? error : new Error(String(error)); })
			.finally(() => { resumedSubmissionSettled = true; });
		await resumedSubmission;

		expect(settledBeforeAbort).toBe(false);
		expect(streamingBeforeAbort).toBe(true);
		expect(steeringBeforeAbort).toEqual(["first raw steering", "second raw steering"]);
		expect(followUpBeforeAbort).toEqual(["duplicate raw follow-up", "duplicate raw follow-up"]);
		expect(pausedBeforeAbort).toBe(true);
		expect(coreQueuedBeforeAbort).toBe(false);
		expect(responsesBeforeAbort).toBe(5);
		expect(usersBeforeAbort).toEqual(["start regular chat"]);
		expect(resumedSubmissionError).toBeUndefined();
		expect(harness.session.isStreaming).toBe(false);
		expect((harness.session as PauseAwareSession).queuedMessagesPaused).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getUserTexts(harness)).toEqual([
			"start regular chat",
			"resume regular chat",
			"first raw steering",
			"second raw steering",
			"duplicate raw follow-up",
			"duplicate raw follow-up",
		]);
		const deliveredCustom = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "pause-raw-custom",
		);
		expect(deliveredCustom).toHaveLength(1);
		expect(deliveredCustom[0]).toMatchObject({
			content: [{ type: "text", text: "\traw custom content  \n" }],
			display: true,
			details: { optional: { untouched: true }, sequence: 3 },
		});
	});

	test("an immediate editor submission takes the paused-resume path instead of streaming queue admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const providerStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const finishAbortingTurn = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				providerStarted.resolve();
				const observeAbort = () => abortObserved.resolve();
				if (options?.signal?.aborted) observeAbort();
				else options?.signal?.addEventListener("abort", observeAbort, { once: true });
				await finishAbortingTurn.promise;
				return fauxAssistantMessage("interrupted before immediate submit");
			},
			fauxAssistantMessage("immediate submit consumed once"),
		]);
		const activePrompt = harness.session.prompt("start editor submission race");
		await providerStarted.promise;
		const baseHost = createEscapeHost(harness.session);
		const host = Object.assign(baseHost, {
			firstSubmitRecorded: true,
			startupReplayActiveInput: undefined,
			startupReplayInputs: [] as string[],
			isCompacting: false,
			isExtensionCommand: () => false,
			flushPendingBashComponents() {},
			onInputCallback: undefined,
			pendingUserInputs: [] as string[],
			advanceStartupInputReplay() {},
		}) satisfies SubmitHost;
		setupEditorSubmitHandler.call(host);
		host.defaultEditor.onEscape?.();
		await abortObserved.promise;

		await host.defaultEditor.onSubmit?.("immediate next submission");
		const pendingBeforeAbortSettled = [...host.pendingUserInputs];
		const heldBeforeAbortSettled = [...harness.session.getSteeringMessages()];
		finishAbortingTurn.resolve();
		await activePrompt;
		const resumeDriver = host.pendingUserInputs.shift() ?? "cleanup resume driver";
		await runUserPromptTurn.call(host, resumeDriver);

		expect(pendingBeforeAbortSettled).toEqual(["immediate next submission"]);
		expect(heldBeforeAbortSettled).not.toContain("immediate next submission");
		expect(getUserTexts(harness).filter((text) => text === "immediate next submission")).toHaveLength(1);
		expect(harness.session.queuedMessagesPaused).toBe(false);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	test("handled slash command keeps the regular paused queue held until ordinary input resumes", async () => {
		const commandArgs: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("stay-paused", {
						description: "Handle without releasing paused work",
						handler: async (args) => { commandArgs.push(args); },
					});
				},
			],
		});
		harnesses.push(harness);
		const providerStarted = Promise.withResolvers<void>();
		let providerCalls = 0;
		harness.setResponses([
			async (_context, options) => {
				providerCalls += 1;
				providerStarted.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("slash pause interrupted");
			},
			() => { providerCalls += 1; return fauxAssistantMessage("ordinary resume accepted"); },
			() => { providerCalls += 1; return fauxAssistantMessage("late held trigger delivered"); },
			() => { providerCalls += 1; return fauxAssistantMessage("unexpected duplicate delivery"); },
		]);
		const activePrompt = harness.session.prompt("start handled slash pause");
		await providerStarted.promise;
		const host = createEscapeHost(harness.session);
		host.defaultEditor.onEscape?.();
		await activePrompt;
		await harness.session.sendCustomMessage(
			{
				customType: "late-held-slash-trigger",
				content: [{ type: "text", text: "\tlate trigger payload  \n" }],
				display: true,
				details: { sequence: 1 },
			},
			{ triggerTurn: true },
		);
		const heldBeforeCommand = (harness.session as PauseAwareSession)._activeInterruptQueueHold;
		const responsesBeforeCommand = harness.getPendingResponseCount();

		await runUserPromptTurn.call(host, "/stay-paused  exact command args  ");

		expect(commandArgs).toEqual([" exact command args  "]);
		expect(providerCalls).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(responsesBeforeCommand);
		expect(harness.session.queuedMessagesPaused).toBe(true);
		expect((harness.session as PauseAwareSession)._activeInterruptQueueHold).toBe(heldBeforeCommand);
		expect(heldBeforeCommand?.steering.filter(
			(message) => message.role === "custom" && message.customType === "late-held-slash-trigger",
		)).toHaveLength(1);

		await runUserPromptTurn.call(host, "ordinary input resumes held work");

		expect(harness.session.queuedMessagesPaused).toBe(false);
		expect(getUserTexts(harness).filter((text) => text === "ordinary input resumes held work")).toHaveLength(1);
		expect(harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "late-held-slash-trigger",
		)).toHaveLength(1);
		expect(providerCalls).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(2);
	});

	test("built-in atomic usage keeps late trigger and exact queued content held until ordinary resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerCalls = 0;
		harness.setResponses([
			() => { providerCalls += 1; return fauxAssistantMessage("ordinary built-in resume accepted"); },
			() => { providerCalls += 1; return fauxAssistantMessage("queued steering delivered"); },
		]);
		const exactQueuedText = "\tqueued before built-in usage  \n";
		const exactLateTrigger = "\tlate built-in trigger payload  \n";
		harness.session.pauseQueuedMessages();
		await harness.session.steer(exactQueuedText);
		await harness.session.sendCustomMessage(
			{
				customType: "late-held-built-in-trigger",
				content: [{ type: "text", text: exactLateTrigger }],
				display: true,
				details: { sequence: 1 },
			},
			{ triggerTurn: true },
		);
		const host = createEscapeHost(harness.session);
		const heldBeforeCommand = (harness.session as PauseAwareSession)._activeInterruptQueueHold;
		const rawBeforeCommand = heldBeforeCommand?.steering.slice();
		const displayBeforeCommand = harness.session.getSteeringMessages();
		const responsesBeforeCommand = harness.getPendingResponseCount();

		await runUserPromptTurn.call(host, "/atomic usage");

		expect(providerCalls).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(responsesBeforeCommand);
		expect(harness.session.queuedMessagesPaused).toBe(true);
		expect((harness.session as PauseAwareSession)._activeInterruptQueueHold).toBe(heldBeforeCommand);
		expect(heldBeforeCommand?.steering).toEqual(rawBeforeCommand);
		expect(heldBeforeCommand?.steering.map(getMessageText)).toEqual([exactQueuedText, exactLateTrigger]);
		expect(harness.session.getSteeringMessages()).toEqual(displayBeforeCommand);
		expect(harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "atomic" && message.display === true,
		)).toHaveLength(1);

		await runUserPromptTurn.call(host, "ordinary input resumes built-in hold");

		expect(harness.session.queuedMessagesPaused).toBe(false);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness).filter((text) => text === exactQueuedText)).toHaveLength(1);
		expect(getUserTexts(harness).filter((text) => text === "ordinary input resumes built-in hold")).toHaveLength(1);
		expect(harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "late-held-built-in-trigger" && getMessageText(message) === exactLateTrigger,
		)).toHaveLength(1);
		expect(providerCalls).toBe(2);
	});

	test("unknown slash input remains a verbatim explicit resume input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerCalls = 0;
		harness.setResponses([
			() => { providerCalls += 1; return fauxAssistantMessage("unknown slash resumed"); },
			() => { providerCalls += 1; return fauxAssistantMessage("unexpected duplicate held delivery"); },
		]);
		const exactHeldText = "\theld before unknown slash  \n";
		const exactUnknownSlash = "/not-a-handled-command  exact args  ";
		harness.session.pauseQueuedMessages();
		await harness.session.steer(exactHeldText);
		const host = createEscapeHost(harness.session);

		await runUserPromptTurn.call(host, exactUnknownSlash);

		expect(harness.session.queuedMessagesPaused).toBe(false);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness).filter((text) => text === exactUnknownSlash)).toHaveLength(1);
		expect(getUserTexts(harness).filter((text) => text === exactHeldText)).toHaveLength(1);
		expect(providerCalls).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
