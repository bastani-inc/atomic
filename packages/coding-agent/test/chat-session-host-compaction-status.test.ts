import { describe, expect, it } from "vitest";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { renderChatSessionWorkingStatus } from "../src/modes/interactive/components/chat-session-host-rendering.ts";
import { ChatSessionHostState } from "../src/modes/interactive/components/chat-session-host-state.ts";
import type {
  ChatSessionHostOpts,
  ChatSessionHostStyle,
} from "../src/modes/interactive/components/chat-session-host-types.ts";
import { Text, type Component } from "@earendil-works/pi-tui";

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

function makeState(
  overrides: Partial<ChatSessionHostOpts> = {},
): ChatSessionHostState {
  const opts: ChatSessionHostOpts = {
    style,
    editorTheme,
    isStreaming: () => true,
    ...overrides,
  };
  return new ChatSessionHostState(opts, {
    renderEntry: (): Component => new Text("", 0, 0),
    transcriptCacheKey: () => "",
  });
}

describe("chat session compaction status", () => {
  it("renders Atomic's ∀ indicator with an escape cancel hint", () => {
    const state = makeState();
    state.compacting = true;
    state.statusMessage = "Auto-compacting...";

    const rendered = renderChatSessionWorkingStatus(state, 80).join("\n");

    expect(rendered).toContain("∀");
    expect(rendered).toContain("Auto-compacting... (esc Cancel)");
  });

  it("uses the host keybinding display for the cancel hint", () => {
    const state = makeState({ getActionKeyDisplay: () => "ctrl+c" });
    state.compacting = true;

    const rendered = renderChatSessionWorkingStatus(state, 80).join("\n");

    expect(rendered).toContain("Compacting context... (ctrl+c Cancel)");
  });
});
