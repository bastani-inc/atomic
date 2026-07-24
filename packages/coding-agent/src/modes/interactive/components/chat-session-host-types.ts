import type { AgentSession } from "../../../core/agent-session.ts";
import type { BashResult } from "../../../core/bash-executor.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type {
  Component,
  EditorComponent,
  EditorTheme,
  MarkdownTheme,
  TUI,
} from "@earendil-works/pi-tui";
import type {
  ChatMessageEntry,
  ChatMessageRenderOptions,
} from "./chat-message-renderer.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";

export interface ChatSessionHostStyle {
  dim(text: string): string;
  text(text: string): string;
  textMuted(text: string): string;
  accent(text: string): string;
  accentBold(text: string): string;
  workingIndicatorPalette?: () => {
    dark: string;
    lift: string;
    muted: string;
    accent: string;
    bright: string;
    peak: string;
  };
  /** Use Atomic's live global theme when the host shares the interactive theme proxy. */
  workingIndicatorUseGlobalTheme?: boolean;
  rule(hex: string, text: string): string;
  cursor(): string;
  blank(width: number): string;
  editorRuleColor(
    disabled: boolean,
    agentSession: AgentSession | undefined,
    state?: { isBashMode: boolean },
  ): string;
}

export interface ChatSessionHostBashRequest {
  command: string;
  excludeFromContext: boolean;
  onChunk: (chunk: string) => void;
}

export interface ChatSessionHostCommands {
  ensureAttached?: () => Promise<void>;
  prompt?: (text: string) => Promise<void>;
  steer?: (text: string) => Promise<void>;
  followUp?: (text: string) => Promise<void>;
  interrupt?: () => Promise<void>;
  resume?: (message?: string) => Promise<void>;
  runBash?: (request: ChatSessionHostBashRequest) => Promise<BashResult>;
  abortBash?: () => void | Promise<void>;
  abortCompaction?: () => void | Promise<void>;
  handleSlashCommand?: (text: string) => Promise<boolean> | boolean;
}

export interface ChatSessionHostOpts<
  TExtraEntry extends ChatTranscriptEntryLike = never,
> {
  style: ChatSessionHostStyle;
  commands?: ChatSessionHostCommands;
  requestRender?: () => void;
  getAgentSession?: () => AgentSession | undefined;
  isStreaming?: () => boolean;
  isPaused?: () => boolean;
  isDisabled?: () => boolean;
  isBashRunning?: () => boolean;
  showWarning?: (message: string) => void;
  showStatus?: (message: string) => void;
  actions?: Record<string, () => void | Promise<void>>;
  getActionKeyDisplay?: (action: string) => string;
  getMarkdownTheme?: () => MarkdownTheme;
  tui?: TUI;
  keybindings?: unknown;
  editorFactory?: (
    tui: TUI,
    theme: EditorTheme,
    keybindings: unknown,
  ) => EditorComponent;
  editorTheme: EditorTheme;
  getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>
    | undefined;
  getCwd?: () => string;
  footerData?: ReadonlyFooterDataProvider;
  renderExtraEntry?: (entry: TExtraEntry) => Component;
}

export type ChatSessionHostEntry<
  TExtraEntry extends ChatTranscriptEntryLike = never,
> = ChatMessageEntry | TExtraEntry;

export type AgentSnapshotMessage = AgentSession["messages"][number];
export type CacheKeyPart = string | number | boolean | null;
