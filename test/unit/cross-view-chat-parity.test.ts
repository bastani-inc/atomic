import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { Container, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	MainComposerKeyOverlay,
	mainComposerKeys,
} from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.js";
import { renderNavHintLine } from "../../packages/coding-agent/src/modes/interactive/components/nav-keys.js";
import {
	TaskInspector,
	themedNavKeyStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { WorkingRunMeter } from "../../packages/coding-agent/src/modes/interactive/components/working-run-meter.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-runtime.js";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import {
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	theme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { injectStageLabelIntoEditorTopRule } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
import {
	applyStageLabelToAwaitingInputTopRule,
	applyStageLabelToEditorTopRule,
	applyStageLabelToWidgetTopRule,
} from "../../packages/workflows/src/tui/stage-input-label.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";
import { fakeFooterAgentSession, makeHandle, setupRun } from "./stage-chat-view-helpers.js";

const ESC = "\x1b";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const APPLICATION_COMMAND = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const plain = (lines: readonly string[]): string[] =>
	lines.map((line) => stripVTControlCharacters(line.replace(APPLICATION_COMMAND, "")).trimEnd());

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function createAssistantMessage(
	text: string,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		inputTokens?: number;
		outputTokens?: number;
		timestamp?: number;
	} = {},
): AssistantMessage {
	const input = options.inputTokens ?? 0;
	const output = options.outputTokens ?? 420;
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 },
		},
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		timestamp: options.timestamp ?? 1_000,
	};
}

let previousKeybindings: ReturnType<typeof getKeybindings>;

beforeEach(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(previousKeybindings);
	vi.restoreAllMocks();
});

describe("attached subagent transcript header and live-key hint (#5224)", () => {
	test("renders › from main header, styled ❯ prompt echo once, and ← main chat hint when attached from the agent panel (#5224)", async () => {
		const fixture = taskFixture();
		const owner = ownerTaskViewSource(fixture.store);
		const keys = getKeybindings();
		let expanded = false;
		const env = taskTranscriptEnvironment({
			tui: makeTestTui(24),
			keybindings: keys,
			getToolsExpanded: () => expanded,
			setToolsExpanded: (next) => {
				expanded = next;
			},
		});
		let closed = 0;
		const inspector = new TaskInspector(
			owner,
			() => {},
			() => {
				closed += 1;
			},
			undefined,
			() => env,
		);
		try {
			await fixture.start("Fix #5220: make lock creation atomic across concurrent spawns");
			const session = SessionManager.inMemory();
			await session.appendMessage({
				role: "user",
				content: "Fix #5220: make lock creation atomic across concurrent spawns",
				timestamp: 1_000,
			});
			await session.appendMessage(createAssistantMessage("Reproduced: two owners of one stale lock on Windows."));
			let running = true;
			let interrupted = 0;
			const transcript: TaskTranscriptSource = Object.assign(session, {
				subscribe: () => () => {},
				isRunning: () => running,
				async interruptTurn() {
					interrupted += 1;
					running = false;
				},
			});
			fixture.runners[0]!.context.bindTranscript(transcript);
			const taskId = fixture.store.tasks[0]!.ref.taskId;

			inspector.openChat(taskId);
			await flush();

			for (const width of [80, 160]) {
				const rows = plain(inspector.renderViewport(width, 24));
				assert.equal(rows[0], "  › from main", `width ${width}: › from main header at row 0`);
				assert.match(
					rows[1] ?? "",
					/^ {2}❯ Fix #5220: make lock creation atomic/,
					`width ${width}: styled ❯ prompt echo at row 1`,
				);
				const beforeComposer = rows.slice(
					0,
					rows.findIndex((row) => row.includes("━")),
				);
				assert.equal(
					beforeComposer.filter((row) => row.includes("Fix #5220: make lock creation atomic")).length,
					1,
					`width ${width}: initial prompt is shown once in the header without duplicating in the body`,
				);
				assert.equal(
					rows.at(-1),
					"  ← main chat · esc interrupt · pgup/pgdn scroll · ctrl+o expand · ? keys",
					`width ${width}: running hint lists ← main chat and live keys`,
				);
			}

			// Ctrl+O toggles tool expansion
			assert.equal(inspector.handleInput("\x0f"), true);
			assert.equal(expanded, true);

			// ? on empty prompt opens key overlay, Esc closes overlay without interrupting
			assert.equal(inspector.handleInput("?"), true);
			const overlayRows = plain(inspector.renderViewport(100, 24));
			assert.match(overlayRows[0] ?? "", /^╭─ keys · task chat /);
			assert.equal(interrupted, 0);
			assert.equal(inspector.handleInput(ESC), true);
			assert.equal(interrupted, 0, "closing ? overlay with Esc does not interrupt the subagent");

			// Esc on the chat interrupts the turn and updates the hint line (no esc interrupt once idle)
			assert.equal(inspector.handleInput(ESC), true);
			await flush();
			assert.equal(interrupted, 1);
			assert.equal(closed, 0, "Esc never leaves the subagent chat");
			const idleRows = plain(inspector.renderViewport(100, 24));
			assert.equal(idleRows.at(-1), "  ← main chat · pgup/pgdn scroll · ctrl+o expand · ? keys");

			// ← on empty prompt closes the attached chat (closedByBack === true)
			assert.equal(inspector.handleInput(LEFT), true);
			assert.equal(closed, 1);
			assert.equal(inspector.closedByBack, true);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	});

	test("showTaskInspector with chat:true and backLabel:'main chat' renders › from main header, ❯ prompt echo once, and ← main chat hint (#5224)", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("Subagent task");
			const session = SessionManager.inMemory();
			await session.appendMessage({ role: "user", content: "Subagent task", timestamp: 1_000 });
			fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
			const taskId = fixture.store.tasks[0]!.ref.taskId;

			let renderedLines: string[] = [];
			const leftResult = await showTaskInspector(
				{
					getToolsExpanded: () => false,
					setToolsExpanded: () => {},
					async custom<T>(factory: Parameters<Parameters<typeof showTaskInspector>[0]["custom"]>[0]): Promise<T> {
						const finish = () => {};
						const component = await factory(makeTestTui(24), theme, new KeybindingsManager(), (() =>
							finish()) as never);
						await flush();
						renderedLines = plain(component.render(100));
						component.handleInput?.(LEFT);
						component.dispose?.();
						return undefined as T;
					},
				},
				fixture.store,
				taskId,
				{ chat: true, backLabel: "main chat" },
			);
			assert.equal(renderedLines[0], "  › from main");
			assert.equal(renderedLines[1], "  ❯ Subagent task");
			const beforeComposer = renderedLines.slice(
				0,
				renderedLines.findIndex((row) => row.includes("━")),
			);
			assert.equal(
				beforeComposer.filter((row) => row.includes("Subagent task")).length,
				1,
				"initial prompt is shown once in the header without duplicating in the body",
			);
			assert.equal(renderedLines.at(-1), "  ← main chat · pgup/pgdn scroll · ctrl+o expand · ? keys");
			assert.equal(leftResult, "back");
		} finally {
			await fixture.dispose();
		}
	});
});

