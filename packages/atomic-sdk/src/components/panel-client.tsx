/** @jsxImportSource @opentui/react */
/**
 * PanelClient — daemon-protocol panel client.
 *
 * Connects to daemon, subscribes to panel/update notifications,
 * mounts the OpenTUI session graph tree, and blocks until the user
 * presses the panel detach shortcut to detach.
 *
 * §5.4, §5.5 of specs/2026-05-09-ui-server-bun-native.md
 */

import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { closeDaemonConnection, connectToDaemon } from "../runtime/daemon.ts";
import { resolveTheme } from "../runtime/theme.ts";
import { deriveGraphTheme } from "./graph-theme.ts";
import type { GraphTheme } from "./graph-theme.ts";
import { PanelStore } from "./orchestrator-panel-store.ts";
import {
  StoreContext,
  ThemeContext,
} from "./orchestrator-panel-contexts.ts";
import { SessionGraphPanel } from "./session-graph-panel.tsx";
import { CHAT_FOOTER_ROWS, ChatSessionPanel } from "./chat-session-panel.tsx";
import { DirectPtyPane, PANE_FOOTER_ROWS } from "./pty-pane.tsx";
import { PanelFooter, panelFooterToneFromStatus } from "./panel-footer.tsx";
import { ErrorBoundary } from "./error-boundary.tsx";
import {
  requestRendererBackgroundRepaint,
  resetRendererTerminalBackground,
  setRendererBackground,
} from "./renderer-background.ts";
import type {
  WorkflowStatusSnapshot as OpaqueSnapshot,
  PanelUpdateNotificationParams,
  PanelForegroundChangeNotificationParams,
} from "../runtime/ui-protocol/schemas.ts";
import type { WorkflowStatusSnapshot } from "../runtime/status-writer.ts";
import type { SessionData, SessionStatus } from "./orchestrator-panel-types.ts";
import type { AgentType } from "../types.ts";

// ---------------------------------------------------------------------------
// DaemonPanelStore — extends PanelStore with snapshot-driven updates
// ---------------------------------------------------------------------------

/**
 * PanelStore subclass that accepts a full `WorkflowStatusSnapshot` and applies
 * it atomically, triggering a single re-render through the private `emit` path.
 */
export class DaemonPanelStore extends PanelStore {
  /**
   * Apply a `WorkflowStatusSnapshot` from a `panel/update` notification.
   *
   * Maps all snapshot fields onto store properties and fires `emit()` so
   * React components subscribed via `useSyncExternalStore` re-render.
   */
  applySnapshot(snapshot: WorkflowStatusSnapshot): void {
    this.workflowName = snapshot.workflowName;
    this.agent = snapshot.agent;
    this.prompt = snapshot.prompt;
    this.fatalError = snapshot.fatalError;

    this.sessions = buildGraphSessions(snapshot);

    // Mirror completionReached from the snapshot without double-firing if
    // it's already set (markCompletionReached would call emit a second time).
    if (snapshot.completionReached && !this.completionReached) {
      this.completionReached = true;
    }

    // Trigger re-render via the private `emit()` method.
    // The cast is intentional: `emit` is `private` in PanelStore but we
    // need to call it from the subclass for snapshot-driven updates that
    // don't map cleanly onto any single public mutator.
    (this as unknown as { emit(): void }).emit();
  }
}

// ---------------------------------------------------------------------------
// Pure helper — extract for testing
// ---------------------------------------------------------------------------

/**
 * Cast the opaque `WorkflowStatusSnapshot` from JSON-RPC into the typed
 * snapshot shape expected by `DaemonPanelStore.applySnapshot`.
 *
 * This is a pure, side-effect-free helper extracted so it can be unit-tested
 * without mounting any OpenTUI renderer.
 */
export function castSnapshot(opaque: OpaqueSnapshot): WorkflowStatusSnapshot {
  return opaque as unknown as WorkflowStatusSnapshot;
}

/**
 * Map a `WorkflowStatusSnapshot` to a `SessionData[]`.
 *
 * Pure helper — no side effects, fully unit-testable.
 */
export function mapSnapshotSessions(snapshot: WorkflowStatusSnapshot): SessionData[] {
  return snapshot.sessions.map(
    (s): SessionData => ({
      name: s.name,
      status: s.status as SessionStatus,
      parents: s.parents,
      error: s.error,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }),
  );
}

