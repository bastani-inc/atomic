import assert from "node:assert/strict";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	interruptChatSession,
	restoreQueuedMessagesToEditor,
} from "../src/modes/interactive/components/chat-session-host-actions.ts";
import {
	type ChatSessionEditorCallbacks,
	createChatSessionEditor,
	handleChatSessionInput,
} from "../src/modes/interactive/components/chat-session-host-editor.ts";
import { ChatSessionHostState } from "../src/modes/interactive/components/chat-session-host-state.ts";
import type {
	ChatSessionHostOpts,
	ChatSessionHostStyle,
} from "../src/modes/interactive/components/chat-session-host-types.ts";

const identity = (text: string): string => text;

const style: ChatSessionHostStyle = {
	dim: identity,
	text: identity,
	textMuted: identity,
	accent: identity,
	accentBold: identity,
	rule: (_hex, text) => text,
	cursor: () => "",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};

const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

type EscapeEditor = EditorComponent & {
	onEscape?: () => void;
	onAction?: (action: string, handler: () => void) => void;
};

function makeEditor(): EscapeEditor {
	return {
		render: () => [],
		invalidate: () => {},
		getText: () => "",
		setText: () => {},
		handleInput: () => {},
		onAction: () => {},
	} as EscapeEditor;
}

function makeState(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHostState {
	const opts: ChatSessionHostOpts = {
		style,
		editorTheme,
		isStreaming: () => true,
		...overrides,
	};
	return new ChatSessionHostState(opts, {
		renderEntry: (): Component => ({ render: () => [], invalidate: () => {} }),
		transcriptCacheKey: () => "",
	});
}

function makeCallbacks(state: ChatSessionHostState): {
	callbacks: ChatSessionEditorCallbacks;
	interruptPromise: () => Promise<void>;
} {
	let pendingInterrupt: Promise<void> | undefined;
	const callbacks: ChatSessionEditorCallbacks = {
		submit: () => {},
		restoreQueuedMessagesToEditor: () => restoreQueuedMessagesToEditor(state),
		abortCompaction: () => {},
		interrupt: (options) => {
			// Reflect.apply keeps this regression test runnable against the pre-fix
			// one-argument function while still exercising the new option at runtime.
			pendingInterrupt = Reflect.apply(interruptChatSession, undefined, [state, options]);
			return pendingInterrupt;
		},
		abortBash: () => {},
	};
	return {
		callbacks,
		interruptPromise: () => {
			if (pendingInterrupt === undefined) throw new Error("Escape did not invoke interrupt");
			return pendingInterrupt;
		},
	};
}

function makePauseSession(events: string[]): AgentSession {
	return {
		pauseQueuedMessages: vi.fn(() => events.push("pause")),
		resumeQueuedMessages: vi.fn(),
		clearQueue: vi.fn((options?: { preserveUnprotectedCustomMessages?: boolean }) =>
			events.push(options?.preserveUnprotectedCustomMessages ? "clear-preserve" : "clear"),
		),
	} as unknown as AgentSession;
}

describe("chat session host Escape queue restoration", () => {
	test("editor Escape restores steering and follow-up text before interrupting", async () => {
		const events: string[] = [];
		const session = makePauseSession(events);
		const interruptCalls = { count: 0 };
		const state = makeState({
			getAgentSession: () => session,
			commands: {
				interrupt: async () => {
					events.push("interrupt");
					interruptCalls.count += 1;
				},
			},
		});
		state.inputBuffer = "current draft";
		state.pendingSteeringMessages = ["first steering", "second steering"];
		state.pendingFollowUpMessages = ["follow-up"];
		const editor = makeEditor();
		const { callbacks, interruptPromise } = makeCallbacks(state);
		createChatSessionEditor(state, {} as TUI, {}, editorTheme, () => editor, callbacks);

		editor.onEscape?.();
		await interruptPromise();

		assert.equal(state.inputBuffer, "first steering\n\nsecond steering\n\nfollow-up\n\ncurrent draft");
		assert.deepEqual(state.pendingSteeringMessages, []);
		assert.deepEqual(state.pendingFollowUpMessages, []);
		assert.deepEqual(events, ["pause", "clear-preserve", "interrupt"]);
		assert.equal(interruptCalls.count, 1);
	});

	test("handleInput Escape restores queued text before interrupting", async () => {
		const events: string[] = [];
		const session = makePauseSession(events);
		const state = makeState({
			getAgentSession: () => session,
			commands: { interrupt: async () => events.push("interrupt") },
		});
		state.inputBuffer = "draft";
		state.pendingSteeringMessages = ["steering"];
		state.pendingFollowUpMessages = ["follow-up"];
		const { callbacks, interruptPromise } = makeCallbacks(state);

		assert.equal(handleChatSessionInput(state, "\x1b", callbacks), true);
		await interruptPromise();

		assert.equal(state.inputBuffer, "steering\n\nfollow-up\n\ndraft");
		assert.deepEqual(state.pendingSteeringMessages, []);
		assert.deepEqual(state.pendingFollowUpMessages, []);
		assert.deepEqual(events, ["pause", "clear-preserve", "interrupt"]);
	});

	test("handleInput Escape suppresses the empty-queue notice while alt+up keeps it", async () => {
		const status = vi.fn();
		const emptyState = makeState({
			showStatus: status,
			getAgentSession: () => makePauseSession([]),
			commands: { interrupt: async () => {} },
		});
		const emptyCallbacks = makeCallbacks(emptyState);
		assert.equal(handleChatSessionInput(emptyState, "\x1b", emptyCallbacks.callbacks), true);
		await emptyCallbacks.interruptPromise();
		assert.equal(status.mock.calls.length, 0);

		const dequeueStatus = vi.fn();
		const dequeueState = makeState({ isStreaming: () => false, showStatus: dequeueStatus });
		dequeueState.inputBuffer = "draft";
		dequeueState.pendingSteeringMessages = ["queued"];
		const dequeueCallbacks = makeCallbacks(dequeueState);
		assert.equal(handleChatSessionInput(dequeueState, "\x1bp", dequeueCallbacks.callbacks), true);
		assert.equal(dequeueState.inputBuffer, "queued\n\ndraft");
		assert.deepEqual(dequeueStatus.mock.calls, []);

		const emptyDequeueStatus = vi.fn();
		const emptyDequeueState = makeState({ isStreaming: () => false, showStatus: emptyDequeueStatus });
		const emptyDequeueCallbacks = makeCallbacks(emptyDequeueState);
		assert.equal(handleChatSessionInput(emptyDequeueState, "\x1bp", emptyDequeueCallbacks.callbacks), true);
		assert.deepEqual(emptyDequeueStatus.mock.calls, [["No queued messages to restore"]]);
	});
});
