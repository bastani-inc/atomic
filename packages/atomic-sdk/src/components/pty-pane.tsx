/** @jsxImportSource @opentui/react */
/**
 * PtyPane — renders a stage's PTY scrollback and forwards focused keystrokes
 * to the daemon via `pane/sendInput`.
 *
 * Important: the legacy PtyPane is a scrollback/log view, not a terminal
 * emulator. DirectPtyPane is used for interactive workflow stage attachment:
 * it switches OpenTUI into split-footer mode and streams PTY bytes to the real
 * terminal so native full-screen agent TUIs interpret ANSI themselves.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type { PaneOutputNotificationParams } from "../runtime/ui-protocol/schemas.ts";
import { useLatest } from "./hooks.ts";
import {
  TERMINAL_MOUSE_REPORTING_DISABLE_SEQUENCE,
  TerminalMouseReportingTracker,
  isTerminalMouseInputSequence,
} from "./terminal-mouse.ts";

// ---------------------------------------------------------------------------
// Pure helpers (extracted for unit-testing)
// ---------------------------------------------------------------------------

/**
 * Append newly-arrived PTY output to the existing scrollback buffer.
 *
 * Returns the merged string. If `offset` is less than `headOffset`, the
 * incoming data overlaps already-seen output so only the new tail is
 * appended. If `offset` equals `headOffset`, the data is concatenated in
 * full. If `offset` is greater, a gap marker is inserted to signal that
 * bytes were missed (e.g. during reconnect).
 */
export function appendScrollback(
  existing: string,
  headOffset: number,
  incoming: string,
  offset: number,
): { content: string; headOffset: number } {
  if (incoming.length === 0) {
    return { content: existing, headOffset };
  }

  const incomingEnd = offset + incoming.length;

  if (incomingEnd <= headOffset) {
    return { content: existing, headOffset };
  }

  if (offset < headOffset) {
    const tail = incoming.slice(headOffset - offset);
    return { content: existing + tail, headOffset: headOffset + tail.length };
  }

  if (offset > headOffset) {
    const gap = `\r\n[…${offset - headOffset} bytes missing…]\r\n`;
    return {
      content: existing + gap + incoming,
      headOffset: incomingEnd,
    };
  }

  return { content: existing + incoming, headOffset: incomingEnd };
}

export const PANE_FOOTER_ROWS = 1;

export interface PaneKeyLike {
  name: string;
  ctrl: boolean;
  sequence?: string;
  raw?: string;
}

export function panePtyRows(terminalRows: number | undefined, footerRows = PANE_FOOTER_ROWS): number {
  return Math.max(1, Math.floor((terminalRows ?? 40) - footerRows));
}

export interface PaneTerminalDimensions {
  width: number;
  height: number;
  terminalWidth: number;
  terminalHeight: number;
}

export function getPaneTerminalSize(dimensions: PaneTerminalDimensions): { cols: number; rows: number } {
  // In split-footer mode, renderer.height is only the footer render surface.
  // The attached PTY must be sized from the physical terminal so native TUIs
  // redraw into the full space above Atomic's footer instead of a 1-row pane.
  const physicalWidth = dimensions.terminalWidth > 0 ? dimensions.terminalWidth : dimensions.width;
  const physicalHeight = dimensions.terminalHeight > 0 ? dimensions.terminalHeight : dimensions.height;
  return {
    cols: Math.max(1, Math.floor(physicalWidth)),
    rows: panePtyRows(physicalHeight),
  };
}

