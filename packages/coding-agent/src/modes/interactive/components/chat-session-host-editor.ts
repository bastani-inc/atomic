import { type EditorComponent, type EditorTheme, type Focusable, getKeybindings, type TUI } from "@bastani/atomic-tui";
import { openExternalEditorForText, pasteClipboardImageToEditor } from "../chat-input-actions.ts";
import {
	isChatSessionBashRunning,
	isChatSessionStreaming,
	notifyChatSessionStatus,
	notifyChatSessionWarning,
} from "./chat-session-host-runtime.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatSessionHostOpts, ChatSessionSubmitMode } from "./chat-session-host-types.ts";
import { isChatMessageEntry, matchesKey } from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import { CustomEditor } from "./custom-editor.ts";
import {
	PromptHistorySelectorComponent,
	promptHistoryEntries,
	sessionPromptsFromEntries,
} from "./prompt-history-selector.ts";

export interface ChatSessionEditorCallbacks {
	submit: (mode: ChatSessionSubmitMode, submittedText?: string) => void | Promise<void>;
	restoreQueuedMessagesToEditor: () => boolean;
	abortCompaction: () => void | Promise<void>;
	interrupt: (options?: { restoreQueuedMessages?: boolean }) => void | Promise<void>;
	abortBash: () => void | Promise<void>;
}

export function createChatSessionEditor<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	tui: TUI | undefined,
	keybindings: unknown,
	editorTheme: EditorTheme,
	editorFactory: ChatSessionHostOpts<TExtraEntry>["editorFactory"],
	callbacks: ChatSessionEditorCallbacks,
): EditorComponent | undefined {
	if (!tui || !keybindings) return undefined;
	const editor =
		createInheritedEditor(tui, editorTheme, keybindings, editorFactory) ??
		new CustomEditor(tui, editorTheme, keybindings as ConstructorParameters<typeof CustomEditor>[2], {
			paddingX: 0,
			autocompleteMaxVisible: 5,
		});
	editor.onChange = (text) => {
		state.inputBuffer = text;
		state.isBashMode = text.trimStart().startsWith("!");
	};
	editor.onSubmit = (text) => {
		void callbacks.submit("auto", text);
	};
	const actionEditor = editor as EditorComponent & {
		onAction?: (action: string, handler: () => void) => void;
		onEscape?: () => void;
		onPasteImage?: () => void;
	};
	actionEditor.onAction?.("app.message.followUp", () => {
		void callbacks.submit("followUp");
	});
	actionEditor.onAction?.("app.message.dequeue", () => {
		callbacks.restoreQueuedMessagesToEditor();
	});
	actionEditor.onAction?.("app.editor.external", () => {
		void openChatSessionExternalEditor(state);
	});
	actionEditor.onAction?.("app.history.search", () => openChatSessionPromptSearch(state));
	if (state.actions) {
		for (const [action, handler] of Object.entries(state.actions)) {
			actionEditor.onAction?.(action, () => {
				void handler();
			});
		}
	}
	const previousPasteImage = actionEditor.onPasteImage;
	actionEditor.onPasteImage = () => {
		previousPasteImage?.();
		void pasteClipboardImageToEditor(chatSessionEditorAccess(state), () => state.requestRender?.(), {
			showWarning: (message) => notifyChatSessionWarning(state, message),
			isBashMode: state.isBashMode,
		});
	};
	const previousEscape = actionEditor.onEscape;
	actionEditor.onEscape = () => {
		if (state.compacting) {
			void callbacks.abortCompaction();
			return;
		}
		if (isChatSessionStreaming(state)) {
			void callbacks.interrupt({ restoreQueuedMessages: true });
			return;
		}
		if (isChatSessionBashRunning(state)) {
			void callbacks.abortBash();
			return;
		}
		if (state.isBashMode) {
			setChatSessionEditorText(state, "");
			notifyChatSessionStatus(state, "Bash mode cleared");
			return;
		}
		previousEscape?.();
	};
	return editor;
}

