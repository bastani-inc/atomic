import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { Container, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { agentPanelItems, taskPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { setAgentViewBridge } from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-bridge.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
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
import { showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { renderIntercomCustomMessage } from "../../packages/intercom/ui/inline-message.js";
import { renderSubagentToolResult } from "../../packages/subagents/src/extension/tool-rendering.js";
import { fakeFooterAgentSession } from "../helpers/footer-session.js";

import { taskFixture } from "../helpers/task-projection.js";

import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const ESC = "\x1b";
const LEFT = "\x1b[D";

const APPLICATION_COMMAND = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const plain = (lines: readonly string[]): string[] =>
	lines.map((line) => stripVTControlCharacters(line.replace(APPLICATION_COMMAND, "")).trimEnd());

/** The attached composer's top rule: the main composer's rule glyphs ending in its label (#5224). */
const isComposerTopRule = (row: string): boolean =>
	/^─+ .+ ─$/.test(stripVTControlCharacters(row.replace(APPLICATION_COMMAND, "")).trimEnd());

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

describe("a subagent's chat page from /tasks (#5224)", () => {
	test("opened from the /tasks list it shows the launch prompt once in its transcript and its live keys, and ← returns to the list (#5224)", async () => {
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

			inspector.open(taskId);
			assert.equal(inspector.handleInput("\r"), true, "Enter on the subagent's row opens its chat");
			await flush();

			for (const width of [80, 160]) {
				const rows = plain(inspector.renderViewport(width, 24));
				assert.match(rows[0] ?? "", /^Transcript · /, `width ${width}: the page's title row`);
				const beforeComposer = rows.slice(0, rows.findIndex(isComposerTopRule));
				assert.equal(
					beforeComposer.filter((row) => row.includes("Fix #5220: make lock creation atomic")).length,
					1,
					`width ${width}: the launch prompt is shown once, as the transcript's first message`,
				);
				assert.equal(
					rows.at(-1),
					"  ← tasks · esc to pause · pgup/pgdn scroll · ctrl+o expand · ? keys",
					`width ${width}: running hint lists ← tasks and live keys`,
				);
			}

			// Ctrl+O toggles tool expansion
			assert.equal(inspector.handleInput("\x0f"), true);
			assert.equal(expanded, true);

			// ? on empty prompt opens key overlay, Esc closes overlay without interrupting
			assert.equal(inspector.handleInput("?"), true);
			const overlayRows = plain(inspector.renderViewport(100, 24));
			assert.ok(overlayRows.some((row) => /^╭─ keys · task chat /.test(row)));
			assert.equal(interrupted, 0);
			assert.equal(inspector.handleInput(ESC), true);
			assert.equal(interrupted, 0, "closing ? overlay with Esc does not interrupt the subagent");

			// Esc on the chat pauses the subagent and updates the hint line (no esc to pause once idle)
			assert.equal(inspector.handleInput(ESC), true);
			await flush();
			assert.equal(interrupted, 1);
			assert.equal(closed, 0, "Esc never leaves the subagent chat");
			const idleRows = plain(inspector.renderViewport(100, 24));
			assert.equal(idleRows.at(-1), "  ← tasks · pgup/pgdn scroll · ctrl+o expand · ? keys");

			// ← on empty prompt goes back to the list, which stays open
			assert.equal(inspector.handleInput(LEFT), true);
			assert.equal(closed, 0);
			assert.doesNotMatch(plain(inspector.renderViewport(100, 24))[0] ?? "", /^Transcript · /);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	});

	test("an SDK host's echoed launch prompt: the body leaves it out only while it fits the host's one-line echo, across resizes, multiline prompts, images, parent history and a notice before it (#5224)", () => {
		const bodyOf = (
			echoed: string,
			messages: ReadonlyArray<{ role: string; content: unknown; timestamp: number }>,
			width: number,
		): string[] => {
			const host = new ChatSessionHost({
				style: themedChatHostStyle(),
				editorTheme: getEditorTheme(),
				taskRowsInChat: false,
				echoedInitialPrompt: echoed,
			});
			try {
				host.replaceMessages([...messages, createAssistantMessage("Working on it.")] as never);
				return plain(host.renderBody(width, 40));
			} finally {
				host.dispose();
			}
		};

		// 1. A long prompt never fits one line: the body keeps all of it, tail included
		const longPrompt = `${"Investigate concurrency race condition in task store ".repeat(3)}TAIL-SENTINEL-BEYOND-160`;
		for (const width of [80, 160]) {
			const body = bodyOf(longPrompt, [{ role: "user", content: longPrompt, timestamp: 1_000 }], width).join("\n");
			assert.match(body, /TAIL-SENTINEL-BEYOND-160/, `width ${width}: the body keeps the full long prompt`);
		}

		// 2. A 96-character prompt fits at 160 columns (left out of the body) but not at 80 (shown), and again at 160
		const mediumPrompt = `${"Trace lock owner handoff across worker restarts and verify cleanup ".padEnd(76, "x")} RESIZE-TAIL-SENTINEL`;
		const medium = [{ role: "user", content: mediumPrompt, timestamp: 1_000 }];
		assert.doesNotMatch(bodyOf(mediumPrompt, medium, 160).join("\n"), /RESIZE-TAIL-SENTINEL/, "160 cols: echoed");
		assert.match(bodyOf(mediumPrompt, medium, 80).join("\n"), /RESIZE-TAIL-SENTINEL/, "80 cols: in the body");
		assert.doesNotMatch(bodyOf(mediumPrompt, medium, 160).join("\n"), /RESIZE-TAIL-SENTINEL/, "160 cols again");

		// 3. A multiline prompt is never echoed on one line: the body keeps every line
		const multilinePrompt = "First line summary\nSecond line detail MULTILINE-TAIL-SENTINEL";
		const multiline = bodyOf(
			multilinePrompt,
			[{ role: "user", content: multilinePrompt, timestamp: 1_000 }],
			120,
		).join("\n");
		assert.match(multiline, /First line summary/);
		assert.match(multiline, /Second line detail MULTILINE-TAIL-SENTINEL/);

		// 4. A prompt with an image, and the parent's history before the launch prompt, stay in the body
		const imagePrompt = "Short prompt with image";
		const image = bodyOf(
			imagePrompt,
			[
				{
					role: "user",
					content: [
						{ type: "text", text: imagePrompt },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					timestamp: 1_000,
				},
			],
			120,
		).join("\n");
		assert.match(image, /Short prompt with image/);
		const parentHistory = bodyOf(
			"Child task prompt",
			[
				{ role: "user", content: "Parent context prompt", timestamp: 500 },
				createAssistantMessage("Parent answer.", { timestamp: 800 }),
				{ role: "user", content: "Child task prompt", timestamp: 1_000 },
			],
			120,
		).join("\n");
		assert.match(parentHistory, /Parent context prompt/);
		assert.match(parentHistory, /Child task prompt/);

		// 5. A notice before the launch prompt does not stop the echo; a later identical prompt stays in the body
		const prefacedPrompt = "Launch prompt after pre-start custom";
		const prefaced = bodyOf(
			prefacedPrompt,
			[
				{
					role: "custom",
					customType: "intercom_message",
					content: "Pre-start custom context",
					display: true,
					timestamp: 500,
				} as never,
				{ role: "user", content: prefacedPrompt, timestamp: 1_000 },
				createAssistantMessage("Initial reply.", { timestamp: 1_500 }),
				{ role: "user", content: prefacedPrompt, timestamp: 2_000 },
			],
			120,
		);
		assert.ok(
			prefaced.some((row) => row.includes("Pre-start custom context")),
			"the notice stays visible",
		);
		assert.equal(
			prefaced.filter((row) => row.includes(prefacedPrompt)).length,
			1,
			"the launch prompt is echoed while the later identical prompt stays in the body",
		);
	});
});

describe("cross-view parity across main chat and subagent view (#5224)", () => {
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
			defaultWorkingMessage: "Working…",
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

			// 1. Working line must be identical across main chat and subagent view
			const mainWorkingLines = plain(mainStatusContainer.render(100)).filter((line) => line.trim().length > 0);

			const subLines = plain(subInspector.renderViewport(100, 28));

			// The working line, not the page header's task summary, which carries the task's own glyph.
			const subWorkingLine = subLines.find((line) => /^ ∀ \S+… \(/.test(line));
			assert.equal(mainWorkingLines.length, 1);
			assert.match(mainWorkingLines[0]!, /^ ∀ Schlepping… \(4s · ↓ 7 tokens\)$/);

			assert.equal(subWorkingLine, mainWorkingLines[0], "subagent view working line matches main chat");

			// 2. Hint line while working: stage chat and subagent view share the exact live-key suffix, with no duplicate footer row

			const subRunningHint = subLines.at(-1) ?? "";

			assert.equal(subRunningHint, "  ← main chat · esc to pause · pgup/pgdn scroll · ctrl+o expand · ? keys");

			// 3. ? on an empty prompt opens the shared key overlay in all three views
			const mainOverlay = new MainComposerKeyOverlay(
				keys,
				() => ({ working: true }),
				() => {},
			);
			const mainOverlayLines = plain(mainOverlay.render(100));

			assert.equal(subInspector.handleInput("?"), true);
			const subOverlayLines = plain(subInspector.renderViewport(100, 28));

			assert.match(mainOverlayLines[0] ?? "", /^╭─ keys /);

			assert.ok(subOverlayLines.some((line) => line.startsWith("╭─ keys · task chat ")));
			const closeHelpRow = (rows: readonly string[]) => rows.find((line) => line.includes("close this help"));

			assert.equal(closeHelpRow(subOverlayLines), closeHelpRow(mainOverlayLines));

			// Esc closes the ? overlay in both stage chat and subagent view without interrupting

			assert.equal(subInspector.handleInput(ESC), true);

			assert.equal(subRunning, true, "Esc on subagent ? overlay only closes the overlay");

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

			const subAfterAbort = plain(subInspector.renderViewport(100, 28));

			const mainNotice = mainAfterAbort.find((line) => line.includes("◼ Interrupted"));

			const subNotice = subAfterAbort.find((line) => line.includes("◼ Interrupted"));
			assert.equal(mainNotice, " ◼ Interrupted · response");

			assert.equal(subNotice, mainNotice, "subagent view renders the same shared interruption notice");

			// Hint line after Esc drops the esc hint in both stage and subagent views

			assert.equal(subAfterAbort.at(-1), "  ← main chat · pgup/pgdn scroll · ctrl+o expand · ? keys");

			// ? overlay when idle omits the esc row in both stage chat and subagent view

			assert.equal(subInspector.handleInput("?"), true);

			const idleSubOverlay = plain(subInspector.renderViewport(100, 28)).join("\n");

			assert.doesNotMatch(idleSubOverlay, /pause the agent's turn/);

			assert.equal(subInspector.handleInput(ESC), true);
			assert.equal(
				renderNavHintLine(mainComposerKeys({ working: false }), 100, themedNavKeyStyle(), keys).includes(
					"interrupt",
				),
				false,
			);
		} finally {
			mainMode.stopWorkingLoader();

			subInspector.dispose();
			await subFixture.dispose();
		}
	});

	test("attaching mid-turn to a running subagent view hydrates the whimsical verb and WorkingRunMeter instead of bare Working... (#5224)", async () => {
		const now = 30_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(Math, "random").mockReturnValue(0);

		const settledAssistant = createAssistantMessage("Started background sleep and waiting.", {
			stopReason: "toolUse",
			inputTokens: 100,
			outputTokens: 409,
			timestamp: 5_000,
		});
		const historyMessages = [
			{ role: "user" as const, content: "Run sleep 600 with bash, then reply done.", timestamp: 3_000 },
			settledAssistant,
		];

		// 2. Mid-turn Subagent view attach (turn_start already happened at t=3_000)
		const subFixture = taskFixture();
		await subFixture.start("Run sleep 600 with bash, then reply done.");
		const subSession = SessionManager.inMemory();
		for (const msg of historyMessages) await subSession.appendMessage(msg as never);
		const subTranscript: TaskTranscriptSource = Object.assign(subSession, {
			subscribe: () => () => {},
			isRunning: () => true,
			chatSession: fakeFooterAgentSession(true) as never,
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
			const expectedTokens =
				(settledAssistant.usage.input ?? 0) +
				(settledAssistant.usage.cacheRead ?? 0) +
				(settledAssistant.usage.cacheWrite ?? 0) +
				(settledAssistant.usage.output ?? 0);
			assert.equal(expectedTokens, 509);

			const subWorking = plain(subInspector.renderViewport(100, 24)).find((line) => /^ ∀ \S+… \(/.test(line));

			assert.equal(subWorking, ` ∀ Schlepping… (27s · ↓ ${expectedTokens} tokens)`);
		} finally {
			subInspector.dispose();
			await subFixture.dispose();
		}
	});

	test("remapping navigation, focus, expand, or help to Escape never steals physical Escape from attached subagent chat (#5224)", async () => {
		const remapped = new KeybindingsManager({
			"app.nav.back": ["escape", "left"],
			"app.keys.help": ["escape", "?"],
			"app.agents.focus": ["escape", "down"],
			"app.tools.expand": ["escape", "ctrl+o"],
		});
		setKeybindings(remapped);

		const subFixture = taskFixture();
		await subFixture.start("Check Escape priority in subagent chat");
		const subSession = SessionManager.inMemory();
		await subSession.appendMessage({
			role: "user",
			content: "Check Escape priority in subagent chat",
			timestamp: 1_000,
		});
		let subRunning = true;
		let subInterrupted = 0;
		const subTranscript: TaskTranscriptSource = Object.assign(subSession, {
			subscribe: () => () => {},
			isRunning: () => subRunning,
			async interruptTurn() {
				subInterrupted += 1;
				subRunning = false;
			},
		});
		subFixture.runners[0]!.context.bindTranscript(subTranscript);
		let subExpanded = false;
		let subClosed = 0;
		const subEnv = taskTranscriptEnvironment({
			tui: makeTestTui(24),
			keybindings: remapped,
			getToolsExpanded: () => subExpanded,
			setToolsExpanded: (next) => {
				subExpanded = next;
			},
		});
		const subInspector = new TaskInspector(
			ownerTaskViewSource(subFixture.store),
			() => {},
			() => {
				subClosed += 1;
			},
			undefined,
			() => subEnv,
		);
		subInspector.openChat(subFixture.store.tasks[0]!.ref.taskId);
		await flush();

		try {
			const subRunningHint = plain(subInspector.renderViewport(120, 24)).at(-1) ?? "";

			assert.equal(
				subRunningHint,
				"  ← main chat · esc to pause · pgup/pgdn scroll · ctrl+o expand · ? keys",
				"subagent hint strips dead esc from remapped non-interrupt actions",
			);

			assert.equal(subInspector.handleInput(ESC), true);
			await flush();
			assert.equal(subClosed, 0, "Esc in subagent chat never detaches via remapped app.nav.back");
			assert.equal(subInterrupted, 1, "Esc in subagent chat interrupts the running turn");
			assert.equal(subExpanded, false, "Esc in subagent chat does not toggle tool expansion");
			const subAfterEsc = plain(subInspector.renderViewport(120, 24)).join("\n");
			assert.doesNotMatch(subAfterEsc, /keys · task chat/, "Esc does not open remapped ? help overlay");

			await flush();
		} finally {
			subInspector.dispose();
			await subFixture.dispose();
		}
	});

	test("attached subagent view renders intercom_message entries through the registered Intercom card renderer even after settling (#5239)", async () => {
		const fixture = taskFixture();
		let ownerSessionId: string | undefined = "01a1e951-44cc-7ef6-b030-8418c3d9c1e6";
		const ownerSession = {
			sessionManager: {
				getSessionId: () => ownerSessionId,
			},
			extensionRunner: {
				getMessageRenderer: (customType: string) =>
					customType === "intercom_message" ? renderIntercomCustomMessage : undefined,
			},
		};
		bindOwnerTaskStore(ownerSession, fixture.store);
		await fixture.start("Inspect concurrent spawn locks.");
		const session = SessionManager.inMemory("/tmp/r1fin/sub/proj");
		await session.appendMessage({
			role: "user",
			content: "Inspect concurrent spawn locks.",
			timestamp: 1_000,
		});
		await session.appendMessage(createAssistantMessage("Now waiting on the long check."));
		await session.appendCustomMessageEntry(
			"intercom_message",
			"**📨 From subagent-chat-01a1e951-44cc-7ef6-b030-8418c3d9c1e6** (/tmp/r1fin/sub/proj)\n\nhello again",
			true,
			{
				from: {
					id: "b8a5d7c2-3e54-4cb4-a417-a397f01c16df",
					name: "subagent-chat-01a1e951-44cc-7ef6-b030-8418c3d9c1e6",
					cwd: "/tmp/r1fin/sub/proj",
					model: "claude-haiku-4-5",
					pid: 1234,
					startedAt: 1_000,
					lastActivity: 2_000,
					status: "running",
				},
				message: {
					id: "msg-1",
					timestamp: Date.UTC(2026, 10, 17, 5, 41, 0),
					content: { text: "hello again" },
				},
				bodyText: "hello again",
			},
		);
		await session.appendCustomMessageEntry(
			"intercom_message",
			"**📨 From subagent-chat-22222222-2222-4222-8222-222222222222** (/tmp/r1fin/sub/proj)\n\npeer note",
			true,
			{
				from: {
					id: "99999999-9999-4999-8999-999999999999",
					name: "subagent-chat-22222222-2222-4222-8222-222222222222",
					cwd: "/tmp/r1fin/sub/proj",
					model: "claude-haiku-4-5",
					pid: 1235,
					startedAt: 1_000,
					lastActivity: 2_000,
					status: "running",
				},
				message: {
					id: "msg-2",
					timestamp: Date.UTC(2026, 10, 17, 5, 42, 0),
					content: { text: "peer note" },
				},
				bodyText: "peer note",
			},
		);
		await session.appendMessage(createAssistantMessage("Acknowledged."));
		// Bind a settled history-only transcript (no live subscribe / chatSession) and an RPC-like getChatRenderSettings returning undefined.
		fixture.runners[0]!.context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => session.getEntries(),
		});
		const env = taskTranscriptEnvironment({
			tui: makeTestTui(28),
			keybindings: getKeybindings(),
			getChatRenderSettings: () => ({
				getToolDefinition: () => undefined,
				getCustomMessageRenderer: () => undefined,
			}),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		});
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			() => env,
		);
		try {
			inspector.openChat(fixture.store.tasks[0]!.ref.taskId);
			await flush();
			const rows = plain(inspector.renderViewport(120, 28));
			const text = rows.join("\n");
			assert.doesNotMatch(text, /\[intercom_message\]/, "must not render raw [intercom_message] fallback box");
			assert.doesNotMatch(text, /📨/, "must not render raw 📨 framing");
			assert.doesNotMatch(text, /\/tmp\/r1fin\/sub\/proj/, "must not leak raw full host path");
			assert.doesNotMatch(
				text,
				/subagent-chat-01a1e951-44cc-7ef6-b030-8418c3d9c1e6/,
				"must not show opaque subagent-chat-UUID alias for main chat echo",
			);
			assert.match(text, /^ › Message from main\b/m, "renders friendly › Message from main card at column 1");
			assert.match(
				text,
				/^ › Message from subagent-chat-22222222-2222-4222-8222-222222222222\b/m,
				"unrelated unnamed peer retains its own Intercom identity and is never misidentified as main",
			);
			assert.match(text, /hello again/, "renders message body");
			const customEntry = session.getEntries().find((entry) => entry.type === "custom_message");
			assert.equal(
				(customEntry as { details?: { from?: { name?: string } } } | undefined)?.details?.from?.name,
				"subagent-chat-01a1e951-44cc-7ef6-b030-8418c3d9c1e6",
				"model-facing stored entry retains its original Intercom identity",
			);

			// When owner session identity is unavailable, no runtime alias is renamed to main.
			ownerSessionId = undefined;
			inspector.invalidate();
			const unownedText = plain(inspector.renderViewport(120, 28)).join("\n");
			assert.doesNotMatch(unownedText, /^ › Message from main\b/m, "unknown owner never renames alias to main");
			assert.match(
				unownedText,
				/^ › Message from subagent-chat-01a1e951-44cc-7ef6-b030-8418c3d9c1e6\b/m,
				"keeps raw alias when owner session identity is absent",
			);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	});

	test("pausing an attached subagent stops its elapsed clock, shows paused in composer label and panel, and resumes on follow-up (#5239)", async () => {
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fixture = taskFixture();
		const ownerSession = {};
		bindOwnerTaskStore(ownerSession, fixture.store);
		await fixture.start("Inspect concurrent spawn locks.");
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		fixture.runners[0]!.context.reportActivity({
			reportId: "m-1",
			change: { kind: "metrics", elapsedMs: 14_000, tokenCount: 800, toolCount: 4 },
		});
		fixture.store.drain();

		// Freshly starting child (not yet streaming, not interrupted) is still running, never stopped.
		assert.equal(taskPanelItem(fixture.store.tasks[0]!).state, "running");

		const session = SessionManager.inMemory();
		await session.appendMessage({
			role: "user",
			content: "Inspect concurrent spawn locks.",
			timestamp: 1_000,
		});
		await session.appendMessage(createAssistantMessage("Now waiting on the long check."));
		let running = true;
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const interruptTurn = async () => {
			running = false;
			for (const listener of listeners) listener({ type: "agent_end", messages: [] } as never);
		};
		const queueMessage = async (_text: string) => {
			running = true;
			for (const listener of listeners) listener({ type: "agent_start" } as never);
			return { delivered: true as const };
		};
		const subscribe = (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		const transcript: TaskTranscriptSource = Object.assign(session, {
			subscribe,
			isRunning: () => running,
			completionSource: { runId: "run-1", intercomTarget: "subagent-debugger-1" },
			interruptTurn,
			queueMessage,
		});
		fixture.runners[0]!.context.bindTranscript(transcript);

		// Reading panel items before opening a viewer must not add any transcript listener or mutate transcript methods.
		assert.equal(agentPanelItems(ownerSession)[0]?.state, "running");
		assert.equal(listeners.size, 0, "pure panel state read adds no transcript listener");
		assert.equal(transcript.interruptTurn, interruptTurn, "transcript interruptTurn method is not monkey-patched");
		assert.equal(transcript.queueMessage, queueMessage, "transcript queueMessage method is not monkey-patched");
		assert.equal(transcript.subscribe, subscribe, "transcript subscribe method is not monkey-patched");

		const env = taskTranscriptEnvironment({
			tui: makeTestTui(24),
			keybindings: getKeybindings(),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		});
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			() => env,
		);
		try {
			inspector.openChat(taskId);
			await flush();

			const runningRows = plain(inspector.renderViewport(80, 24));
			const runningRule =
				runningRows.find((row) => isComposerTopRule(row) && row.includes("Inspect concurrent")) ?? "";
			assert.match(runningRule, / · 14s ─$/, "running composer label shows live elapsed");

			// Press Esc to interrupt the subagent turn while native task execution remains running.
			assert.equal(inspector.handleInput(ESC), true);
			await flush();

			assert.equal(
				fixture.store.tasks[0]!.execution.kind,
				"running",
				"authoritative supervisor execution state remains running",
			);

			// Advance time by 10 seconds: elapsed clock must stay frozen and composer label must say paused.
			now += 10_000;
			const interruptedRows = plain(inspector.renderViewport(80, 24));
			const interruptedRule =
				interruptedRows.find((row) => isComposerTopRule(row) && row.includes("Inspect concurrent")) ?? "";
			assert.match(interruptedRule, / · paused ─$/, "paused composer label shows paused instead of ticking");
			assert.ok(
				interruptedRows.some((row) => row.includes("Paused · send to continue")),
				"paused composer placeholder shows Paused · send to continue",
			);

			const panelItems = agentPanelItems(ownerSession);
			assert.equal(panelItems[0]?.state, "paused", "panel item state reflects paused after Esc");
			assert.equal(panelItems[0]?.elapsedMs, 14_000, "panel item elapsed clock stays frozen at 14s");

			const agentBlockState = {};
			const renderMainAgentBlock = () =>
				plain(
					renderSubagentToolResult(
						{
							content: [{ type: "text", text: "" }],
							details: {
								mode: "single",
								inheritContext: false,
								projectAgentsDir: null,
								results: [],
								taskRecords: [fixture.store.tasks[0]!],
								taskResponse: {
									kind: "admitted",
									observation: {
										kind: "yielded",
										taskId,
										ownerId: fixture.store.tasks[0]!.ref.ownerId,
										yieldReason: "background",
									},
								},
							},
						} as never,
						{ expanded: false, isPartial: false },
						theme as never,
						{
							toolCallId: "subagent-call-1",
							state: agentBlockState,
							invalidate: () => {},
							args: { agent: "worker", task: "Inspect concurrent spawn locks." },
							getTaskRecord: (id: string) => fixture.store.getTask(id as never),
							outputPad: 1,
						} as never,
					).render(80),
				);
			assert.deepEqual(renderMainAgentBlock(), [
				" ‖ Agent(worker · Inspect concurrent spawn locks.)",
				"   ⎿  Paused · 14s",
			]);

			// Sending a follow-up message resumes the subagent turn and clears the paused override.
			for (const ch of "hello again") inspector.handleInput(ch);
			inspector.handleInput("\r");
			await flush();

			const resumedItems = agentPanelItems(ownerSession);
			assert.equal(resumedItems[0]?.state, "running", "panel item returns to running after follow-up message");
			const resumedBlock = renderMainAgentBlock();
			assert.match(resumedBlock[0] ?? "", /^ ◯ Agent\(worker · Inspect concurrent spawn locks\.\)$/);
			assert.match(resumedBlock[1] ?? "", /^ {3}⎿ {2}Running · 14s · ↓ 800 tokens/);
			const resumedRows = plain(inspector.renderViewport(80, 24));
			const resumedRule =
				resumedRows.find((row) => isComposerTopRule(row) && row.includes("Inspect concurrent")) ?? "";
			assert.doesNotMatch(resumedRule, / · stopped ─$/, "composer label leaves stopped state once turn resumes");

			// When the follow-up turn finishes and transitions from live followed session to settled history for the same sessionId, the past-tense end row stays visible.
			for (const listener of listeners) {
				listener({ type: "turn_start" } as never);
			}
			now += 4_000;
			const finalReply = createAssistantMessage("Acknowledged.", { outputTokens: 200, timestamp: now });
			await session.appendMessage(finalReply);
			for (const listener of listeners) {
				listener({ type: "message_end", message: finalReply } as never);
				listener({ type: "turn_end", message: finalReply, toolResults: [] } as never);
				listener({ type: "agent_end", messages: [finalReply] } as never);
			}
			running = false;
			// Transition to settled history-only transcript (no subscribe) for the SAME sessionId.
			fixture.runners[0]!.context.bindTranscript({
				getSessionId: () => session.getSessionId(),
				getEntries: () => session.getEntries(),
			});
			fixture.runners[0]!.context.reportActivity({
				reportId: "m-2",
				change: { kind: "metrics", elapsedMs: 18_000, tokenCount: 1_000, toolCount: 4 },
			});
			fixture.store.drain();
			await flush();
			const settledSameSessionRows = plain(inspector.renderViewport(80, 24));
			assert.ok(
				settledSameSessionRows.some((row) => /^ ∀ .+ for 4s · ↓ (?:800|1k) tokens$/.test(row.trimEnd())),
				"live -> history transition for the same conversation preserves the past-tense end row",
			);

			// Switching to a different sessionId resets the previous conversation's end row.
			const otherSession = SessionManager.inMemory();
			await otherSession.appendMessage({ role: "user", content: "Other session", timestamp: now });
			await otherSession.appendMessage(createAssistantMessage("Other reply."));
			fixture.runners[0]!.context.bindTranscript({
				getSessionId: () => otherSession.getSessionId(),
				getEntries: () => otherSession.getEntries(),
			});
			fixture.runners[0]!.context.reportActivity({
				reportId: "m-3",
				change: { kind: "metrics", elapsedMs: 19_000, tokenCount: 1_000, toolCount: 4 },
			});
			fixture.store.drain();
			await flush();
			const switchedSessionRows = plain(inspector.renderViewport(80, 24));
			assert.equal(
				switchedSessionRows.some((row) => /^ ∀ .+ for 4s/.test(row.trimEnd())),
				false,
				"switching to a different sessionId clears the previous conversation's end row",
			);

			// Rebinding the same transcript object to a second task after settlement tracks the new task cleanly.
			await fixture.start("Second subagent task.");
			const secondTaskId = fixture.store.tasks[1]!.ref.taskId;
			fixture.runners[1]!.context.bindTranscript(transcript);
			await ownerTaskViewSource(fixture.store).interruptTask?.(secondTaskId);
			assert.equal(taskPanelItem(fixture.store.tasks[1]!).state, "paused");
			assert.equal(taskPanelItem(fixture.store.tasks[0]!).state, "running");
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	});

	test("Enter on a subagent's row of the focused panel shows it on the screen and opens no page; with no screen to show it on it says so (#5239)", async () => {
		for (const withScreen of [true, false]) {
			const fixture = taskFixture();
			const ownerSession = {};
			bindOwnerTaskStore(ownerSession, fixture.store);
			const requested: (string | undefined)[] = [];
			if (withScreen)
				setAgentViewBridge(ownerSession, {
					viewedTaskId: () => undefined,
					requestView: (taskId) => requested.push(taskId),
					subscribe: () => () => {},
				});
			await fixture.start("Fix #5220: make lock creation atomic");
			const notices: string[] = [];
			let views = 0;
			try {
				await showAgentPanel(ownerSession, {
					getToolsExpanded: () => false,
					setToolsExpanded: () => {},
					notify: (message) => notices.push(message),
					async custom<T>(factory: Parameters<Parameters<typeof showAgentPanel>[1]["custom"]>[0]): Promise<T> {
						views += 1;
						let finished = false;
						const component = await factory(makeTestTui(24), theme, new KeybindingsManager(), (() => {
							finished = true;
						}) as never);
						await flush();
						const rendered = plain(component.render(100));
						assert.ok(rendered.some((line) => line.includes("● main")));
						component.handleInput?.("\r");
						if (!finished) component.dispose?.();
						return undefined as T;
					},
				});
				await flush();
				assert.equal(views, 1, `${withScreen ? "with" : "without"} a screen: only the panel was drawn, no page`);
				assert.deepEqual(requested, withScreen ? [fixture.store.tasks[0]!.ref.taskId] : []);
				assert.deepEqual(notices, withScreen ? [] : ["Could not open worker."]);
			} finally {
				await fixture.dispose();
			}
		}
	});

	test("real tool execution events render byte-identical plain and ANSI tool blocks across main chat and attached subagent view (#5239)", async () => {
		const mainChatContainer = new Container();
		const mainStatusContainer = new Container();
		const mainPendingContainer = new Container();
		const settingsManager = {
			getShowTerminalProgress: () => false,
			getClearOnShrink: () => false,
			getShowCacheMissNotices: () => false,
			getShowImages: () => true,
			getImageWidthCells: () => 60,
			getLatexRenderingEnabled: () => true,
		};
		const sessionManager = SessionManager.inMemory("/repo");
		const mainMode = {
			isInitialized: true,
			ui: { requestRender() {}, terminal: { setProgress() {} } },
			footer: { invalidate() {} },
			programStatus: new ProgramStatusReporter(
				() => ({ setProgramStatus() {} }) as never,
				() => undefined,
			),
			sessionManager,
			settingsManager,
			session: {
				isStreaming: true,
				isCompacting: false,
				compactionReason: undefined,
				pendingMessageCount: 0,
				settingsManager,
				sessionManager,
				modelRuntime: {},
				extensionRunner: {
					getMessageRenderer: () => undefined,
					resolveToolRenderers: () => undefined,
				},
				getToolDefinition: () => undefined,
			},
			statusContainer: mainStatusContainer,
			chatContainer: mainChatContainer,
			pendingMessagesContainer: mainPendingContainer,
			compactionQueuedMessages: [],
			pendingTools: new Map(),
			optimisticUserMessageSignatures: [],
			streamingComponent: undefined,
			streamingMessage: undefined,
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			workingVisible: true,
			workingMessage: undefined,
			lastWorkingMessage: undefined,
			defaultWorkingMessage: "Working…",
			workingIndicatorOptions: undefined,
			workingIndicatorEmbedded: false,
			compactionActive: false,
			workingRunMeter: new WorkingRunMeter(),
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			toolOutputExpanded: false,
			outputPad: 1,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getMarkdownTransformers: () => [],
			getRegisteredToolDefinition: () => undefined,
			chatMessageRenderOptions: InteractiveModeBase.prototype.chatMessageRenderOptions,
			addRenderedChatEntry: InteractiveModeBase.prototype.addRenderedChatEntry,
			getWorkingLoaderMessage: InteractiveModeBase.prototype.getWorkingLoaderMessage,
			createWorkingLoader: InteractiveModeBase.prototype.createWorkingLoader,
			clearWorkingLoader: InteractiveModeBase.prototype.clearWorkingLoader,
			stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
			showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
			updatePendingMessagesDisplay: () => {},
			checkShutdownRequested: async () => {},
		} as unknown as InteractiveModeBase;
		const mainHost = new ChatSessionHost({
			style: themedChatHostStyle(),
			editorTheme: getEditorTheme(),
			getCwd: () => "/repo",
			requestRender: () => {},
			commands: { send: async () => {} },
		});
		(mainMode as unknown as { chatHost: ChatSessionHost }).chatHost = mainHost;

		const fixture = taskFixture();
		await fixture.start("Inspect tools");
		const subSession = SessionManager.inMemory("/repo");
		const subListeners = new Set<(event: AgentSessionEvent) => void>();
		fixture.runners[0]!.context.bindTranscript(
			Object.assign(subSession, {
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					subListeners.add(listener);
					return () => subListeners.delete(listener);
				},
				isRunning: () => true,
			}),
		);
		const subInspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			() =>
				taskTranscriptEnvironment({
					tui: makeTestTui(28),
					keybindings: getKeybindings(),
					getToolsExpanded: () => false,
					setToolsExpanded: () => {},
				}),
		);
		subInspector.openChat(fixture.store.tasks[0]!.ref.taskId);
		await flush();

		const events: AgentSessionEvent[] = [
			{ type: "agent_start" } as AgentSessionEvent,
			{ type: "turn_start" } as AgentSessionEvent,
			{
				type: "tool_execution_start",
				toolCallId: "call-read-1",
				toolName: "read",
				args: { path: "README.md" },
			} as AgentSessionEvent,
			{
				type: "tool_execution_end",
				toolCallId: "call-read-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "line 1\nline 2" }] },
				isError: false,
			} as AgentSessionEvent,
			{
				type: "tool_execution_start",
				toolCallId: "call-bash-1",
				toolName: "bash",
				args: { command: "ls /nonexistent-dir" },
			} as AgentSessionEvent,
			{
				type: "tool_execution_end",
				toolCallId: "call-bash-1",
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "ls: cannot access '/nonexistent-dir': No such file or directory" }],
					details: { exitCode: 2 },
				},
				isError: true,
			} as AgentSessionEvent,
		];

		try {
			for (const event of events) {
				mainHost.applyAgentEvent(event);

				for (const listener of subListeners) listener(event);
			}
			await flush();

			const extractToolRows = (lines: readonly string[]): string[] =>
				lines
					.map((line) => line.trimEnd())
					.filter((line) => {
						const stripped = stripVTControlCharacters(line);
						return (
							stripped.startsWith(" ● Read(") || stripped.startsWith(" ✗ Bash(") || stripped.startsWith("   ⎿  ")
						);
					});

			const mainRaw = extractToolRows(mainHost.renderBody(80, 20));

			const subRaw = extractToolRows(subInspector.renderViewport(80, 28));

			assert.equal(mainRaw.length, 4, "renders 2 tool headers and 2 connector rows");
			assert.deepEqual(plain(mainRaw), [
				" ● Read(README.md)",
				"   ⎿  Read 2 lines",
				" ✗ Bash(ls /nonexistent-dir) · exit 2 · 0.1s",
				"   ⎿  ls: cannot access '/nonexistent-dir': No such file or directory",
			]);

			assert.deepEqual(
				subRaw,
				mainRaw,
				"attached subagent tool rows match main chat in both plain text and ANSI SGR",
			);
		} finally {
			mainHost.dispose();

			subInspector.dispose();
			await fixture.dispose();
		}
	});
});
