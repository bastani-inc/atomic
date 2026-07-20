import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type TruncationResult, BashExecutionComponent } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.handleBashCommand = async function(this: InteractiveModeBase, command: string, excludeFromContext = false): Promise<void> {
    const extensionRunner = this.session.extensionRunner;

    // Emit user_bash event to let extensions intercept
    const eventResult = await extensionRunner.emitUserBash({
      type: "user_bash",
      command,
      excludeFromContext,
      cwd: this.sessionManager.getCwd(),
    });

    // If extension returned a full result, use it directly
    if (eventResult?.result) {
      const result = eventResult.result;

      // Create UI component for display
      this.bashComponent = new BashExecutionComponent(
        command,
        this.ui,
        excludeFromContext,
      );
      if (this.session.isStreaming) {
        this.pendingMessagesContainer.addChild(this.bashComponent);
        this.pendingBashComponents.push(this.bashComponent);
      } else {
        this.chatContainer.addChild(this.bashComponent);
      }

      // Show output and complete
      if (result.output) {
        this.bashComponent.appendOutput(result.output);
      }
      this.bashComponent.setComplete(
        result.exitCode,
        result.cancelled,
        result.truncated
          ? ({ truncated: true, content: result.output } as TruncationResult)
          : undefined,
        result.fullOutputPath,
      );

      // Record the result in session
      this.session.recordBashResult(command, result, { excludeFromContext });
      this.bashComponent = undefined;
      this.ui.requestRender();
      return;
    }

    // Normal execution path (possibly with custom operations)
    const isDeferred = this.session.isStreaming;
    this.bashComponent = new BashExecutionComponent(
      command,
      this.ui,
      excludeFromContext,
    );

    if (isDeferred) {
      // Show in pending area when agent is streaming
      this.pendingMessagesContainer.addChild(this.bashComponent);
      this.pendingBashComponents.push(this.bashComponent);
    } else {
      // Show in chat immediately when agent is idle
      this.chatContainer.addChild(this.bashComponent);
    }
    this.ui.requestRender();

    try {
      const result = await this.session.executeBash(
        command,
        (chunk) => {
          if (this.bashComponent) {
            this.bashComponent.appendOutput(chunk);
            this.ui.requestRender();
          }
        },
        { excludeFromContext, operations: eventResult?.operations },
      );

      if (this.bashComponent) {
        this.bashComponent.setComplete(
          result.exitCode,
          result.cancelled,
          result.truncated
            ? ({ truncated: true, content: result.output } as TruncationResult)
            : undefined,
          result.fullOutputPath,
        );
      }
    } catch (error) {
      if (this.bashComponent) {
        this.bashComponent.setComplete(undefined, false);
      }
      this.showError(
        `Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }

    this.bashComponent = undefined;
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleCompactCommand = async function(this: InteractiveModeBase): Promise<void> {
    const entries = this.sessionManager.getEntries();
    const messageCount = entries.filter((e) => e.type === "message").length;

    if (messageCount < 2) {
      this.showWarning("Nothing to compact (no messages yet)");
      return;
    }

    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();

    try {
      await this.session.compact();
    } catch {
      // Ignore, will be emitted as an event
    }
  };

InteractiveModeBase.prototype.stop = function(this: InteractiveModeBase): void {
    this.disposeInteractiveEngineHost();
    this.disposeInteractiveEngineHost = () => {};
    if (this.settingsManager.getShowTerminalProgress()) {
      this.ui.terminal.setProgress(false);
    }
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.themeController.disableAutoSync();
    this.clearExtensionTerminalInputListeners();
    this.footer.dispose();
    this.footerDataProvider.dispose();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (this.isInitialized) {
      this.ui.stop();
      this.isInitialized = false;
    }
    this.unregisterSignalHandlers();
  };
