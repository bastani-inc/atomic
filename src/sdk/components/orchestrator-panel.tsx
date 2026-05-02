/** @jsxImportSource @opentui/react */
/**
 * OrchestratorPanel — public API class that bridges the imperative
 * executor interface with the React-based session graph TUI.
 */

import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolveTheme } from "../runtime/theme.ts";
import { deriveGraphTheme } from "./graph-theme.ts";
import type { GraphTheme } from "./graph-theme.ts";
import { PanelStore } from "./orchestrator-panel-store.ts";
import { StoreContext, ThemeContext, TmuxSessionContext } from "./orchestrator-panel-contexts.ts";
import type { PanelSession, PanelOptions, SessionData } from "./orchestrator-panel-types.ts";
import { SessionGraphPanel } from "./session-graph-panel.tsx";
import { ErrorBoundary } from "./error-boundary.tsx";
import {
  requestRendererBackgroundRepaint,
  resetRendererTerminalBackground,
  setRendererBackground,
} from "./renderer-background.ts";
import { createTuiDiagnostics, type TuiDiagnostics } from "./tui-diagnostics.ts";

export class OrchestratorPanel {
  private store: PanelStore;
  private renderer: CliRenderer;
  private destroyed = false;
  private terminalBackgroundSynced: boolean;
  private diagnostics: TuiDiagnostics | null = null;
  private unsubscribeDiagnostics: (() => void) | null = null;

  private constructor(
    renderer: CliRenderer,
    store: PanelStore,
    graphTheme: GraphTheme,
    tmuxSession: string,
    terminalBackgroundSynced: boolean,
  ) {
    this.renderer = renderer;
    this.store = store;
    this.terminalBackgroundSynced = terminalBackgroundSynced;
    this.diagnostics = createTuiDiagnostics({
      renderer,
      graphTheme,
      getSnapshot: () => this.getDiagnosticSnapshot(),
    });
    this.unsubscribeDiagnostics = this.diagnostics
      ? store.subscribe(() => this.diagnostics?.capture("store-update"))
      : null;

    createRoot(renderer).render(
      <StoreContext.Provider value={store}>
        <ThemeContext.Provider value={graphTheme}>
          <TmuxSessionContext.Provider value={tmuxSession}>
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
              <SessionGraphPanel />
            </ErrorBoundary>
          </TmuxSessionContext.Provider>
        </ThemeContext.Provider>
      </StoreContext.Provider>,
    );
    requestRendererBackgroundRepaint(this.renderer);
    this.diagnostics?.capture("post-mount");
  }

