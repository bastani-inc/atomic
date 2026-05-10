/** @jsxImportSource @opentui/react */
/**
 * ChatSessionPanel — tmux-free direct chat attach UI.
 *
 * The daemon owns the agent process via bun-pty. This component does not try
 * to emulate a terminal in React. Instead it streams PTY bytes straight to the
 * user's real terminal so Claude/Copilot/OpenCode can render their native TUI,
 * while OpenTUI's split-footer mode pins Atomic's divider + footer underneath.
 */

import { memo, useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { CliRenderer } from "@opentui/core";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type { AgentType } from "../types.ts";
import type {
  PaneExitNotificationParams,
  PaneOutputNotificationParams,
} from "../runtime/ui-protocol/schemas.ts";
import { useGraphTheme } from "./orchestrator-panel-contexts.ts";
import {
  TERMINAL_MOUSE_REPORTING_DISABLE_SEQUENCE,
  TerminalMouseReportingTracker,
  isTerminalMouseInputSequence,
} from "./terminal-mouse.ts";

export const CHAT_FOOTER_ROWS = 2;
const CHAT_STAGE_NAME = "chat";
const DOT = "\u00B7";

export interface ChatSessionPanelProps {
  runId: string;
  agentType: AgentType;
  connection: MessageConnection;
  onDetach: () => void;
}

export function chatPtyRows(terminalRows: number | undefined, footerRows = CHAT_FOOTER_ROWS): number {
  return Math.max(1, Math.floor((terminalRows ?? 40) - footerRows));
}

export interface ChatTerminalDimensions {
  width: number;
  height: number;
  terminalWidth: number;
  terminalHeight: number;
}

export function getChatTerminalSize(dimensions: ChatTerminalDimensions): { cols: number; rows: number } {
  // In split-footer mode, renderer.height is only the footer render surface.
  // The agent PTY must be sized from the physical terminal or full-screen TUIs
  // redraw into a 1-row PTY and appear as an empty canvas above the footer.
  const physicalWidth = dimensions.terminalWidth > 0 ? dimensions.terminalWidth : dimensions.width;
  const physicalHeight = dimensions.terminalHeight > 0 ? dimensions.terminalHeight : dimensions.height;
  return {
    cols: Math.max(1, Math.floor(physicalWidth)),
    rows: chatPtyRows(physicalHeight),
  };
}

export function sliceNewPtyOutput(
  headOffset: number,
  data: string,
  offset: number,
): { data: string; headOffset: number } {
  if (data.length === 0) return { data: "", headOffset };

  const incomingEnd = offset + data.length;
  if (incomingEnd <= headOffset) return { data: "", headOffset };

  if (offset < headOffset) {
    return {
      data: data.slice(headOffset - offset),
      headOffset: incomingEnd,
    };
  }

  return { data, headOffset: incomingEnd };
}

function useChatTerminalSize(renderer: CliRenderer): { cols: number; rows: number } {
  const readSize = () => getChatTerminalSize({
    width: renderer.width,
    height: renderer.height,
    terminalWidth: renderer.terminalWidth,
    terminalHeight: renderer.terminalHeight,
  });
  const [size, setSize] = useState(readSize);

  useEffect(() => {
    const onResize = () => setSize(readSize());
    renderer.on("resize", onResize);
    onResize();
    return () => {
      renderer.off("resize", onResize);
    };
  }, [renderer]);

  return size;
}

/** Shell-level keys handled by Atomic, not forwarded to the agent PTY. */
export interface ChatKeyLike {
  name: string;
  ctrl: boolean;
  sequence?: string;
  raw?: string;
}

export function isChatDetachKey(key: { name: string; ctrl: boolean }): boolean {
  return key.ctrl && key.name === "d";
}

function ctrlLetterInput(name: string): string | null {
  if (!/^[a-z]$/i.test(name)) return null;
  return String.fromCharCode(name.toLowerCase().charCodeAt(0) - 96);
}

export function chatKeyToPtyInput(key: ChatKeyLike): string {
  if (key.ctrl) {
    const ctrlLetter = ctrlLetterInput(key.name);
    if (ctrlLetter !== null) return ctrlLetter;
    if (key.name === "space") return "\x00";
    if (key.name === "[" || key.name === "escape") return "\x1b";
    if (key.name === "\\") return "\x1c";
    if (key.name === "]") return "\x1d";
    if (key.name === "^") return "\x1e";
    if (key.name === "_") return "\x1f";
  }

  switch (key.name) {
    case "escape":
      return "\x1b";
    case "return":
    case "enter":
      return "\r";
    case "linefeed":
      return "\n";
    case "tab":
      return "\t";
    case "backspace":
      return "\x7f";
    case "delete":
      return "\x1b[3~";
    case "up":
      return "\x1b[A";
    case "down":
      return "\x1b[B";
    case "right":
      return "\x1b[C";
    case "left":
      return "\x1b[D";
    default:
      return key.sequence ?? key.raw ?? "";
  }
}

export function isTerminalRunStatus(status: string | undefined): boolean {
  return status !== undefined && status !== "active";
}

export function ChatSessionPanel({
  runId,
  agentType,
  connection,
  onDetach,
}: ChatSessionPanelProps) {
  const renderer = useRenderer();
  const ptySize = useChatTerminalSize(renderer);
  const mouseReportingEnabledRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let outputSubscriptionId: string | null = null;
    let snapshotLoaded = false;
    let headOffset = 0;
    const pendingLiveOutput: PaneOutputNotificationParams[] = [];
    const mouseTracker = new TerminalMouseReportingTracker();
    mouseReportingEnabledRef.current = false;

    const write = (data: string) => {
      if (!disposed && data.length > 0) {
        mouseReportingEnabledRef.current = mouseTracker.update(data);
        process.stdout.write(data);
        renderer.requestRender();
      }
    };

    const writeOutputAtOffset = (data: string, offset: number) => {
      const next = sliceNewPtyOutput(headOffset, data, offset);
      headOffset = next.headOffset;
      write(next.data);
    };

    const flushPendingLiveOutput = () => {
      pendingLiveOutput.sort((a, b) => a.offset - b.offset);
      for (const params of pendingLiveOutput) {
        writeOutputAtOffset(params.data, params.offset);
      }
      pendingLiveOutput.length = 0;
    };

    const outputDisposable = connection.onNotification(
      "pane/output",
      (params: PaneOutputNotificationParams) => {
        if (params.runId !== runId || params.stageName !== CHAT_STAGE_NAME) return;

        if (!snapshotLoaded) {
          pendingLiveOutput.push(params);
          return;
        }

        writeOutputAtOffset(params.data, params.offset);
      },
    );

    const exitDisposable = connection.onNotification(
      "pane/exit",
      (params: PaneExitNotificationParams) => {
        if (params.runId === runId && params.stageName === CHAT_STAGE_NAME) {
          onDetach();
        }
      },
    );

    (async () => {
      // Subscribe first, then fetch scrollback. This avoids the footer-only
      // race where the agent paints its initial full-screen TUI after our
      // scrollback fetch but before live output subscription is active.
      try {
        const sub = (await connection.sendRequest("pane/subscribeOutput", {
          runId,
          stageName: CHAT_STAGE_NAME,
        })) as { subscriptionId: string };

        if (disposed) {
          await connection
            .sendRequest("pane/unsubscribeOutput", { subscriptionId: sub.subscriptionId })
            .catch(() => {});
        } else {
          outputSubscriptionId = sub.subscriptionId;
        }
      } catch {
        // If subscription fails, the panel falls back to a one-time scrollback
        // repaint. The footer still provides a detach path.
      }

      try {
        const scrollback = (await connection.sendRequest("pane/getScrollback", {
          runId,
          stageName: CHAT_STAGE_NAME,
        })) as { data: string; headOffset: number };
        if (!disposed) {
          write(scrollback.data);
          headOffset = scrollback.headOffset;
        }
      } catch {
        // Non-fatal — the pane may still be starting.
      }

      snapshotLoaded = true;
      flushPendingLiveOutput();

      try {
        const run = (await connection.sendRequest("run/get", { runId })) as { status?: string } | null;
        if (!disposed && isTerminalRunStatus(run?.status)) {
          onDetach();
        }
      } catch {
        // Non-fatal — live pane/exit notification remains authoritative.
      }
    })();

    return () => {
      disposed = true;
      mouseTracker.reset();
      mouseReportingEnabledRef.current = false;
      process.stdout.write(TERMINAL_MOUSE_REPORTING_DISABLE_SEQUENCE);
      outputDisposable.dispose();
      exitDisposable.dispose();
      if (outputSubscriptionId) {
        connection
          .sendRequest("pane/unsubscribeOutput", { subscriptionId: outputSubscriptionId })
          .catch(() => {});
      }
    };
  }, [connection, onDetach, renderer, runId]);

  useEffect(() => {
    connection
      .sendRequest("pane/resize", {
        runId,
        stageName: CHAT_STAGE_NAME,
        cols: ptySize.cols,
        rows: ptySize.rows,
      })
      .catch(() => {});
  }, [connection, runId, ptySize.cols, ptySize.rows]);

  useEffect(() => {
    const forwardSigint = () => {
      connection
        .sendRequest("pane/sendInput", {
          runId,
          stageName: CHAT_STAGE_NAME,
          data: "\x03",
        })
        .catch(() => {});
    };
    process.on("SIGINT", forwardSigint);
    return () => {
      process.off("SIGINT", forwardSigint);
    };
  }, [connection, runId]);

  useEffect(() => {
    const forwardMouseInput = (sequence: string): boolean => {
      if (!isTerminalMouseInputSequence(sequence)) return false;

      if (mouseReportingEnabledRef.current) {
        connection
          .sendRequest("pane/sendInput", {
            runId,
            stageName: CHAT_STAGE_NAME,
            data: sequence,
          })
          .catch(() => {});
      }

      return true;
    };

    renderer.addInputHandler(forwardMouseInput);
    return () => {
      renderer.removeInputHandler(forwardMouseInput);
    };
  }, [connection, renderer, runId]);

  useKeyboard((key) => {
    if (isChatDetachKey(key)) {
      key.preventDefault?.();
      key.stopPropagation?.();
      onDetach();
      return;
    }

    const data = chatKeyToPtyInput(key);
    if (data.length === 0) return;

    key.preventDefault?.();
    key.stopPropagation?.();

    connection
      .sendRequest("pane/sendInput", {
        runId,
        stageName: CHAT_STAGE_NAME,
        data,
      })
      .catch(() => {});
  });

  return <ChatFooter agentType={agentType} runId={runId} />;
}