export function syncChatSessionPromptSearch<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): boolean {
	if (state.isDisabled?.() === true) {
		state.promptSearch = undefined;
		return false;
	}
	return state.promptSearch !== undefined;
}

function isChatSessionShowingAutocomplete<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): boolean {
	if (state.isDisabled?.() === true) return false;
	const candidate = state.editor as (EditorComponent & { isShowingAutocomplete?: () => boolean }) | undefined;
	return typeof candidate?.isShowingAutocomplete === "function" && candidate.isShowingAutocomplete();
}

export function hasChatSessionTransientModal<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): boolean {
	return syncChatSessionPromptSearch(state) || isChatSessionShowingAutocomplete(state);
}

function isoTimestamp(timestamp: unknown): string | undefined {
	if (typeof timestamp !== "number") return undefined;
	const date = new Date(timestamp);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function promptEntriesForChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): Parameters<typeof sessionPromptsFromEntries>[0] {
	const sessionEntries = state.getAgentSession?.()?.sessionManager.getEntries();
	if (sessionEntries && sessionEntries.length > 0) return sessionEntries;
	const promptEntries = state.getPromptEntries?.();
	if (promptEntries && promptEntries.length > 0) return promptEntries;
	const messages = state.getSessionMessages?.();
	if (messages && messages.length > 0) {
		return messages.map((message) => {
			const timestamp = isoTimestamp("timestamp" in message ? message.timestamp : undefined);
			return {
				type: "message",
				...(timestamp === undefined ? {} : { timestamp }),
				message,
			};
		});
	}
	return state.transcript.flatMap((entry) =>
		isChatMessageEntry(entry) && entry.kind === "user"
			? [{ type: "message", timestamp: entry.timestamp, message: { role: "user", content: entry.text } }]
			: [],
	);
}

export function openChatSessionPromptSearch<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	const editor = state.editor;
	if (!editor || state.isDisabled?.() === true) return;
	const entries = promptHistoryEntries(sessionPromptsFromEntries(promptEntriesForChatSession(state)));
	const close = () => {
		state.promptSearch = undefined;
		state.requestRender?.();
	};
	state.promptSearch = new PromptHistorySelectorComponent(entries, {
		onSelect: (text) => {
			close();
			setChatSessionEditorText(state, text);
		},
		onCancel: close,
	});
	state.requestRender?.();
}

export function handleChatSessionInput<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	data: string,
	callbacks: ChatSessionEditorCallbacks,
): boolean {
	if (syncChatSessionPromptSearch(state)) {
		state.promptSearch!.handleInput(data);
		state.requestRender?.();
		return true;
	}
	if (isChatSessionShowingAutocomplete(state)) {
		state.editor!.handleInput(data);
		state.requestRender?.();
		return true;
	}
	if (state.bodyViewport.handleInput(data)) return true;
	if (matchesKey(data, "escape")) {
		if (state.compacting) {
			void callbacks.abortCompaction();
			return true;
		}
		if (isChatSessionStreaming(state)) {
			void callbacks.interrupt({ restoreQueuedMessages: true });
			return true;
		}
		if (isChatSessionBashRunning(state)) {
			void callbacks.abortBash();
			return true;
		}
		if (state.isBashMode) {
			setChatSessionEditorText(state, "");
			notifyChatSessionStatus(state, "Bash mode cleared");
			return true;
		}
	}
	// The editor runs the follow-up and dequeue keys as its `app.message.*` actions, as the main chat's does.
	if (state.editor) {
		state.editor.handleInput(data);
		return true;
	}
	const keys = getKeybindings();
	if (keys.matches(data, "app.message.dequeue")) {
		callbacks.restoreQueuedMessagesToEditor();
		return true;
	}
	if (keys.matches(data, "app.message.followUp")) {
		void callbacks.submit("followUp");
		return true;
	}
	if (matchesKey(data, "enter")) {
		void callbacks.submit("auto");
		return true;
	}
	if (matchesKey(data, "backspace")) {
		setChatSessionEditorText(state, state.inputBuffer.slice(0, -1));
		return true;
	}
	if (data.length === 1 && data >= " " && data <= "~") {
		setChatSessionEditorText(state, `${state.inputBuffer}${data}`);
		return true;
	}
	return false;
}

