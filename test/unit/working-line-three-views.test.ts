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
	...(await importOriginal<typeof import("../../packages/coding-agent/src/modes/interactive/whimsical-messages.ts")>()),
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

function subagentView() {
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		requestRender: () => {},
		commands: { send: async () => {} },
	} as never);
	return {
		apply: async (event: AgentSessionEvent) => {
			host.applyAgentEvent(event);
		},
		line: () => statusLine(host.renderWorkingStatus(WIDTH)),
		dispose: () => host.dispose(),
	};
}

function statusLine(rows: readonly string[]): string {
	return (
		rows
			.map((row) => stripTerminalSequences(row).trim())
			.find((row) => row.startsWith("∀ ")) ?? ""
	);
}

describe("one working line in the main chat, a stage chat and a subagent view (#5224)", () => {
	beforeAll(() => initTheme("dark", false));
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => vi.useRealTimers());

	test("the same events paint the same working line and end row in all three views; a stage chat and a subagent view count the agent's total", async () => {
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
});