/** Divider + footer matching the old chat layout. */
export const ChatFooter = memo(function ChatFooter({
  agentType,
  runId,
}: {
  agentType: AgentType;
  runId: string;
}) {
  const theme = useGraphTheme();
  const { width } = useTerminalDimensions();
  const pillBg = agentType === "claude"
    ? theme.warning
    : agentType === "copilot"
      ? theme.success
      : theme.mauve;

  return (
    <box height={CHAT_FOOTER_ROWS} flexDirection="column" backgroundColor={theme.backgroundElement}>
      <box height={1} backgroundColor={theme.background}>
        <text>
          <span fg={theme.border} bg={theme.background}>{"─".repeat(Math.max(1, width))}</span>
        </text>
      </box>

      <box height={1} flexDirection="row" backgroundColor={theme.backgroundElement}>
        <box backgroundColor={pillBg} paddingLeft={1} paddingRight={1} alignItems="center">
          <text>
            <span fg={theme.backgroundElement} bg={pillBg}>
              <strong>{agentType.toUpperCase()}</strong>
            </span>
          </text>
        </box>

        <box flexGrow={1} />

        <box paddingRight={2} alignItems="center">
          <text>
            <span fg={theme.textMuted} bg={theme.backgroundElement}>{runId}</span>
            <span fg={theme.textDim} bg={theme.backgroundElement}>{` ${DOT} `}</span>
            <span fg={theme.text} bg={theme.backgroundElement}>Ctrl+D</span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}> detach</span>
          </text>
        </box>
      </box>
    </box>
  );
});
