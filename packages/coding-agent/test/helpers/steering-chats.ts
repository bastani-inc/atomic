import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings, stripTerminalSequences, type TUI } from "@bastani/atomic-tui";
import { taskFixture } from "../../../../test/helpers/task-projection.js";
import { KeybindingsManager, useWindowsKeybindings } from "../../src/core/keybindings.js";
import type { Settings } from "../../src/core/settings-manager.js";
import type { TaskId, TaskRecord } from "../../src/core/tasks/contracts.js";
import { TaskMessageError } from "../../src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../src/core/tasks/supervisor.js";
import { ownerTaskViewSource, type TaskViewSource } from "../../src/core/tasks/task-view-source.js";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.js";
import { ChatSessionHost } from "../../src/modes/interactive/components/chat-session-host.js";
import { keyDisplayText } from "../../src/modes/interactive/components/keybinding-hints.js";
import { TaskInspector } from "../../src/modes/interactive/components/task-inspector.js";
import { themedChatHostStyle } from "../../src/modes/interactive/components/task-transcript-page.js";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme } from "../../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../../src/utils/ansi.js";
import { createHarness, getMessageText, type Harness } from "../suite/harness.js";
import { createGate, createRig, holdTool, sleep, waitFor } from "./busy-submission-rig.js";
import { pressAltEnter, pressAltUp } from "./interactive-submission-host.js";

/** The bytes of the follow-up key (`app.message.followUp`): Alt+Enter, or Ctrl+Q with the Windows bindings. */
export const FOLLOW_UP_KEY = useWindowsKeybindings() ? "\x11" : "\x1b\r";
/** The bytes of the dequeue key (`app.message.dequeue`): Alt+Up, or Alt+Q with the Windows bindings. */
export const DEQUEUE_KEY = useWindowsKeybindings() ? "\x1bq" : "\x1b[1;3A";
export const CTRL_F = "\x06";

const WIDTH = 120;
const HEIGHT = 40;

/** A turn that runs one tool round, held until released, then answers each later message with one reply. */
export function busyTurnResponses(): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`answer ${index + 1}`)),
	];
}

/**
 * One chat the user steers an agent from, driven by its keys only: the main chat, or a subagent's chat (the agent
 * panel's chat and the `/tasks` transcript are the same component). The steered agent is a real session on the faux
 * provider, so what it queues and what its model receives are its own.
 */
/** What the steered session is given besides its held tool. */
export interface SteeringChatOptions {
	readonly extensions?: ExtensionFactory[];
	/** Its resources, such as prompt templates; it replaces `extensions`. */
	readonly resourceLoader?: ResourceLoader;
	/** Settings of the subagent's session, such as how many queued messages a turn takes. */
	readonly settings?: Partial<Settings>;
}

export interface SteeringChat {
	readonly kind: "main" | "subagent";
	/** The session this chat steers. */
	readonly engine: Harness;
	/** Start a turn that holds in a tool round until {@link finishTurn}. */
	startBusyTurn(): Promise<void>;
	finishTurn(): void;
	/** Type `text` and press Enter. */
	enter(text: string): Promise<void>;
	/** Type `text` and press the follow-up key. */
	followUp(text: string): Promise<void>;
	/** Press the dequeue key. */
	dequeue(): Promise<void>;
	/** The queued rows above the prompt, with their hint line. */
	queuedRows(): string[];
	editorText(): string;
	stop(): Promise<void>;
}

/** The user messages the steered session's model received, in order. */
export function userTexts(engine: Harness): string[] {
	return engine.session.messages.filter((message) => message.role === "user").map(getMessageText);
}

function queueRowLines(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(line).trim()).filter((line) => /^(Steering|Follow-up|Queued): |^↳ /.test(line));
}