function usePaneTerminalSize(renderer: CliRenderer): { cols: number; rows: number } {
  const readSize = () => getPaneTerminalSize({
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

/** True when a key belongs to the workflow panel shell and must not be forwarded to the PTY. */
export function isPanelKey(key: PaneKeyLike): boolean {
  return key.name === "q" || (key.ctrl && (key.name === "c" || key.name === "g"));
}

function ctrlLetterInput(name: string): string | null {
  if (!/^[a-z]$/i.test(name)) return null;
  return String.fromCharCode(name.toLowerCase().charCodeAt(0) - 96);
}

export function sliceNewPaneOutput(
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

export function paneKeyToPtyInput(key: PaneKeyLike): string {
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

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface PtyPaneProps {
  runId: string;
  stageName: string;
  /** When true, keystrokes are forwarded to the daemon via pane/sendInput. */
  focused: boolean;
  connection: MessageConnection;
  /** Width of the pane. Defaults to "100%". */
  width?: number | "auto" | `${number}%`;
  /** Height of the pane. Defaults to "100%". */
  height?: number | "auto" | `${number}%`;
}


/**
 * Direct interactive stage pane.
 *
 * Unlike PtyPane, this component does not render PTY bytes into a React <text>
 * node. It lets the user's real terminal interpret the agent TUI's ANSI
 * control stream, while OpenTUI renders only a pinned footer in split-footer
 * mode. This mirrors the direct chat attach path and avoids garbled escape
 * sequences in full-screen Copilot/OpenCode workflow stages.
 */
export interface DirectPtyPaneProps extends PtyPaneProps {
  onQuit: () => void;
  onDetach: () => void;
  onReturnToGraph: () => void;
}

export function DirectPtyPane({
  runId,
  stageName,
  focused,
  connection,
  onQuit,
  onDetach,
  onReturnToGraph,
}: DirectPtyPaneProps) {
  const renderer = useRenderer();
  const ptySize = usePaneTerminalSize(renderer);
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
      const next = sliceNewPaneOutput(headOffset, data, offset);
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
        if (params.runId !== runId || params.stageName !== stageName) return;

        if (!snapshotLoaded) {
          pendingLiveOutput.push(params);
          return;
        }

        writeOutputAtOffset(params.data, params.offset);
      },
    );

    (async () => {
      // Subscribe first, then fetch scrollback. This prevents losing the
      // initial full-screen repaint if the agent writes between the fetch and
      // subscription calls.
      try {
        const sub = (await connection.sendRequest("pane/subscribeOutput", {
          runId,
          stageName,
        })) as { subscriptionId: string };

        if (disposed) {
          await connection
            .sendRequest("pane/unsubscribeOutput", { subscriptionId: sub.subscriptionId })
            .catch(() => {});
        } else {
          outputSubscriptionId = sub.subscriptionId;
        }
      } catch {
        // If subscription fails, fall back to a one-time scrollback repaint.
      }

      try {
        const scrollback = (await connection.sendRequest("pane/getScrollback", {
          runId,
          stageName,
        })) as { data: string; headOffset: number };
        if (!disposed) {
          write(scrollback.data);
          headOffset = scrollback.headOffset;
        }
      } catch {
        // Non-fatal — the pane may not exist yet or scrollback unavailable.
      }

      snapshotLoaded = true;
      flushPendingLiveOutput();
    })();

    return () => {
      disposed = true;
      mouseTracker.reset();
      mouseReportingEnabledRef.current = false;
      process.stdout.write(TERMINAL_MOUSE_REPORTING_DISABLE_SEQUENCE);
      outputDisposable.dispose();
      if (outputSubscriptionId) {
        connection
          .sendRequest("pane/unsubscribeOutput", { subscriptionId: outputSubscriptionId })
          .catch(() => {});
      }
    };
  }, [connection, renderer, runId, stageName]);

  useEffect(() => {
    connection
      .sendRequest("pane/resize", {
        runId,
        stageName,
        cols: ptySize.cols,
        rows: ptySize.rows,
      })
      .catch(() => {});
  }, [connection, runId, stageName, ptySize.cols, ptySize.rows]);

  const focusedRef = useLatest(focused);

  useEffect(() => {
    const forwardMouseInput = (sequence: string): boolean => {
      if (!isTerminalMouseInputSequence(sequence)) return false;

      if (focusedRef.current && mouseReportingEnabledRef.current) {
        connection
          .sendRequest("pane/sendInput", { runId, stageName, data: sequence })
          .catch(() => {});
      }

      return true;
    };

    renderer.addInputHandler(forwardMouseInput);
    return () => {
      renderer.removeInputHandler(forwardMouseInput);
    };
  }, [connection, focusedRef, renderer, runId, stageName]);

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      key.preventDefault?.();
      key.stopPropagation?.();
      onQuit();
      return;
    }

    if (key.ctrl && key.name === "d") {
      key.preventDefault?.();
      key.stopPropagation?.();
      onDetach();
      return;
    }

    if (key.ctrl && key.name === "g") {
      key.preventDefault?.();
      key.stopPropagation?.();
      onReturnToGraph();
      return;
    }

    if (isPanelKey(key)) return;
    if (!focusedRef.current) return;

    const data = paneKeyToPtyInput(key);
    if (data.length === 0) return;

    key.preventDefault?.();
    key.stopPropagation?.();

    connection
      .sendRequest("pane/sendInput", { runId, stageName, data })
      .catch(() => {});
  });

  return null;
}

