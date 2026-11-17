import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { type AutocompleteProvider, Editor, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { editorThemeFromGraphTheme } from "../../packages/workflows/src/tui/stage-chat-view-render-helpers.ts";
import type { StageChatViewOpts } from "../../packages/workflows/src/tui/stage-chat-view-types.js";
import {
	createStore,
	fakeFooterAgentSession,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

const provider: AutocompleteProvider = {
	getSuggestions: async () => ({
		items: [
			{ value: "tree", label: "tree", description: "Navigate session tree" },
			{ value: "trust", label: "trust", description: "Save project trust" },
		],
		prefix: "/",
	}),
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

async function menuHint(theme: ConstructorParameters<typeof Editor>[1]): Promise<string | undefined> {
	const editor = new Editor(makeTestTui(24), theme);
	editor.setAutocompleteProvider(provider);
	editor.handleInput("/");
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	return editor
		.render(100)
		.map((line) => stripTerminalSequences(line).trim())
		.at(-1);
}

function sessionWithPrompt(isStreaming: boolean): AgentSession {
	const base = fakeFooterAgentSession(isStreaming);
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
			message: { role: "user", content: "review the hint line" },
		},
	];
	return {
		...base,
		state: (base as unknown as { state: unknown }).state,
		model: base.model,
		sessionManager: { ...base.sessionManager, getEntries: () => entries, getEntryCount: () => entries.length },
	} as unknown as AgentSession;
}

function openStageChat(options: {
	isStreaming: boolean;
	withMenu?: boolean;
	localWorkerMessages?: AgentSession["messages"];
}) {
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const made = makeHandle(
		{
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: options.isStreaming,
		},
		options.localWorkerMessages ?? [],
		"running",
		options.localWorkerMessages ? undefined : sessionWithPrompt(options.isStreaming),
	);
	let closed = 0;
	let detached = 0;
	const piEditorFactory: NonNullable<StageChatViewOpts["piEditorFactory"]> = (tui, theme, kb) => {
		const editor = new CustomEditor(tui, theme, kb instanceof KeybindingsManager ? kb : keys, { paddingX: 0 });
		const set = editor.setAutocompleteProvider.bind(editor);
		editor.setAutocompleteProvider = () => set(provider);
		set(provider);
		return editor;
	};
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: made.handle,
		onDetach: () => detached++,
		onClose: () => closed++,
		piTui: makeTestTui(30),
		piKeybindings: keys,
		...(options.withMenu ? { piEditorFactory } : {}),
	});
	const screen = () => stripAnsi(view.render(100).join("\n"));
	return { view, state: made.state, screen, closed: () => closed, detached: () => detached };
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

test("a workflow stage chat's / menu ends with the main chat's hint line and esc closes it without pausing (#5224)", async () => {
	const main = await menuHint(getEditorTheme());
	const stage = await menuHint(editorThemeFromGraphTheme(deriveGraphTheme()));
	assert.equal(main, "↑↓ select · tab complete · enter run · esc close");
	assert.equal(stage, main);

	for (const isStreaming of [false, true]) {
		const chat = openStageChat({ isStreaming, withMenu: true });
		try {
			chat.view.handleInput("/");
			await vi.waitFor(() => assert.match(chat.screen(), /↑↓ select · tab complete · enter run · esc close/));
			assert.doesNotMatch(chat.screen(), /esc to interrupt|return to graph/);
			chat.view.handleInput("\x1b");
			assert.equal(chat.state.pauseCalls, 0);
			assert.doesNotMatch(chat.screen(), /esc close/);
			assert.doesNotMatch(chat.screen(), /Navigate session tree/);
		} finally {
			chat.view.dispose();
		}
	}
});

test("ctrl+r in a stage chat routes Esc and ← to the prompt search and reads local-worker stage prompts (#5224)", async () => {
	for (const isStreaming of [false, true]) {
		const chat = openStageChat({ isStreaming });
		try {
			for (const ch of "my draft") chat.view.handleInput(ch);
			chat.view.handleInput("\x12");
			await vi.waitFor(() => assert.match(chat.screen(), /Search prompts/));
			assert.match(chat.screen(), /review the hint line.*3m ago/);
			assert.doesNotMatch(chat.screen(), /esc to interrupt|return to graph/);
			for (const ch of "hint") chat.view.handleInput(ch);
			chat.view.handleInput("\x1b[D");
			assert.equal(chat.detached(), 0);
			chat.view.handleInput("\x1b");
			assert.equal(chat.state.pauseCalls, 0);
			assert.match(chat.screen(), /Search prompts/);
			chat.view.handleInput("\x1b");
			assert.equal(chat.state.pauseCalls, 0);
			assert.doesNotMatch(chat.screen(), /Search prompts/);
			assert.equal(chat.view._inputBuffer, "my draft");
		} finally {
			chat.view.dispose();
		}
	}

	const sentAt = Date.now() - 5 * 60_000;
	const pooled = openStageChat({
		isStreaming: false,
		localWorkerMessages: [{ role: "user", content: "pooled stage prompt", timestamp: sentAt }],
	});
	try {
		pooled.view.handleInput("\x12");
		await vi.waitFor(() => assert.match(pooled.screen(), /Search prompts/));
		assert.match(pooled.screen(), /pooled stage prompt.*5m ago/);
	} finally {
		pooled.view.dispose();
	}
});
