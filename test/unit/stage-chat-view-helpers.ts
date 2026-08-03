/**
 * Unit tests for `StageChatView`.
 *
 * Verifies:
 *  - Idle stage: Enter sends `handle.prompt(text)`.
 *  - Running stage: Enter sends `handle.steer(text)`.
 *  - ctrl+f sends `handle.followUp(text)`.
 *  - Escape interrupts a streaming stage using the coding-agent chat contract.
 *  - After pause, Enter routes through `handle.resume(text)`.
 *  - Ctrl+X calls `onDetach`; Escape on inspect-only settled/Ctrl+C call `onClose`.
 *
 * cross-ref: src/tui/stage-chat-view.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, type AgentSessionEvent, initTheme, SessionManager } from "@bastani/atomic";
import { type Component, CURSOR_MARKER, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { beforeAll } from "vitest";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageDeliveryActivityEvent } from "../../packages/workflows/src/runs/foreground/stage-delivery-activity.js";
import { StageDeliveryActivity } from "../../packages/workflows/src/runs/foreground/stage-delivery-activity.js";
import { StageQueuedUserMessageBuffer } from "../../packages/workflows/src/runs/foreground/stage-queued-user-messages.js";
import { StageToolExecutionBuffer } from "../../packages/workflows/src/runs/foreground/stage-tool-execution-buffer.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";

beforeAll(() => {
	initTheme("dark", false);
});

export interface StageChatSendUserMessageCall {
	text: string;
	deliverAs: "steer" | "followUp" | undefined;
}

interface HandleState {
	promptCalls: Array<string>;
	steerCalls: Array<string>;
	followUpCalls: Array<string>;
	pauseCalls: number;
	resumeCalls: Array<string | undefined>;
	isStreaming: boolean;
	/**
	 * Opt-in: supplying an array makes the handle expose the admission-aware
	 * `sendUserMessage` surface a real live stage handle has. Left undefined,
	 * the handle stays on the older prompt/steer/followUp-only shape.
	 */
	sendUserMessageCalls?: Array<StageChatSendUserMessageCall>;
}

export function makeHandle(
	state: HandleState = {
		promptCalls: [],
		steerCalls: [],
		followUpCalls: [],
		pauseCalls: 0,
		resumeCalls: [],
		isStreaming: false,
	},
	messages: AgentSession["messages"] = [],
	status: StageControlHandle["status"] = "running",
	agentSession?: AgentSession,
): {
	handle: StageControlHandle;
	state: HandleState;
	emit: (event: AgentSessionEvent) => void;
	emitDeliveryActivity: (event: StageDeliveryActivityEvent) => void;
	deliveryActivity: StageDeliveryActivity;
	deliveryActivityListeners: () => number;
} {
	const rawDeliveryListeners = new Set<(event: StageDeliveryActivityEvent) => void>();
	// A real channel so replay-on-subscribe is exercised end to end; the raw set
	// stays available for tests that need exact synthetic delivery ids.
	const deliveryActivity = new StageDeliveryActivity();
	let listener: ((e: AgentSessionEvent) => void) | undefined;
	const toolExecutions = new StageToolExecutionBuffer();
	// Mirror the real handle: the queue projection is kept by the handle itself,
	// so it survives a stage chat being disposed and remounted.
	const queuedUserMessages = new StageQueuedUserMessageBuffer();
	let handleStatus = status;
	const handle: StageControlHandle = {
		runId: "run-1",
		stageId: "stage-a",
		stageName: "review-a",
		get status() {
			return handleStatus;
		},
		sessionId: undefined,
		sessionFile: undefined,
		get isStreaming() {
			return state.isStreaming;
		},
		messages,
		agentSession,
		pendingToolExecutionEvents() {
			return toolExecutions.replayEvents();
		},
		queuedUserMessages() {
			return queuedUserMessages.snapshot();
		},
		async ensureAttached() {},
		async prompt(text: string) {
			state.promptCalls.push(text);
		},
		async steer(text: string) {
			state.steerCalls.push(text);
		},
		async followUp(text: string) {
			state.followUpCalls.push(text);
		},
		async pause() {
			state.pauseCalls += 1;
			handleStatus = "paused";
		},
		async resume(message?: string) {
			state.resumeCalls.push(message);
			handleStatus = "running";
		},
		subscribe(l) {
			listener = l;
			void listener; // silence unused
			return () => {
				listener = undefined;
			};
		},
		subscribeDeliveryActivity(l) {
			rawDeliveryListeners.add(l);
			const unsubscribeChannel = deliveryActivity.subscribe(l);
			return () => {
				rawDeliveryListeners.delete(l);
				unsubscribeChannel();
			};
		},
	};
	if (state.sendUserMessageCalls !== undefined) {
		handle.sendUserMessage = async (text, options) => {
			state.sendUserMessageCalls?.push({ text, deliverAs: options?.deliverAs });
			return options?.deliverAs ?? "prompt";
		};
	}
	return {
		handle,
		state,
		emit: (event: AgentSessionEvent) => {
			toolExecutions.record(event);
			queuedUserMessages.record(event);
			listener?.(event);
		},
		emitDeliveryActivity: (event: StageDeliveryActivityEvent) => {
			for (const deliveryListener of [...rawDeliveryListeners]) deliveryListener(event);
		},
		deliveryActivity,
		deliveryActivityListeners: () => rawDeliveryListeners.size,
	};
}

