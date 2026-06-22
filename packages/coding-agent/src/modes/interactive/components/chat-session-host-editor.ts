import {
  type EditorComponent,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  openExternalEditorForText,
  pasteClipboardImageToEditor,
} from "../chat-input-actions.ts";
import { CustomEditor } from "./custom-editor.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatSessionHostOpts } from "./chat-session-host-types.ts";
import {
  isChatSessionBashRunning,
  isChatSessionStreaming,
  notifyChatSessionStatus,
  notifyChatSessionWarning,
} from "./chat-session-host-runtime.ts";
import { matchesKey } from "./chat-session-host-utils.ts";

export interface ChatSessionEditorCallbacks {
  submit: (mode: "auto" | "followUp", submittedText?: string) => void | Promise<void>;
  restoreQueuedMessagesToEditor: () => boolean;
  abortCompaction: () => void | Promise<void>;
  interrupt: () => void | Promise<void>;
  abortBash: () => void | Promise<void>;
}

export function createChatSessionEditor<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  tui: TUI | undefined,
  keybindings: unknown,
  editorTheme: EditorTheme,
  editorFactory: ChatSessionHostOpts<TExtraEntry>["editorFactory"],
  callbacks: ChatSessionEditorCallbacks,
): EditorComponent | undefined {
  if (!tui || !keybindings) return undefined;
  const editor = createInheritedEditor(tui, editorTheme, keybindings, editorFactory) ??
    new CustomEditor(
      tui,
      editorTheme,
      keybindings as ConstructorParameters<typeof CustomEditor>[2],
      { paddingX: 0, autocompleteMaxVisible: 5 },
    );
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
    openChatSessionExternalEditor(state);
  });
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
    void pasteClipboardImageToEditor(
      chatSessionEditorAccess(state),
      () => state.requestRender?.(),
      { showWarning: (message) => notifyChatSessionWarning(state, message) },
    );
  };
  const previousEscape = actionEditor.onEscape;
  actionEditor.onEscape = () => {
    if (state.compacting) {
      void callbacks.abortCompaction();
      return;
    }
    if (isChatSessionStreaming(state)) {
      void callbacks.interrupt();
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

export function handleChatSessionInput<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  data: string,
  callbacks: ChatSessionEditorCallbacks,
): boolean {
  if (state.bodyViewport.handleInput(data)) return true;
  if (matchesKey(data, "alt+up")) {
    callbacks.restoreQueuedMessagesToEditor();
    return true;
  }
  if (matchesKey(data, "ctrl+f")) {
    void callbacks.submit("followUp");
    return true;
  }
  if (matchesKey(data, "escape")) {
    if (state.compacting) {
      void callbacks.abortCompaction();
      return true;
    }
    if (isChatSessionStreaming(state)) {
      void callbacks.interrupt();
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
  if (state.editor) {
    state.editor.handleInput(data);
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

export function setChatSessionEditorText<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>, text: string): void {
  state.inputBuffer = text;
  state.isBashMode = text.trimStart().startsWith("!");
  state.editor?.setText(text);
}

export function setEditorPlaceholder(
  editor: EditorComponent,
  placeholder: string | undefined,
): void {
  const candidate = editor as EditorComponent & {
    setPlaceholder?: (value: string | undefined) => void;
  };
  candidate.setPlaceholder?.(placeholder);
}

export function setEditorBorderColor(
  editor: EditorComponent,
  borderColor: (text: string) => string,
): void {
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

function chatSessionEditorAccess<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): {
  insertTextAtCursor: (text: string) => void;
  getText: () => string;
  setText: (text: string) => void;
} {
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
  };
}

function openChatSessionExternalEditor<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): void {
  if (!state.editor) return;
  const host = state.tui;
  if (!host) return;
  const currentText = state.editor.getExpandedText?.() ?? state.editor.getText();
  const updated = openExternalEditorForText(currentText, host, {
    showWarning: (message) => notifyChatSessionWarning(state, message),
  });
  if (updated !== undefined) setChatSessionEditorText(state, updated);
}
