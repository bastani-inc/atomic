import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.ts";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.ts";
import { WorkingRunMeter } from "../../packages/coding-agent/src/modes/interactive/components/working-run-meter.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	type AgentSessionEvent,
	assert,
	createStore,
	deriveGraphTheme,
	makeHandle,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

vi.mock("../../packages/coding-agent/src/modes/interactive/whimsical-messages.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../packages/coding-agent/src/modes/interactive/whimsical-messages.ts")
	>()),
	pickWhimsicalWorkingMessage: () => "Brewing...",
}));

const WIDTH = 96;

function assistant(text: string, output: number) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function mainChat() {
	const statusContainer = new Container();
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		ui: { requestRender() {}, terminal: { setProgress() {} } },
		workingVisible: true,
		workingMessage: undefined,
		lastWorkingMessage: undefined,
		defaultWorkingMessage: "Working...",
		workingIndicatorOptions: undefined,
		workingIndicatorEmbedded: false,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		compactionActive: false,
		compactionQueuedMessages: [],
		pendingTools: new Map(),
		workingRunMeter: new WorkingRunMeter(),
		statusContainer,
		chatContainer: new Container(),
		settingsManager: {
			getShowTerminalProgress: () => false,
			getClearOnShrink: () => false,
			getShowCacheMissNotices: () => false,
		},
		getWorkingLoaderMessage: InteractiveModeBase.prototype.getWorkingLoaderMessage,
		createWorkingLoader: InteractiveModeBase.prototype.createWorkingLoader,
		clearWorkingLoader: InteractiveModeBase.prototype.clearWorkingLoader,
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
		showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
		checkShutdownRequested: async () => {},
	} as unknown as InteractiveModeBase;
	return {
		apply: (event: AgentSessionEvent) => InteractiveModeBase.prototype.handleEvent.call(mode, event as never),
		line: () => statusLine(statusContainer.render(WIDTH)),
		dispose: () => mode.stopWorkingLoader(),
	};
}

function stageChat() {
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "running");
	const { handle, emit } = makeHandle();
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
	});
	return {
		apply: async (event: AgentSessionEvent) => emit(event),
		line: () => statusLine(view.render(WIDTH)),
		dispose: () => view.dispose(),
	};
}

function subagentView(workingTokenCount?: () => number | undefined) {
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		requestRender: () => {},
		commands: { send: async () => {} },
		...(workingTokenCount === undefined ? {} : { workingTokenCount }),
	} as never);
	return {
		host,
		apply: async (event: AgentSessionEvent) => {
			host.applyAgentEvent(event);
		},
		line: () => statusLine(host.renderWorkingStatus(WIDTH)),
		dispose: () => host.dispose(),
	};
}

function statusLine(rows: readonly string[]): string {
	return rows.map((row) => stripTerminalSequences(row).trim()).find((row) => row.startsWith("∀ ")) ?? "";
}

describe("one working line in the main chat, a stage chat and a subagent view (#5224)", () => {
	beforeAll(() => initTheme("dark", false));
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => vi.useRealTimers());

	test("the same events paint the same working line and end row in all three views; a stage chat and a subagent view count the agent's total (#5224)", async () => {
		const views = [mainChat(), stageChat(), subagentView()];
		const lines = () => views.map((view) => view.line());
		const all = async (event: unknown) => {
			for (const view of views) await view.apply(event as AgentSessionEvent);
		};
		try {
			await all({ type: "agent_start" });
			await all({ type: "turn_start" });
			assert.deepEqual(lines(), Array(3).fill("∀ Brewing..."));

			vi.setSystemTime(1_005_000);
			const message = assistant("checking the lock", 120);
			await all({ type: "message_end", message });
			assert.deepEqual(lines(), Array(3).fill("∀ Brewing... (5s · ↓ 120 tokens)"));

			await all({ type: "turn_end", message, toolResults: [] });
			vi.setSystemTime(1_007_000);
			await all({ type: "turn_start" });
			assert.deepEqual(lines(), Array(3).fill("∀ Brewing... (7s · ↑ 120 tokens)"));

			vi.setSystemTime(1_009_000);
			await all({ type: "turn_end", message, toolResults: [] });
			await all({ type: "agent_end", messages: [message] });
			assert.deepEqual(lines(), Array(3).fill("∀ Brewed for 9s · ↓ 120 tokens"));

			await all({ type: "agent_start" });
			assert.deepEqual(lines(), [
				"∀ Working...",
				"∀ Working... (0s · ↓ 120 tokens)",
				"∀ Working... (0s · ↓ 120 tokens)",
			]);
		} finally {
			for (const view of views) view.dispose();
		}
	});

	test("delta-only message_update and thinking_delta switch the working line from requesting to receiving and count live tokens (#5224)", async () => {
		let reportedTaskTokens = 0;
		const sub = subagentView(() => reportedTaskTokens);
		try {
			await sub.apply({ type: "agent_start" } as AgentSessionEvent);
			await sub.apply({ type: "turn_start" } as AgentSessionEvent);
			vi.setSystemTime(1_003_000);
			const firstTurn = assistant("step one", 120);
			await sub.apply({ type: "message_end", message: firstTurn } as unknown as AgentSessionEvent);
			await sub.apply({ type: "turn_end", message: firstTurn, toolResults: [] } as unknown as AgentSessionEvent);

			vi.setSystemTime(1_004_000);
			await sub.apply({ type: "turn_start" } as AgentSessionEvent);
			assert.equal(sub.line(), "∀ Brewing... (4s · ↑ 120 tokens)");

			const seed = {
				...assistant("", 0),
				content: [],
			};
			await sub.apply({ type: "message_start", message: seed } as unknown as AgentSessionEvent);
			await sub.apply({
				type: "message_update",
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			} as unknown as AgentSessionEvent);
			assert.equal(sub.line(), "∀ Brewing... (4s · ↑ 120 tokens)");

			await sub.apply({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcdefgh" },
			} as unknown as AgentSessionEvent);
			assert.equal(sub.line(), "∀ Brewing... (4s · ↓ 122 tokens)");

			reportedTaskTokens = 500;
			assert.equal(sub.line(), "∀ Brewing... (4s · ↓ 502 tokens)");
		} finally {
			sub.dispose();
		}
	});

	test("a subsequent run that ends before turn_start uses Worked instead of the previous run's verb (#5224)", async () => {
		const views = [mainChat(), stageChat(), subagentView()];
		const lines = () => views.map((view) => view.line());
		const all = async (event: unknown) => {
			for (const view of views) await view.apply(event as AgentSessionEvent);
		};
		try {
			await all({ type: "agent_start" });
			await all({ type: "turn_start" });
			vi.setSystemTime(1_004_000);
			await all({ type: "agent_end", messages: [] });
			assert.deepEqual(lines(), Array(3).fill("∀ Brewed for 4s"));

			await all({ type: "agent_start" });
			vi.setSystemTime(1_006_000);
			await all({ type: "agent_end", messages: [] });
			assert.deepEqual(lines(), Array(3).fill("∀ Worked for 2s"));
		} finally {
			for (const view of views) view.dispose();
		}
	});
});