export async function mainChat(options: SteeringChatOptions = {}): Promise<SteeringChat> {
	const toolHold = createGate();
	const rig = await createRig("local", "quiet", {
		tools: [holdTool(toolHold)],
		...(options.extensions ? { extensions: options.extensions } : {}),
		...(options.resourceLoader ? { resourceLoader: options.resourceLoader } : {}),
	});
	rig.host.getAppKeyDisplay = (action) => keyDisplayText(action as Parameters<typeof keyDisplayText>[0]);
	Object.assign(rig.host, { isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} } });
	const handleEvent: (this: typeof rig.host, event: object) => Promise<void> = Reflect.get(
		InteractiveMode.prototype,
		"handleEvent",
	);
	rig.host.session.subscribe((event) => {
		if (event.type === "queue_update") void handleEvent.call(rig.host, event);
	});
	rig.engine.setResponses(busyTurnResponses());
	return {
		kind: "main",
		engine: rig.engine,
		async startBusyTurn() {
			await rig.host.defaultEditor.onSubmit?.("first");
			await toolHold.entered.promise;
		},
		finishTurn: () => toolHold.release.resolve(),
		async enter(text) {
			await rig.host.defaultEditor.onSubmit?.(text);
		},
		async followUp(text) {
			await pressAltEnter(rig.host, text);
		},
		async dequeue() {
			pressAltUp(rig.host);
			await sleep(20);
		},
		queuedRows: () => queueRowLines(rig.host.pendingMessagesContainer.render(WIDTH)),
		editorText: () => rig.host.editor.getText(),
		stop: () => rig.stop(),
	};
}

function testTui(): TUI {
	return { requestRender: () => {}, terminal: { rows: HEIGHT, columns: WIDTH } } as unknown as TUI;
}

const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * The child's transcript as the in-process child binding gives it to the task view: its session's events and queue, and
 * the steering lanes a chat of it uses. A typed message goes to the child's own session on `lane` and resolves once the
 * session accepted it; its queue comes back from the session's own answer, as typed.
 */
export function childTranscript(child: Harness): TaskTranscriptSource {
	return {
		getSessionId: () => child.sessionManager.getSessionId(),
		getEntries: () => child.sessionManager.getEntries(),
		subscribe: (listener) => child.session.subscribe(listener),
		isRunning: () => child.session.isStreaming,
		getQueuedMessages: () => ({
			steering: child.session.getSteeringMessages(),
			followUp: child.session.getFollowUpMessages(),
		}),
		queueMessage: (text, lane) =>
			new Promise((resolve) => {
				const accepted = () => resolve({ delivered: true });
				child.session
					.prompt(text, {
						streamingBehavior: lane,
						preflightResult: (success) => {
							if (success) accepted();
						},
					})
					.then(accepted, (error: unknown) =>
						resolve({
							delivered: false,
							reason: "refused",
							detail: error instanceof Error ? error.message : String(error),
						}),
					);
			}),
		clearQueue: async () => {
			const cleared = child.session.clearQueue();
			const typed = cleared.typed ?? cleared;
			return { steering: [...typed.steering], followUp: [...typed.followUp] };
		},
	};
}

/** A task view of one running subagent whose transcript is `transcript`, made by hand: the steering contract alone. */
function handMadeTaskSource(transcript: TaskTranscriptSource, taskId: TaskId): TaskViewSource {
	const record = (): TaskRecord => ({
		ref: { ownerId: "owner-1" as never, taskId, sessionId: "parent-1" },
		kind: "agent",
		title: "Steered subagent",
		agentName: "worker",
		wasBackground: true,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		execution: { kind: "running" },
		attention: { kind: "none" },
		observation: { kind: "background" },
		output: { byteCount: "0", omittedRanges: [] },
		capabilities: { canCancel: true, canForeground: false, hasStdin: false },
	});
	const messages = () => transcript.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	return {
		get tasks() {
			return [record()];
		},
		get backgroundTasks() {
			return [record()];
		},
		settlementOrder: new Map(),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: () => () => {},
		cancelTask: async () => ({ ok: true, value: undefined }),
		stdinAvailable: () => false,
		writeTaskInput: async () => ({ ok: false, error: { message: "unsupported" } }),
		readTaskOutput: async () => ({ ok: true, value: { text: "", omitted: false } }),
		taskDetailText: () => ({ prompt: "Steered subagent" }),
		readTaskTranscript: () => ({ ok: true, value: { messages: messages() } }),
		followTaskTranscript: () => ({ session: transcript, historyOnly: false }),
		extensionStatuses: () => new Map(),
		watchExtensionStatuses: () => () => {},
		sendTaskMessage: async (id, text, lane = "steer") => {
			const delivery = await transcript.queueMessage!(text, lane);
			if (!delivery.delivered)
				throw new TaskMessageError("delivery-refused", {
					taskId: id,
					...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
				});
		},
		clearTaskQueue: async () => ({ ok: true, value: await transcript.clearQueue!() }),
	};
}

/** Where a subagent chat's task view comes from. */
interface SubagentTaskView {
	readonly source: TaskViewSource;
	readonly taskId: TaskId;
	dispose(): Promise<void>;
}