export function setupRun(
	store: ReturnType<typeof createStore>,
	runId: string,
	stageId: string,
	status: "pending" | "running" | "paused" | "blocked" | "completed" | "failed" | "skipped" = "running",
) {
	store.recordRunStart({
		id: runId,
		name: "test-wf",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	});
	store.recordStageStart(runId, {
		id: stageId,
		name: "review-a",
		status,
		parentIds: [],
		toolEvents: [],
	});
}

export async function flush(): Promise<void> {
	return new Promise<void>((resolve) => queueMicrotask(resolve));
}

export function submitStageChatText(view: StageChatView, text: string): void {
	for (const ch of text) view.handleInput(ch);
	view.handleInput("\r");
}

export function makeStageChatViewForSlashCommand(callbacks: { onClose?: () => void } = {}): StageChatView {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle } = makeHandle();
	return new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: callbacks.onClose ?? (() => {}),
	});
}

export function fakeFooterAgentSession(isStreaming = false): AgentSession {
	return {
		state: {
			model: {
				id: "gpt-5.5",
				provider: "openai-codex",
				reasoning: true,
				contextWindow: 200000,
			},
			thinkingLevel: "high",
		},
		sessionManager: {
			getCwd: () => "/home/alilavaee/Documents/projects/atomic",
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: 1200,
							output: 3400,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 4600,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.123,
							},
						},
					},
				},
			],
		},
		modelRuntime: {
			isUsingOAuth: () => false,
		},
		settingsManager: {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
		},
		getContextUsage: () => ({
			tokens: 46800,
			contextWindow: 200000,
			percent: 23.4,
		}),
		isStreaming,
	} as unknown as AgentSession;
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export const CTRL_X_VARIANTS = ["\x18", "\x1b[120;5u", "\x1b[120;5:1u", "\x1b[27;5;120~"];

export const RETURN_HINT_TEXT = "ctrl+x return to graph · ctrl+t copy mode off";
export const COMPACT_RETURN_HINT_TEXT = "ctrl+x graph · ctrl+t off";

export function expectRightAlignedReturnHint(lines: readonly string[], width: number, rightInset = 0): number {
	const hint = lines.some((line) => line.includes(RETURN_HINT_TEXT)) ? RETURN_HINT_TEXT : COMPACT_RETURN_HINT_TEXT;
	const index = lines.findIndex((line) => line.includes(hint));
	assert.ok(index >= 0, "expected Ctrl+X hierarchy navigation hint");
	assert.equal(lines[index]!.indexOf(hint), width - hint.length - rightInset);
	return index;
}

export function makePendingPrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
	return {
		id: "prompt-1",
		kind: "input",
		message: "What should the workflow use?",
		createdAt: Date.now(),
		...overrides,
	};
}

export function makeCompletedPromptArchiveView(message: string, response: string): StageChatView {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const prompt = makePendingPrompt({ kind: "input", message });
	assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
	assert.equal(store.resolveStagePendingPrompt("run-1", "stage-a", prompt.id, response), true);

	const resolvedStage = store.runs()[0]!.stages[0]!;
	store.recordStageEnd("run-1", {
		...resolvedStage,
		status: "completed",
		endedAt: Date.now(),
		durationMs: 1,
	});

	return new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: undefined,
		onDetach: () => {},
		onClose: () => {},
		getViewportRows: () => 10,
	});
}

export class FakePromptEditor implements EditorComponent {
	text = "";
	focused = false;
	disposeCalls = 0;
	readonly receivedInput: string[] = [];
	borderColor?: (str: string) => string;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	render(_width: number): string[] {
		return [`fake-pi-editor:${this.text}${this.focused ? CURSOR_MARKER : ""}`];
	}

	handleInput(data: string): void {
		this.receivedInput.push(data);
		if (data === "\r" || data === "\n") {
			this.onSubmit?.(this.text);
			return;
		}
		this.text += data;
		this.onChange?.(this.text);
	}

	invalidate(): void {}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	dispose(): void {
		this.disposeCalls += 1;
	}
}

export function assistantTextMessage(text: string): AgentSession["messages"][number] {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export type {
	AgentSession,
	AgentSessionEvent,
	Component,
	EditorComponent,
	StageControlHandle,
	StageDeliveryActivityEvent,
	TUI,
};
export {
	assert,
	CURSOR_MARKER,
	createStore,
	deriveGraphTheme,
	join,
	makeFakeKeybindings,
	mkdtempSync,
	SessionManager,
	StageChatView,
	StageUiBroker,
	tmpdir,
};