/** Up recalls a submission: the editor's history, and the chat's own record of it, which outlives the editor. */
export function recordChatSessionPrompt<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
): void {
	state.editor?.addToHistory?.(text);
	const trimmed = text.trim();
	if (!trimmed || state.sentPrompts.at(-1) === trimmed) return;
	state.sentPrompts = [...state.sentPrompts, trimmed].slice(-PROMPT_HISTORY_LIMIT);
}

/** As many submissions as the editor's own history keeps. */
const PROMPT_HISTORY_LIMIT = 100;

export function setChatSessionEditorText<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
): void {
	state.inputBuffer = text;
	state.isBashMode = text.trimStart().startsWith("!");
	state.editor?.setText(text);
}

export function setEditorPlaceholder(editor: EditorComponent, placeholder: string | undefined): void {
	const candidate = editor as EditorComponent & {
		setPlaceholder?: (value: string | undefined) => void;
	};
	candidate.setPlaceholder?.(placeholder);
}

export function setEditorBorderColor(editor: EditorComponent, borderColor: (text: string) => string): void {
	const candidate = editor as EditorComponent & {
		borderColor?: (text: string) => string;
	};
	if (candidate.borderColor !== undefined) candidate.borderColor = borderColor;
}

export function setEditorFocused(editor: EditorComponent, focused: boolean): void {
	const candidate = editor as EditorComponent & Partial<Focusable>;
	if ("focused" in candidate) candidate.focused = focused;
}

function createInheritedEditor<TExtraEntry extends ChatTranscriptEntryLike>(
	tui: TUI,
	editorTheme: EditorTheme,
	keybindings: unknown,
	editorFactory: ChatSessionHostOpts<TExtraEntry>["editorFactory"],
): EditorComponent | undefined {
	if (!editorFactory) return undefined;
	try {
		return editorFactory(tui, editorTheme, keybindings);
	} catch {
		return undefined;
	}
}

type EditorCursor = { line: number; col: number };
type CursorAwareEditor = EditorComponent & { getCursor(): EditorCursor };

function hasCursor(editor: EditorComponent | undefined): editor is CursorAwareEditor {
	return typeof (editor as Partial<CursorAwareEditor> | undefined)?.getCursor === "function";
}

export function chatSessionEditorAccess<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): {
	insertTextAtCursor: (text: string) => void;
	getText: () => string;
	setText: (text: string) => void;
	getCursor?: () => EditorCursor;
} {
	const editor = state.editor;
	return {
		insertTextAtCursor: (text: string) => {
			if (state.editor?.insertTextAtCursor) {
				state.editor.insertTextAtCursor(text);
				return;
			}
			setChatSessionEditorText(state, `${state.inputBuffer}${text}`);
		},
		getText: () => state.inputBuffer,
		setText: (text: string) => setChatSessionEditorText(state, text),
		...(hasCursor(editor) ? { getCursor: () => editor.getCursor() } : {}),
	};
}

async function openChatSessionExternalEditor<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): Promise<void> {
	if (!state.editor) return;
	const host = state.tui;
	if (!host) return;
	const currentText = state.editor.getExpandedText?.() ?? state.editor.getText();
	const updated = await openExternalEditorForText(currentText, host, {
		showWarning: (message) => notifyChatSessionWarning(state, message),
		showStatus: (message) => notifyChatSessionStatus(state, message),
	});
	if (updated !== undefined) setChatSessionEditorText(state, updated);
}