describe("cross-view parity across main chat, stage chat, and subagent view (#5224)", () => {
	test("same events produce identical whimsical working line, interrupt notice, and shared hint/overlay across main, stage, and subagent views (#5224)", async () => {
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(Math, "random").mockReturnValue(0);

		const keys = new KeybindingsManager();
		setKeybindings(keys);

		// 1. Main chat (InteractiveModeBase + ChatSessionHost)
		const mainStatusContainer = new Container();
		const mainChatContainer = new Container();
		const mainPendingContainer = new Container();
		const settingsManager = {
			getShowTerminalProgress: () => false,
			getClearOnShrink: () => false,
			getShowCacheMissNotices: () => false,
			getLatexRenderingEnabled: () => true,
		};
		const sessionManager = SessionManager.inMemory();
		const session = {
			isStreaming: true,
			isCompacting: false,
			compactionReason: undefined,
			pendingMessageCount: 0,
			settingsManager,
			sessionManager,
			modelRuntime: {},
			agent: { waitForIdle: async () => {} },
		};
		const mainMode = Object.assign(Object.create(InteractiveModeBase.prototype), {
			isInitialized: true,
			ui: { requestRender() {}, terminal: { setProgress() {} } },
			footer: { invalidate() {} },
			programStatus: new ProgramStatusReporter(
				() => ({ setProgramStatus() {} }) as never,
				() => undefined,
			),
			runtimeHost: { session },
			statusContainer: mainStatusContainer,
			chatContainer: mainChatContainer,
			pendingMessagesContainer: mainPendingContainer,
			pendingTools: new Map(),
			compactionQueuedMessages: [],
			workingRunMeter: new WorkingRunMeter(),
			defaultEditor: { onEscape: undefined as (() => void) | undefined, setWorkingStatusIndicator() {} },
			setEditorWorkingStatusIndicator: undefined,
			workingVisible: true,
			workingMessage: undefined,
			defaultWorkingMessage: "Working...",
			defaultHiddenThinkingLabel: "Thinking...",
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			maybeShowAssistantDiagnostics() {},
			maybeShowInstallChangeWarning: () => false,
			checkShutdownRequested: async () => {},
			updatePendingMessagesDisplay() {},
		}) as InteractiveModeBase;

		// 2. Stage chat (StageChatView)
		const wfStore = createStore();
		setupRun(wfStore, "run-1", "stage-a", "running");
		let stageStreaming = true;
		const stageAgentSession = fakeFooterAgentSession(true);
		const { handle: stageHandle, emit: emitStage } = makeHandle(
			{
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				get isStreaming() {
					return stageStreaming;
				},
			},
			[],
			"running",
			stageAgentSession,
		);
		const originalPause = stageHandle.pause.bind(stageHandle);
		Object.assign(stageHandle, {
			async pause() {
				stageStreaming = false;
				await originalPause();
				wfStore.recordStagePaused("run-1", "stage-a");
			},
		});
		let stageExpanded = false;
		const stageView = new StageChatView({
			store: wfStore,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "demo",
			handle: stageHandle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(28),
			piTheme: theme,
			piKeybindings: keys,
			getToolsExpanded: () => stageExpanded,
			setToolsExpanded: (next) => {
				stageExpanded = next;
			},
			footerData: {
				getGitBranch: () => "main",
				getExtensionStatuses: () => new Map(),
				getAvailableProviderCount: () => 1,
				onBranchChange: () => () => {},
			},
		});

		// 3. Subagent view (TaskInspector + TaskAgentTranscriptPage)
		const subFixture = taskFixture();
		await subFixture.start("Investigate lock contention");
		const subSession = SessionManager.inMemory();
		await subSession.appendMessage({ role: "user", content: "Investigate lock contention", timestamp: 9_000 });
		const subListeners = new Set<(event: AgentSessionEvent) => void>();
		let subRunning = true;
		const subTranscript: TaskTranscriptSource = Object.assign(subSession, {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				subListeners.add(listener);
				return () => subListeners.delete(listener);
			},
			isRunning: () => subRunning,
			async interruptTurn() {
				subRunning = false;
			},
		});
		subFixture.runners[0]!.context.bindTranscript(subTranscript);
		let subExpanded = false;
		const subEnv = taskTranscriptEnvironment({
			tui: makeTestTui(28),
			keybindings: keys,
			style: themedChatHostStyle(),
			editorTheme: getEditorTheme(),
			getToolsExpanded: () => subExpanded,
			setToolsExpanded: (next) => {
				subExpanded = next;
			},
		});
		const subInspector = new TaskInspector(
			ownerTaskViewSource(subFixture.store),
			() => {},
			() => {},
			undefined,
			() => subEnv,
		);
		subInspector.openChat(subFixture.store.tasks[0]!.ref.taskId);
		await flush();

		const dispatchAll = async (event: AgentSessionEvent): Promise<void> => {
			await mainMode.handleEvent(event);
			emitStage(event);
			for (const listener of subListeners) listener(event);
		};

		try {
			// Feed identical working turn events to all three views
			await dispatchAll({ type: "agent_start" } as AgentSessionEvent);
			await dispatchAll({ type: "turn_start" } as AgentSessionEvent);
			const seed = createAssistantMessage("", { outputTokens: 0, timestamp: 10_000 });
			await dispatchAll({ type: "message_start", message: seed } as AgentSessionEvent);

			now = 14_000;
			const streamed = createAssistantMessage("Checking lock owner state...", {
				outputTokens: 0,
				timestamp: 10_000,
			});
			await dispatchAll({
				type: "message_update",
				message: streamed,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Checking lock owner state..." },
			} as unknown as AgentSessionEvent);

			// 1. Working line must be identical across main chat, stage chat, and subagent view
			const mainWorkingLines = plain(mainStatusContainer.render(100)).filter((line) => line.trim().length > 0);
			const stageLines = plain(stageView.render(100));
			const subLines = plain(subInspector.renderViewport(100, 28));

			const stageWorkingLine = stageLines.find((line) => line.includes("∀ "));
			const subWorkingLine = subLines.find((line) => line.includes("∀ "));
			assert.equal(mainWorkingLines.length, 1);
			assert.match(mainWorkingLines[0]!, /^ ∀ Schlepping\.\.\. \(4s · ↓ 7 tokens\)$/);
			assert.equal(stageWorkingLine, mainWorkingLines[0], "stage chat working line matches main chat");
			assert.equal(subWorkingLine, mainWorkingLines[0], "subagent view working line matches main chat");

			// 2. Hint line while working: stage chat and subagent view share the exact live-key suffix, with no duplicate footer row
			const stageRunningHint = stageLines.at(-1) ?? "";
			const subRunningHint = subLines.at(-1) ?? "";
			assert.equal(stageRunningHint, "  ← graph · esc interrupt · pgup/pgdn scroll · ctrl+o expand · ? keys");
			assert.equal(subRunningHint, "  ← main chat · esc interrupt · pgup/pgdn scroll · ctrl+o expand · ? keys");
			assert.equal(
				stageLines.filter((line) => line.includes("← ") || line.includes("interrupt")).length,
				1,
				"stage chat renders a single live-key hint row without a duplicate esc to interrupt / ← return to graph row",
			);
			assert.equal(
				stageRunningHint.replace(/^ {2}← graph/, ""),
				subRunningHint.replace(/^ {2}← main chat/, ""),
				"stage and subagent hint lines share identical live key segments",
			);

			// 3. ? on an empty prompt opens the shared key overlay in all three views
			const mainOverlay = new MainComposerKeyOverlay(
				keys,
				() => ({ working: true }),
				() => {},
			);
			const mainOverlayLines = plain(mainOverlay.render(100));
			assert.equal(stageView.handleInput("?"), true);
			assert.equal(stageView._inputBuffer, "", "? in stage chat does not type into the composer");
			const stageOverlayLines = plain(stageView.render(100));
			assert.equal(subInspector.handleInput("?"), true);
			const subOverlayLines = plain(subInspector.renderViewport(100, 28));

			assert.match(mainOverlayLines[0] ?? "", /^╭─ keys /);
			assert.ok(stageOverlayLines.some((line) => line.startsWith("╭─ keys · stage chat ")));
			assert.ok(subOverlayLines.some((line) => line.startsWith("╭─ keys · task chat ")));
			const closeHelpRow = (rows: readonly string[]) => rows.find((line) => line.includes("close this help"));
			assert.equal(closeHelpRow(stageOverlayLines), closeHelpRow(subOverlayLines));
			assert.equal(closeHelpRow(stageOverlayLines), closeHelpRow(mainOverlayLines));

			// Esc closes the ? overlay in both stage chat and subagent view without interrupting
			assert.equal(stageView.handleInput(ESC), true);
			assert.equal(subInspector.handleInput(ESC), true);
			assert.equal(stageStreaming, true, "Esc on stage ? overlay only closes the overlay");
			assert.equal(subRunning, true, "Esc on subagent ? overlay only closes the overlay");

			assert.equal(stageView.handleInput(ESC), true);
			assert.equal(subInspector.handleInput(ESC), true);
			await flush();

			const abortedMessage = createAssistantMessage("Checking lock owner state...", {
				stopReason: "aborted",
				errorMessage: "Operation aborted",
				outputTokens: 1_200,
				timestamp: 14_000,
			});
			await dispatchAll({ type: "message_end", message: abortedMessage } as AgentSessionEvent);
			await dispatchAll({ type: "agent_end", messages: [abortedMessage] } as AgentSessionEvent);
			await flush();

			const mainAfterAbort = plain(mainChatContainer.render(100));
			const stageAfterAbort = plain(stageView.render(100));
			const subAfterAbort = plain(subInspector.renderViewport(100, 28));

			const mainNotice = mainAfterAbort.find((line) => line.includes("◼ Interrupted"));
			const stageNotice = stageAfterAbort.find((line) => line.includes("◼ Interrupted"));
			const subNotice = subAfterAbort.find((line) => line.includes("◼ Interrupted"));
			assert.equal(mainNotice, " ◼ Interrupted");
			assert.equal(stageNotice, mainNotice, "stage chat renders the same shared interruption notice");
			assert.equal(subNotice, mainNotice, "subagent view renders the same shared interruption notice");
			assert.doesNotMatch(
				stageAfterAbort.join("\n"),
				/❚❚\s+PAUSED|This workflow stage is paused/,
				"Esc in stage chat does not render the divergent PAUSED banner",
			);

			// Hint line after interrupt drops esc interrupt in both stage and subagent views
			assert.equal(stageAfterAbort.at(-1), "  ← graph · pgup/pgdn scroll · ctrl+o expand · ? keys");
			assert.equal(subAfterAbort.at(-1), "  ← main chat · pgup/pgdn scroll · ctrl+o expand · ? keys");
			assert.equal(
				stageAfterAbort.filter((line) => line.includes("← ")).length,
				1,
				"idle stage chat renders a single ← graph hint row without right-aligned ← return to graph on the model row",
			);

			// ? overlay when idle omits esc interrupt in both stage chat and subagent view
			assert.equal(stageView.handleInput("?"), true);
			assert.equal(subInspector.handleInput("?"), true);
			const idleStageOverlay = plain(stageView.render(100)).join("\n");
			const idleSubOverlay = plain(subInspector.renderViewport(100, 28)).join("\n");
			assert.doesNotMatch(idleStageOverlay, /interrupt the agent's turn/);
			assert.doesNotMatch(idleSubOverlay, /interrupt the agent's turn/);
			assert.equal(stageView.handleInput(ESC), true);
			assert.equal(subInspector.handleInput(ESC), true);
			assert.equal(
				renderNavHintLine(mainComposerKeys({ working: false }), 100, themedNavKeyStyle(), keys).includes(
					"interrupt",
				),
				false,
			);
		} finally {
			mainMode.stopWorkingLoader();
			stageView.dispose();
			subInspector.dispose();
			await subFixture.dispose();
		}
	});

	test("attaching mid-turn to a running stage chat or subagent view hydrates the whimsical verb and WorkingRunMeter instead of bare Working... (#5224)", async () => {
		const now = 30_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(Math, "random").mockReturnValue(0);

		const settledAssistant = createAssistantMessage("Started background sleep and waiting.", {
			stopReason: "toolUse",
			outputTokens: 409,
			timestamp: 5_000,
		});
		const historyMessages = [
			{ role: "user" as const, content: "Run sleep 600 with bash, then reply done.", timestamp: 3_000 },
			settledAssistant,
		];

		// 1. Mid-turn StageChatView attach (turn_start already happened at t=3_000)
		const wfStore = createStore();
		setupRun(wfStore, "run-mid", "stage-mid", "running");
		const stageSession = fakeFooterAgentSession(true);
		const { handle } = makeHandle(
			{
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				isStreaming: true,
			},
			historyMessages as never,
			"running",
			stageSession,
		);
		const stageView = new StageChatView({
			store: wfStore,
			graphTheme: deriveGraphTheme({}),
			runId: "run-mid",
			stageId: "stage-mid",
			workflowName: "demo",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(24),
			piTheme: theme,
			piKeybindings: getKeybindings(),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		});

		// 2. Mid-turn Subagent view attach (turn_start already happened at t=3_000)
		const subFixture = taskFixture();
		await subFixture.start("Run sleep 600 with bash, then reply done.");
		const subSession = SessionManager.inMemory();
		for (const msg of historyMessages) await subSession.appendMessage(msg as never);
		const subTranscript: TaskTranscriptSource = Object.assign(subSession, {
			subscribe: () => () => {},
			isRunning: () => true,
			chatSession: stageSession as never,
		});
		subFixture.runners[0]!.context.bindTranscript(subTranscript);
		const subEnv = taskTranscriptEnvironment({
			tui: makeTestTui(24),
			keybindings: getKeybindings(),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		});
		const subInspector = new TaskInspector(
			ownerTaskViewSource(subFixture.store),
			() => {},
			() => {},
			undefined,
			() => subEnv,
		);
		subInspector.openChat(subFixture.store.tasks[0]!.ref.taskId);
		await flush();

		try {
			const stageWorking = plain(stageView.render(100)).find((line) => line.includes("∀ "));
			const subWorking = plain(subInspector.renderViewport(100, 24)).find((line) => line.includes("∀ "));

			assert.equal(stageWorking, " ∀ Schlepping... (27s · ↓ 409 tokens)");
			assert.equal(subWorking, " ∀ Schlepping... (27s · ↓ 409 tokens)");
		} finally {
			stageView.dispose();
			subInspector.dispose();
			await subFixture.dispose();
		}
	});

	test("stage chat lists ↓ agents and opens its task inspector on ↓ only when the stage owns background tasks (#5224)", async () => {
		const wfStore = createStore();
		setupRun(wfStore, "run-tasks", "stage-tasks", "running");
		const { handle: noTasksHandle } = makeHandle(undefined, [], "running", fakeFooterAgentSession(false));
		const viewWithoutTasks = new StageChatView({
			store: wfStore,
			graphTheme: deriveGraphTheme({}),
			runId: "run-tasks",
			stageId: "stage-tasks",
			workflowName: "demo",
			handle: noTasksHandle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(24),
			piTheme: theme,
			piKeybindings: getKeybindings(),
		});

		const tasks = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
		const shell = { ...taskRecord("build", "command"), title: "npm test" };
		tasks.apply({
			tasks: [shell],
			background: [shell.ref.taskId],
			settlement: [],
			activity: [],
			stdin: [],
			statuses: [],
		});
		const { handle: pooledBase } = makeHandle();
		const viewWithTasks = new StageChatView({
			store: wfStore,
			graphTheme: deriveGraphTheme({}),
			runId: "run-tasks",
			stageId: "stage-tasks",
			workflowName: "demo",
			handle: {
				...pooledBase,
				placement: { kind: "local-worker", workId: "work", generation: 1 },
				taskSource: () => tasks,
			},
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(24),
			piTheme: theme,
			piKeybindings: getKeybindings(),
		});

		try {
			const withoutLines = plain(viewWithoutTasks.render(100));
			assert.equal(withoutLines.at(-1), "  ← graph · pgup/pgdn scroll · ctrl+o expand · ? keys");

			const withLines = plain(viewWithTasks.render(100));
			assert.equal(withLines.at(-1), "  ← graph · ↓ agents · pgup/pgdn scroll · ctrl+o expand · ? keys");

			assert.equal(viewWithTasks.handleInput("?"), true);
			const overlayText = plain(viewWithTasks.render(100)).join("\n");
			assert.match(overlayText, /↓\s+agents, on an empty prompt/);
			assert.equal(viewWithTasks.handleInput(ESC), true);

			assert.equal(viewWithTasks.handleInput(DOWN), true);
			const inspectorText = plain(viewWithTasks.render(100)).join("\n");
			assert.match(inspectorText, /npm test/);
		} finally {
			viewWithoutTasks.dispose();
			viewWithTasks.dispose();
		}
	});

	test("attached stage composer and stage label helpers strip terminal control sequences from stage names (#5224)", () => {
		const graphTheme = deriveGraphTheme({});
		const rawEscape = /\x1b\](?!.*\x1b_)|\x1b\[2J|\x07|\x1b\[\?1049|\x9b/;
		const hostileNames = [
			"evil\x1b]52;c;ZXZpbA==\x07name",
			"clear\x1b[2Jscreen",
			"bell\x07bell",
			"alt\x1b[?1049h",
			"c1\x9b31mred",
		];

		for (const name of hostileNames) {
			for (const overflow of [false, true]) {
				for (const width of [20, 40, 60, 80, 120]) {
					const top = overflow
						? `${"─".repeat(Math.max(0, width - 14))} ↑ 3 more ${"─".repeat(4)}`.slice(0, width)
						: "─".repeat(width);
					const lines = [top, "❯ ", "─".repeat(width)];
					const ctx = { theme: graphTheme, chatHost: { hasInputText: () => false } } as never;
					const stage = {
						id: "s1",
						name,
						status: "running",
						parentIds: [],
						toolEvents: [],
						startedAt: Date.now() - 5_000,
					} as never;
					const decorated = injectStageLabelIntoEditorTopRule(ctx, name, lines, stage);
					assert.equal(
						decorated.some((line) => rawEscape.test(line)),
						false,
						`injectStageLabelIntoEditorTopRule leaked control sequence for ${JSON.stringify(name)} at width ${width}`,
					);
				}
			}
			const editorDecorated = applyStageLabelToEditorTopRule(graphTheme, name, [
				"─".repeat(80),
				"❯ ",
				"─".repeat(80),
			]);
			assert.equal(
				editorDecorated.some((line) => rawEscape.test(line)),
				false,
			);

			const widgetDecorated = applyStageLabelToWidgetTopRule(graphTheme, name, ["─".repeat(80), "body"], 80);
			assert.equal(
				widgetDecorated.some((line) => rawEscape.test(line)),
				false,
			);

			const awaitingDecorated = applyStageLabelToAwaitingInputTopRule(graphTheme, name, [
				`╭─ AWAITING INPUT ${"─".repeat(60)}╮`,
				`╰${"─".repeat(78)}╯`,
			]);
			assert.equal(
				awaitingDecorated.some((line) => rawEscape.test(line)),
				false,
			);
		}
	});
});