  /**
   * Create a new OrchestratorPanel with the default CLI renderer.
   *
   * This is the primary entry point — it initialises the terminal renderer
   * and mounts the React-based session graph TUI.
   */
  static async create(options: PanelOptions): Promise<OrchestratorPanel> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: ["SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGPIPE", "SIGBUS", "SIGFPE"],
    });
    return OrchestratorPanel.createWithRenderer(renderer, options, { syncTerminalBackground: true });
  }

  /** Create with an externally-provided renderer (e.g. a test renderer). */
  static createWithRenderer(
    renderer: CliRenderer,
    options: PanelOptions,
    { syncTerminalBackground = false }: { syncTerminalBackground?: boolean } = {},
  ): OrchestratorPanel {
    const termTheme = resolveTheme(renderer.themeMode);
    setRendererBackground(renderer, termTheme.bg, { syncTerminalDefault: syncTerminalBackground });
    const graphTheme = deriveGraphTheme(termTheme);
    const store = new PanelStore();
    return new OrchestratorPanel(renderer, store, graphTheme, options.tmuxSession, syncTerminalBackground);
  }

  /**
   * Display the workflow overview in the TUI — name, agent, session graph,
   * and the user prompt. Call once after construction before sessions start.
   */
  showWorkflowInfo(
    name: string,
    agent: string,
    sessions: PanelSession[],
    prompt: string,
  ): void {
    this.store.setWorkflowInfo(name, agent, sessions, prompt);
  }

  /** Mark a session as running in the graph UI. */
  sessionStart(name: string): void {
    this.store.startSession(name);
  }

  /** Mark a session as successfully completed in the graph UI. */
  sessionSuccess(name: string): void {
    this.store.completeSession(name);
  }

  /** Mark a session as failed in the graph UI and display the error message. */
  sessionError(name: string, message: string): void {
    this.store.failSession(name, message);
  }

  sessionAwaitingInput(name: string): void {
    this.store.awaitingInput(name);
  }

  sessionResumed(name: string): void {
    this.store.resumeSession(name);
  }

  /** Dynamically add a new session node to the graph UI. */
  addSession(name: string, parents: string[]): void {
    this.store.addSession({
      name,
      status: "running",
      parents,
      startedAt: Date.now(),
      endedAt: null,
    });
  }

  /** Increment the background task counter (shown in the statusline footer). */
  backgroundTaskStarted(): void {
    this.store.incrementBackgroundTasks();
  }

  /** Decrement the background task counter (shown in the statusline footer). */
  backgroundTaskFinished(): void {
    this.store.decrementBackgroundTasks();
  }

  /** Show the workflow-complete banner with a link to saved transcripts. */
  showCompletion(workflowName: string, transcriptsPath: string): void {
    this.store.setCompletion(workflowName, transcriptsPath);
  }

  /** Display a fatal error banner in the TUI. */
  showFatalError(message: string): void {
    this.store.setFatalError(message);
  }

  /**
   * Block until the user presses `q` or `Ctrl+C` in the TUI.
   * Call after {@link showCompletion} or {@link showFatalError}.
   */
  waitForExit(): Promise<void> {
    this.store.markCompletionReached();
    return new Promise<void>((resolve) => {
      this.store.exitResolve = resolve;
    });
  }

  /**
   * Returns a promise that resolves when the user requests a mid-execution quit
   * (via `q` or `Ctrl+C`). Race this against the workflow run.
   */
  waitForAbort(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.store.abortResolve = resolve;
    });
  }

  /** Tear down the terminal renderer and release resources. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeDiagnostics?.();
    this.unsubscribeDiagnostics = null;
    this.diagnostics?.capture("destroy");
    this.diagnostics?.dispose();
    this.diagnostics = null;
    try {
      if (this.terminalBackgroundSynced) {
        resetRendererTerminalBackground(this.renderer);
      }
      this.renderer.destroy();
    } catch {}
  }

  /**
   * Subscribe to store mutations. Returned function unsubscribes.
   *
   * Used by the orchestrator process to mirror the in-memory panel
   * state to a `status.json` file on disk so out-of-process consumers
   * (e.g. `atomic workflow status`) can read the live workflow state.
   */
  subscribe(fn: () => void): () => void {
    return this.store.subscribe(fn);
  }

  /**
   * Read-only snapshot of the fields needed by the on-disk status
   * writer. Defined here (not in PanelStore) because the store keeps
   * full mutable references; this projection drops the renderer-only
   * promise resolvers and version counter.
   */
  getSnapshot(): {
    workflowName: string;
    agent: string;
    prompt: string;
    fatalError: string | null;
    completionReached: boolean;
    sessions: readonly SessionData[];
  } {
    return {
      workflowName: this.store.workflowName,
      agent: this.store.agent,
      prompt: this.store.prompt,
      fatalError: this.store.fatalError,
      completionReached: this.store.completionReached,
      sessions: this.store.sessions,
    };
  }

  private getDiagnosticSnapshot() {
    return {
      workflowName: this.store.workflowName,
      agent: this.store.agent,
      prompt: this.store.prompt,
      fatalError: this.store.fatalError,
      completionReached: this.store.completionReached,
      sessions: this.store.sessions,
      backgroundTaskCount: this.store.backgroundTaskCount,
      viewMode: this.store.viewMode,
      activeAgentId: this.store.activeAgentId,
    };
  }
}