/** The task view `/tasks` and the agent panel read: the owner's task store, with the child bound as a running task. */
async function ownerTaskView(transcript: TaskTranscriptSource): Promise<SubagentTaskView> {
	const fixture = taskFixture();
	await fixture.start("Steered subagent");
	fixture.runners[0]!.context.bindTranscript(transcript);
	return {
		source: ownerTaskViewSource(fixture.store),
		taskId: fixture.store.tasks[0]!.ref.taskId,
		dispose: () => fixture.dispose(),
	};
}

async function handMadeTaskView(transcript: TaskTranscriptSource): Promise<SubagentTaskView> {
	const taskId = "task-steered-1" as TaskId;
	return { source: handMadeTaskSource(transcript, taskId), taskId, dispose: async () => {} };
}

/** A subagent's chat, with what only it has: its keys as the terminal sends them, and its screen. */
export interface SubagentSteeringChat extends SteeringChat {
	/** Type `text` without sending it. */
	type(text: string): Promise<void>;
	/** Send raw key bytes to the chat. */
	press(data: string): Promise<void>;
	/** The chat as drawn, without colors. */
	screen(): string;
	/** Leave the chat with ← on its empty prompt and open it again, as the agent panel or `/tasks` opens it. */
	reopen(): Promise<void>;
}

/** A subagent's chat over the task view of the main chat's own task store, as the agent panel and `/tasks` open it. */
export async function subagentChat(options: SteeringChatOptions = {}): Promise<SubagentSteeringChat> {
	return openSubagentChat(options, ownerTaskView);
}

/** A subagent's chat over a task view made by hand that implements only the steering contract. */
export async function subagentChatOverHandMadeView(options: SteeringChatOptions = {}): Promise<SubagentSteeringChat> {
	return openSubagentChat(options, handMadeTaskView);
}

async function openSubagentChat(
	options: SteeringChatOptions,
	view: (transcript: TaskTranscriptSource) => Promise<SubagentTaskView>,
): Promise<SubagentSteeringChat> {
	initTheme("dark");
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const toolHold = createGate();
	const child = await createHarness({
		tools: [holdTool(toolHold)],
		...(options.settings ? { settings: options.settings } : {}),
		...(options.extensions ? { extensionFactories: options.extensions } : {}),
		...(options.resourceLoader ? { resourceLoader: options.resourceLoader } : {}),
	});
	child.setResponses(busyTurnResponses());
	const { source, taskId, dispose } = await view(childTranscript(child));
	let chat: ChatSessionHost | undefined;
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => ({
			createChat: (opts) => {
				chat = new ChatSessionHost(opts);
				return chat;
			},
			tui: testTui(),
			keybindings: getKeybindings(),
			editorTheme: getEditorTheme(),
			style: themedChatHostStyle(),
		}),
	);
	inspector.openChat(taskId);
	await flush();
	const type = async (text: string) => {
		for (const ch of text) inspector.handleInput(ch);
		await flush();
	};
	const screenLines = () => inspector.renderViewport(WIDTH, HEIGHT).map((line) => stripTerminalSequences(line));
	let turn: Promise<void> | undefined;
	return {
		kind: "subagent",
		engine: child,
		async startBusyTurn() {
			turn = child.session.prompt("first").catch(() => {});
			await toolHold.entered.promise;
			await flush();
		},
		finishTurn: () => toolHold.release.resolve(),
		async enter(text) {
			await type(text);
			inspector.handleInput("\r");
			await waitFor(`"${text}" to leave the prompt`, () => chat?.inputText() !== text);
			await flush();
		},
		async followUp(text) {
			await type(text);
			inspector.handleInput(FOLLOW_UP_KEY);
			await flush();
		},
		async dequeue() {
			inspector.handleInput(DEQUEUE_KEY);
			await sleep(20);
			await flush();
		},
		queuedRows: () => queueRowLines(screenLines()),
		editorText: () => chat?.inputText() ?? "",
		type,
		async press(data) {
			inspector.handleInput(data);
			await flush();
		},
		screen: () => screenLines().join("\n"),
		async reopen() {
			inspector.handleInput("\x1b[D");
			await flush();
			inspector.openChat(taskId);
			await flush();
		},
		async stop() {
			toolHold.release.resolve();
			inspector.dispose();
			await turn;
			await dispose();
			await child.cleanup();
			setKeybindings(previousKeys);
		},
	};
}

export const steeringChats = [
	["main", mainChat],
	["subagent", subagentChat],
	["subagent (hand-made task view)", subagentChatOverHandMadeView],
] as const;
