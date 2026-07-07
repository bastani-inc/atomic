import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { chalk, killTrackedDetachedChildren } from "./interactive-mode-deps.ts";
import { formatResumeCommand, isDeadTerminalError } from "./interactive-mode-helpers.ts";

const SHUTDOWN_INPUT_DRAIN_MAX_MS = 250;
const SHUTDOWN_INPUT_DRAIN_IDLE_MS = 50;

InteractiveModeBase.prototype.handleCtrlC = function(this: InteractiveModeBase): void {
    const now = Date.now();
    if (now - this.lastSigintTime < 500) {
      void this.shutdown();
    } else {
      this.clearEditor();
      this.lastSigintTime = now;
    }
  };

InteractiveModeBase.prototype.handleCtrlD = function(this: InteractiveModeBase): void {
    // Only called when editor is empty (enforced by CustomEditor)
    void this.shutdown();
  };

InteractiveModeBase.prototype.shutdown = async function(this: InteractiveModeBase, options?: { fromSignal?: boolean }): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    // Keep signal handlers registered until terminal cleanup has completed.
    // `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
    // dispatch and re-sends the signal if only its own listeners remain.

    if (options?.fromSignal) {
      await this.runtimeHost.dispose();
      this.themeController.disableAutoSync();
      // Drain any in-flight Kitty key release events briefly before stopping.
      // Keep this bounded so Ctrl+C exits do not feel stalled on Windows.
      await this.ui.terminal.drainInput(SHUTDOWN_INPUT_DRAIN_MAX_MS, SHUTDOWN_INPUT_DRAIN_IDLE_MS);
      this.stop();
      process.exit(0);
    }

    // Drain any in-flight Kitty key release events briefly before stopping.
    // Keep this bounded so Ctrl+C exits do not feel stalled on Windows.
    this.themeController.disableAutoSync();
    await this.ui.terminal.drainInput(SHUTDOWN_INPUT_DRAIN_MAX_MS, SHUTDOWN_INPUT_DRAIN_IDLE_MS);

    this.stop();
    await this.runtimeHost.dispose();
    const resumeCommand = formatResumeCommand(this.sessionManager);
    if (resumeCommand) {
      process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
    }
    process.exit(0);
  };

InteractiveModeBase.prototype.emergencyTerminalExit = function(this: InteractiveModeBase): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    killTrackedDetachedChildren();
    // The terminal is gone. Do not run normal shutdown because TUI and
    // extension cleanup can write restore sequences and re-trigger EIO.
    process.exit(129);
  };

InteractiveModeBase.prototype.uncaughtCrash = function(this: InteractiveModeBase, error: Error): never {
    if (this.isShuttingDown) {
      process.exit(1);
    }
    this.isShuttingDown = true;
    try {
      this.unregisterSignalHandlers();
    } catch {}
    try {
      killTrackedDetachedChildren();
    } catch {}
    try {
      this.ui.stop();
    } catch {}
    console.error("pi exiting due to uncaughtException:");
    console.error(error);
    process.exit(1);
  };

InteractiveModeBase.prototype.checkShutdownRequested = async function(this: InteractiveModeBase): Promise<void> {
    if (!this.shutdownRequested) return;
    await this.shutdown();
  };

InteractiveModeBase.prototype.registerSignalHandlers = function(this: InteractiveModeBase): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ["SIGTERM"];
    if (process.platform !== "win32") {
      signals.push("SIGHUP");
    }

    for (const signal of signals) {
      const handler = () => {
        killTrackedDetachedChildren();
        void this.shutdown({ fromSignal: true });
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => process.off(signal, handler));
    }

    const sigintHandler = () => {
      this.handleCtrlC();
    };
    process.prependListener("SIGINT", sigintHandler);
    this.signalCleanupHandlers.push(() => process.off("SIGINT", sigintHandler));

    const terminalErrorHandler = (error: Error) => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
      throw error;
    };
    process.stdout.on("error", terminalErrorHandler);
    process.stderr.on("error", terminalErrorHandler);
    this.signalCleanupHandlers.push(() =>
      process.stdout.off("error", terminalErrorHandler),
    );
    this.signalCleanupHandlers.push(() =>
      process.stderr.off("error", terminalErrorHandler),
    );

    // Restore the terminal before the process dies on any uncaught throw.
    // Without this, an unhandled exception from extension code (or anywhere
    // in pi) leaves the terminal in raw mode with no cursor.
    const uncaughtExceptionHandler = (error: Error) =>
      this.uncaughtCrash(error);
    process.prependListener("uncaughtException", uncaughtExceptionHandler);
    this.signalCleanupHandlers.push(() =>
      process.off("uncaughtException", uncaughtExceptionHandler),
    );
  };

InteractiveModeBase.prototype.unregisterSignalHandlers = function(this: InteractiveModeBase): void {
    for (const cleanup of this.signalCleanupHandlers) {
      cleanup();
    }
    this.signalCleanupHandlers = [];
  };

InteractiveModeBase.prototype.handleCtrlZ = function(this: InteractiveModeBase): void {
    if (process.platform === "win32") {
      this.showStatus("Suspend to background is not supported on Windows");
      return;
    }

    // Keep the event loop alive while suspended. Without this, stopping the TUI
    // can leave Node with no ref'ed handles, causing the process to exit on fg
    // before the SIGCONT handler gets a chance to restore the terminal.
    const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

    // Ignore SIGINT while suspended so Ctrl+C in the terminal does not
    // kill the backgrounded process. The handler is removed on resume.
    const ignoreSigint = () => {};
    process.on("SIGINT", ignoreSigint);

    // Set up handler to restore TUI when resumed
    process.once("SIGCONT", () => {
      clearInterval(suspendKeepAlive);
      process.removeListener("SIGINT", ignoreSigint);
      this.ui.start();
      this.ui.requestRender(true);
    });

    try {
      // Stop the TUI (restore terminal to normal mode)
      this.ui.stop();

      // Send SIGTSTP to process group (pid=0 means all processes in group)
      process.kill(0, "SIGTSTP");
    } catch (error) {
      clearInterval(suspendKeepAlive);
      process.removeListener("SIGINT", ignoreSigint);
      throw error;
    }
  };

InteractiveModeBase.prototype.handleFollowUp = async function(this: InteractiveModeBase): Promise<void> {
    const text = (
      this.editor.getExpandedText?.() ?? this.editor.getText()
    ).trim();
    if (!text) return;

    // Queue input during compaction (extension commands execute immediately)
    if (this.session.isCompacting) {
      if (this.isExtensionCommand(text)) {
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        await this.session.prompt(text);
      } else {
        this.queueCompactionMessage(text, "followUp");
      }
      return;
    }

    // Alt+Enter queues a follow-up message (waits until agent finishes)
    // This handles extension commands (execute immediately), prompt template expansion, and queueing
    if (this.session.isStreaming) {
      this.editor.addToHistory?.(text);
      this.editor.setText("");
      await this.session.prompt(text, { streamingBehavior: "followUp" });
      this.updatePendingMessagesDisplay();
      this.ui.requestRender();
    }
    // If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
    else if (this.editor.onSubmit) {
      this.editor.setText("");
      this.editor.onSubmit(text);
    }
  };

InteractiveModeBase.prototype.handleDequeue = function(this: InteractiveModeBase): void {
    const restored = this.restoreQueuedMessagesToEditor();
    if (restored === 0) {
      this.showStatus("No queued messages to restore");
    } else {
      this.showStatus(
        `Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`,
      );
    }
  };