function virtualOrchestratorStatus(snapshot: WorkflowStatusSnapshot): SessionStatus {
  if (snapshot.fatalError !== null || snapshot.sessions.some((s) => s.status === "error")) {
    return "error";
  }
  if (snapshot.completionReached) return "complete";
  return "running";
}

function minStartedAt(sessions: readonly SessionData[]): number | null {
  const values = sessions
    .map((s) => s.startedAt)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.min(...values) : null;
}

function maxEndedAt(sessions: readonly SessionData[]): number | null {
  const values = sessions
    .map((s) => s.endedAt)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Build the graph-visible session list from daemon snapshots.
 *
 * Daemon snapshots contain only workflow stages, while the graph UI's layout
 * expects an explicit orchestrator root. Without that root, stages whose
 * parent list is empty are all treated as independent roots and Yoga renders
 * them as a flat left-to-right row. Restoring the virtual root gives the graph
 * a stable top-down hierarchy while preserving raw stage parent metadata.
 */
export function buildGraphSessions(snapshot: WorkflowStatusSnapshot): SessionData[] {
  const sessions = mapSnapshotSessions(snapshot);
  if (sessions.some((s) => s.name === "orchestrator")) return sessions;

  const orchestratorStatus = virtualOrchestratorStatus(snapshot);
  return [
    {
      name: "orchestrator",
      status: orchestratorStatus,
      parents: [],
      startedAt: minStartedAt(sessions),
      endedAt: orchestratorStatus === "running" ? null : maxEndedAt(sessions),
    },
    ...sessions,
  ];
}

/**
 * Apply daemon foreground-stage state to the local OpenTUI store.
 * `null` means the graph overview is foregrounded; a stage name means the
 * panel should show that stage's PTY pane.
 */
export function applyForegroundStage(store: PanelStore, stageName: string | null): void {
  if (stageName === null) {
    store.setViewMode("graph");
    return;
  }
  store.setViewMode("attached", stageName);
}

export type PanelExitReason = "exit" | "abort";
export type WorkflowPanelResult =
  | { kind: PanelExitReason }
  | { kind: "detach" }
  | { kind: "pane"; stageName: string };
export type WorkflowPaneResult = { kind: "graph" } | { kind: PanelExitReason } | { kind: "detach" };

const PANEL_EXIT_SIGNALS: NodeJS.Signals[] = [
  "SIGTERM",
  "SIGQUIT",
  "SIGABRT",
  "SIGHUP",
  "SIGPIPE",
  "SIGBUS",
  "SIGFPE",
];

export interface DirectSessionRendererConfigOptions {
  footerHeight: number;
  clearOnShutdown: boolean;
}

/**
 * Renderer configuration for direct PTY sessions.
 *
 * Direct chat and workflow pane attaches stream the native agent TUI straight
 * to the user's terminal, outside OpenTUI's render tree. OpenTUI mouse support
 * stays enabled so click sequences can be captured above the split footer and
 * forwarded to the attached agent PTY when that agent has requested mouse
 * reporting.
 */
export function createDirectSessionRendererConfig({
  footerHeight,
  clearOnShutdown,
}: DirectSessionRendererConfigOptions): CliRendererConfig {
  return {
    exitOnCtrlC: false,
    exitSignals: [...PANEL_EXIT_SIGNALS],
    screenMode: "split-footer",
    footerHeight,
    externalOutputMode: "passthrough",
    clearOnShutdown,
    useMouse: true,
  };
}

export async function stopRunForPanelAbort(
  connection: MessageConnection,
  runId: string,
  timeoutMs = 1_500,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([
      connection.sendRequest("run/stop", { runId }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PanelClientOptions {
  /** Run ID to attach to. */
  runId: string;
  /** Attach UI kind. Workflows use the graph; chat streams the native agent TUI with a footer. */
  view?: "workflow" | "chat";
  /** Required for `view: "chat"` so the footer can render the provider pill. */
  agentType?: AgentType;
  /**
   * If provided, connect to this endpoint directly instead of reading the
   * default endpoint file.
   */
  daemonEndpoint?: { host: string; port: number };
  /** Pre-shared auth token. Defaults to ATOMIC_UI_SERVER_TOKEN env var. */
  token?: string;
  /** Absolute path to the daemon endpoint file. */
  endpointFile?: string;
  /** clientName sent in the connect() handshake. */
  clientName?: string;
}

/**
 * PanelClient — static-mount daemon panel client.
 *
 * Usage:
 * ```ts
 * await PanelClient.mount({ runId: "abc-123" });
 * ```
 *
 * Connects to the daemon, fetches the initial panel snapshot, subscribes
 * to live updates, mounts the OpenTUI session graph, and blocks until the
 * user detaches.
 */
export class PanelClient {
  private readonly connection: MessageConnection;
  private readonly store: DaemonPanelStore;
  private readonly renderer: CliRenderer;
  private readonly root: ReturnType<typeof createRoot>;
  private readonly graphTheme: GraphTheme;
  private readonly runId: string;
  private subscriptionId: string | null = null;
  /** Tracks the currently foregrounded stage (from panel/foregroundChange). */
  foregroundStage: string | null = null;
  private destroyed = false;

  private constructor(
    connection: MessageConnection,
    store: DaemonPanelStore,
    renderer: CliRenderer,
    root: ReturnType<typeof createRoot>,
    graphTheme: GraphTheme,
    runId: string,
  ) {
    this.connection = connection;
    this.store = store;
    this.renderer = renderer;
    this.root = root;
    this.graphTheme = graphTheme;
    this.runId = runId;
  }

  /**
   * Connect to the daemon, mount the OpenTUI panel, and block until the user
   * detaches (q or Ctrl+C). Cleans up all resources before returning.
   */
  static async mount(opts: PanelClientOptions): Promise<void> {
    const {
      runId,
      daemonEndpoint,
      token,
      endpointFile,
      clientName = "@bastani/atomic-sdk/panel-client",
      view = "workflow",
      agentType,
    } = opts;

    // ── 1. Connect to daemon ──────────────────────────────────────────────
    let connection: MessageConnection;

    if (daemonEndpoint) {
      // Direct endpoint provided — import vscode-jsonrpc helpers manually
      // (mirrors the private openConnection() in daemon.ts).
      const net = await import("node:net");
      const { StreamMessageReader, StreamMessageWriter, createMessageConnection } =
        await import("vscode-jsonrpc/node");

      connection = await new Promise<MessageConnection>((resolve, reject) => {
        const socket = net.default.createConnection(daemonEndpoint);
        socket.once("error", reject);
        socket.once("connect", () => {
          const reader = new StreamMessageReader(socket);
          const writer = new StreamMessageWriter(socket);
          const conn = createMessageConnection(reader, writer);
          conn.listen();
          const connectParams: { token?: string; clientName: string } = { clientName };
          if (token !== undefined) connectParams.token = token;
          conn
            .sendRequest("connect", connectParams)
            .then(() => resolve(conn))
            .catch((err) => {
              socket.on("error", () => {});
              conn.dispose();
              socket.destroy();
              reject(err);
            });
        });
      });
    } else {
      connection = await connectToDaemon({ endpointFile, token, clientName });
    }

    if (view === "chat") {
      if (!agentType) {
        closeDaemonConnection(connection);
        throw new Error('PanelClient.mount({ view: "chat" }) requires agentType.');
      }
      await PanelClient.mountChat({ connection, runId, agentType });
      return;
    }

    // ── 2. Fetch initial snapshot ─────────────────────────────────────────
    const initialOpaque = (await connection.sendRequest("panel/get", {
      runId,
    })) as OpaqueSnapshot;
    const initialSnapshot = castSnapshot(initialOpaque);

    // ── 3. Subscribe for live updates ─────────────────────────────────────
    const subResult = (await connection.sendRequest("panel/subscribe", {
      runId,
    })) as { subscriptionId: string; foregroundStage?: string | null };
    const subscriptionId = subResult.subscriptionId;

    // ── 4. Store + daemon notifications ──────────────────────────────────
    const store = new DaemonPanelStore();
    store.applySnapshot(initialSnapshot);

    connection.onNotification(
      "panel/update",
      (params: PanelUpdateNotificationParams) => {
        if (params.runId !== runId) return;
        store.applySnapshot(castSnapshot(params.snapshot));
      },
    );

    let foregroundStage = subResult.foregroundStage ?? null;
    connection.onNotification(
      "panel/foregroundChange",
      (params: PanelForegroundChangeNotificationParams) => {
        if (params.runId !== runId) return;
        foregroundStage = params.stageName;
      },
    );

    // ── 5. Mount graph and dedicated PTY renderers as needed ──────────────
    try {
      let done = false;
      while (!done) {
        const graphResult = await PanelClient.mountWorkflowGraph({
          connection,
          runId,
          store,
        });

        if (graphResult.kind === "detach") {
          done = true;
          continue;
        }

        if (graphResult.kind === "pane") {
          foregroundStage = graphResult.stageName;
          const paneResult = await PanelClient.mountWorkflowPane({
            connection,
            runId,
            stageName: graphResult.stageName,
            store,
          });

          if (paneResult.kind === "graph") {
            foregroundStage = null;
            await connection.sendRequest("run/setForeground", { runId }).catch(() => {});
            continue;
          }

          if (paneResult.kind === "detach") {
            done = true;
            continue;
          }

          if (paneResult.kind === "abort") {
            await stopRunForPanelAbort(connection, runId).catch(() => {});
          }
          done = true;
          continue;
        }

        if (graphResult.kind === "abort") {
          await stopRunForPanelAbort(connection, runId).catch(() => {});
        }
        done = true;
      }
    } finally {
      if (foregroundStage !== null) {
        await connection.sendRequest("run/setForeground", { runId }).catch(() => {});
      }
      await connection.sendRequest("panel/unsubscribe", { subscriptionId }).catch(() => {});
      closeDaemonConnection(connection);
    }
  }

  private static async mountWorkflowGraph({
    connection,
    runId,
    store,
  }: {
    connection: MessageConnection;
    runId: string;
    store: DaemonPanelStore;
  }): Promise<WorkflowPanelResult> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: ["SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGPIPE", "SIGBUS", "SIGFPE"],
      screenMode: "alternate-screen",
      clearOnShutdown: true,
    });

    const termTheme = resolveTheme(renderer.themeMode);
    setRendererBackground(renderer, termTheme.bg, { syncTerminalDefault: true });
    const graphTheme = deriveGraphTheme(termTheme);
    const root = createRoot(renderer);

    try {
      return await new Promise<WorkflowPanelResult>((resolve) => {
        let settled = false;
        const finish = (result: WorkflowPanelResult) => {
          if (settled) return;
          settled = true;
          store.exitResolve = null;
          store.abortResolve = null;
          resolve(result);
        };

        store.setViewMode("graph");
        store.exitResolve = () => finish({ kind: "exit" });
        store.abortResolve = () => finish({ kind: "abort" });

        root.render(
          <StoreContext.Provider value={store}>
            <ThemeContext.Provider value={graphTheme}>
              <ErrorBoundary
                fallback={(err) => (
                  <box
                    width="100%"
                    height="100%"
                    justifyContent="center"
                    alignItems="center"
                    backgroundColor={graphTheme.background}
                  >
                    <text>
                      <span fg={graphTheme.error}>
                        {`Fatal render error: ${err.message}`}
                      </span>
                    </text>
                  </box>
                )}
              >
                <SessionGraphPanel
                  runId={runId}
                  connection={connection}
                  onOpenPane={(stageName) => finish({ kind: "pane", stageName })}
                  onDetach={() => finish({ kind: "detach" })}
                />
              </ErrorBoundary>
            </ThemeContext.Provider>
          </StoreContext.Provider>,
        );

        requestRendererBackgroundRepaint(renderer);
      });
    } finally {
      try { root.unmount(); } catch {}
      try {
        resetRendererTerminalBackground(renderer);
        renderer.destroy();
      } catch {}
    }
  }

  private static async mountWorkflowPane({
    connection,
    runId,
    stageName,
    store,
  }: {
    connection: MessageConnection;
    runId: string;
    stageName: string;
    store: DaemonPanelStore;
  }): Promise<WorkflowPaneResult> {
    const renderer = await createCliRenderer(createDirectSessionRendererConfig({
      footerHeight: PANE_FOOTER_ROWS,
      clearOnShutdown: true,
    }));

    const termTheme = resolveTheme(renderer.themeMode);
    setRendererBackground(renderer, termTheme.bg, { syncTerminalDefault: true });
    const graphTheme = deriveGraphTheme(termTheme);
    const root = createRoot(renderer);

    try {
      return await new Promise<WorkflowPaneResult>((resolve) => {
        let settled = false;
        const finish = (result: WorkflowPaneResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        root.render(
          <StoreContext.Provider value={store}>
            <ThemeContext.Provider value={graphTheme}>
              <ErrorBoundary
                fallback={(err) => (
                  <box height={PANE_FOOTER_ROWS} backgroundColor={graphTheme.backgroundElement}>
                    <text>
                      <span fg={graphTheme.error} bg={graphTheme.backgroundElement}>
                        {`Fatal pane footer error: ${err.message}`}
                      </span>
                    </text>
                  </box>
                )}
              >
                <DirectPtyPane
                  runId={runId}
                  stageName={stageName}
                  focused
                  connection={connection}
                  onQuit={() => finish({ kind: "abort" })}
                  onDetach={() => finish({ kind: "detach" })}
                  onReturnToGraph={() => finish({ kind: "graph" })}
                />
                <PanelFooter
                  mode="PANE"
                  subject={stageName}
                  runId={runId}
                  tone={panelFooterToneFromStatus(store)}
                  hints={[
                    { key: "Ctrl+G", label: "graph" },
                    { key: "Ctrl+D", label: "detach" },
                    { key: "q", label: "quit" },
                  ]}
                />
              </ErrorBoundary>
            </ThemeContext.Provider>
          </StoreContext.Provider>,
        );

        requestRendererBackgroundRepaint(renderer);
      });
    } finally {
      try { root.unmount(); } catch {}
      try {
        resetRendererTerminalBackground(renderer);
        renderer.destroy();
      } catch {}
    }
  }

  private static async mountChat({
    connection,
    runId,
    agentType,
  }: {
    connection: MessageConnection;
    runId: string;
    agentType: AgentType;
  }): Promise<void> {
    const renderer = await createCliRenderer(createDirectSessionRendererConfig({
      footerHeight: CHAT_FOOTER_ROWS,
      clearOnShutdown: false,
    }));

    const termTheme = resolveTheme(renderer.themeMode);
    setRendererBackground(renderer, termTheme.bg, { syncTerminalDefault: true });
    const graphTheme = deriveGraphTheme(termTheme);

    const root = createRoot(renderer);
    await new Promise<void>((resolve) => {
      root.render(
        <ThemeContext.Provider value={graphTheme}>
          <ErrorBoundary
            fallback={(err) => (
              <box height={CHAT_FOOTER_ROWS} backgroundColor={graphTheme.backgroundElement}>
                <text>
                  <span fg={graphTheme.error} bg={graphTheme.backgroundElement}>
                    {`Fatal chat footer error: ${err.message}`}
                  </span>
                </text>
              </box>
            )}
          >
            <ChatSessionPanel
              runId={runId}
              agentType={agentType}
              connection={connection}
              onDetach={resolve}
            />
          </ErrorBoundary>
        </ThemeContext.Provider>,
      );
      requestRendererBackgroundRepaint(renderer);
    });

    try {
      root.unmount();
    } catch {}
    try {
      closeDaemonConnection(connection);
    } catch {}
    try {
      resetRendererTerminalBackground(renderer);
      renderer.destroy();
    } catch {}
  }

  /**
   * Tear down all resources: unsubscribe from panel updates, dispose the
   * daemon connection, and destroy the terminal renderer. Idempotent.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Unsubscribe from panel updates.
    if (this.subscriptionId !== null) {
      try {
        await this.connection.sendRequest("panel/unsubscribe", {
          subscriptionId: this.subscriptionId,
        });
      } catch {
        // Best-effort; don't block cleanup.
      }
      this.subscriptionId = null;
    }

    // Unmount React before destroying the renderer so keyboard hooks,
    // animation intervals, and pane subscriptions cannot keep the process
    // alive after the user detaches from the workflow panel.
    try {
      this.root.unmount();
    } catch {}

    // Dispose the JSON-RPC connection.
    try {
      closeDaemonConnection(this.connection);
    } catch {}

    // Tear down the renderer.
    try {
      resetRendererTerminalBackground(this.renderer);
      this.renderer.destroy();
    } catch {}
  }
}