/**
 * Renders a stage's PTY scrollback and optionally forwards keystrokes.
 *
 * - On mount: fetches the initial scrollback via `pane/getScrollback`.
 * - Live updates: subscribes via `pane/subscribeOutput` and appends data.
 * - When `focused`: forwards non-quit keystrokes via `pane/sendInput`.
 * - Scrolls to the bottom on new data unless the user has scrolled up.
 */
export function PtyPane({
  runId,
  stageName,
  focused,
  connection,
  width = "100%",
  height = "100%",
}: PtyPaneProps) {
  const [scrollback, setScrollback] = useState<string>("");
  const [headOffset, setHeadOffset] = useState<number>(0);
  const [userScrolled, setUserScrolled] = useState<boolean>(false);

  const scrollbackRef = useLatest(scrollback);
  const headOffsetRef = useLatest(headOffset);
  const userScrolledRef = useLatest(userScrolled);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // ── Fetch initial scrollback + register notification handler ─────────────
  useEffect(() => {
    let disposed = false;
    let outputSubscriptionId: string | null = null;

    (async () => {
      try {
        const result = (await connection.sendRequest("pane/getScrollback", {
          runId,
          stageName,
        })) as { data: string; headOffset: number };

        if (!disposed) {
          setScrollback(result.data);
          setHeadOffset(result.headOffset);
          const sb = scrollboxRef.current;
          if (sb) sb.scrollTo(Number.MAX_SAFE_INTEGER);
        }
      } catch {
        // Non-fatal — pane may not exist yet or scrollback unavailable.
      }

      try {
        const sub = (await connection.sendRequest("pane/subscribeOutput", {
          runId,
          stageName,
        })) as { subscriptionId: string };
        if (disposed) {
          await connection
            .sendRequest("pane/unsubscribeOutput", { subscriptionId: sub.subscriptionId })
            .catch(() => {});
        } else {
          outputSubscriptionId = sub.subscriptionId;
        }
      } catch {
        // Older daemon / tests may not provide output subscription support.
      }
    })();

    const disposable = connection.onNotification(
      "pane/output",
      (params: PaneOutputNotificationParams) => {
        if (params.runId !== runId || params.stageName !== stageName) return;

        const merged = appendScrollback(
          scrollbackRef.current,
          headOffsetRef.current,
          params.data,
          params.offset,
        );

        setScrollback(merged.content);
        setHeadOffset(merged.headOffset);

        if (!userScrolledRef.current) {
          const sb = scrollboxRef.current;
          if (sb) sb.scrollTo(Number.MAX_SAFE_INTEGER);
        }
      },
    );

    return () => {
      disposed = true;
      disposable.dispose();
      if (outputSubscriptionId) {
        connection
          .sendRequest("pane/unsubscribeOutput", { subscriptionId: outputSubscriptionId })
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, stageName, connection]);

  // ── Keyboard forwarding ──────────────────────────────────────────────────
  const focusedRef = useLatest(focused);

  const handleScroll = useCallback((delta: number) => {
    const sb = scrollboxRef.current;
    if (!sb) return;
    const next = Math.max(0, sb.scrollTop + delta);
    setUserScrolled(next > 0);
    sb.scrollTo(next);
  }, []);

  useKeyboard((key) => {
    if (isPanelKey(key)) return;
    if (!focusedRef.current) return;

    if (key.name === "up") {
      handleScroll(-1);
      return;
    }
    if (key.name === "down") {
      handleScroll(1);
      return;
    }
    if (key.name === "pageup") {
      handleScroll(-10);
      return;
    }
    if (key.name === "pagedown") {
      handleScroll(10);
      return;
    }

    const data = paneKeyToPtyInput(key);
    if (data.length === 0) return;

    connection
      .sendRequest("pane/sendInput", { runId, stageName, data })
      .catch(() => {});
  });

  return (
    <scrollbox
      ref={scrollboxRef}
      scrollY
      width={width}
      height={height}
    >
      <text>{scrollback}</text>
    </scrollbox>
  );
}
