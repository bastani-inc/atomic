import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Message, type AgentSessionEvent, type ContextCompactionResult, Loader, Spacer, Text, pickWhimsicalWorkingMessage, AssistantMessageComponent, CountdownTimer, keyText, ToolExecutionComponent, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.subscribeToAgent = function(this: InteractiveModeBase): void {
    this.unsubscribe = this.session.subscribe(async (event) => {
      await this.handleEvent(event);
    });
  };

InteractiveModeBase.prototype.handleEvent = async function(this: InteractiveModeBase, event: AgentSessionEvent): Promise<void> {
    if (!this.isInitialized) {
      await this.init();
    }

    this.footer.invalidate();

    switch (event.type) {
      case "agent_start":
        this.pendingTools.clear();
        if (this.settingsManager.getShowTerminalProgress()) {
          this.ui.terminal.setProgress(true);
        }
        // Restore main escape handler if retry handler is still active
        // (retry success event fires later, but we need main handler now)
        if (this.retryEscapeHandler) {
          this.defaultEditor.onEscape = this.retryEscapeHandler;
          this.retryEscapeHandler = undefined;
        }
        if (this.retryCountdown) {
          this.retryCountdown.dispose();
          this.retryCountdown = undefined;
        }
        if (this.retryLoader) {
          this.retryLoader.stop();
          this.retryLoader = undefined;
        }
        this.stopWorkingLoader();
        if (this.workingVisible) {
          this.loadingAnimation = this.createWorkingLoader();
          this.statusContainer.addChild(this.loadingAnimation);
        }
        this.ui.requestRender();
        break;

      case "turn_start": {
        this.workingMessage = pickWhimsicalWorkingMessage();
        if (this.loadingAnimation) {
          this.loadingAnimation.setMessage(this.workingMessage);
        }
        break;
      }

      case "turn_end": {
        this.workingMessage = undefined;
        if (this.loadingAnimation) {
          this.loadingAnimation.setMessage(this.defaultWorkingMessage);
        }
        break;
      }

      case "queue_update":
        this.updatePendingMessagesDisplay();
        this.ui.requestRender();
        break;

      case "session_info_changed":
        this.updateTerminalTitle();
        this.footer.invalidate();
        this.ui.requestRender();
        break;

      case "model_changed":
        this.refreshBuiltInHeader();
        this.updateEditorBorderColor();
        break;

      case "thinking_level_changed":
        this.footer.invalidate();
        this.refreshBuiltInHeader();
        this.updateEditorBorderColor();
        break;

      case "context_window_changed":
        this.footer.invalidate();
        this.usageMeter.invalidate();
        this.ui.requestRender();
        break;

      case "message_start":
        if (event.message.role === "custom") {
          this.addMessageToChat(event.message);
          this.ui.requestRender();
        } else if (event.message.role === "user") {
          if (!this.consumeDeferredRenderedUserInput(this.getUserMessageText(event.message))) {
            this.addMessageToChat(event.message);
          }
          this.updatePendingMessagesDisplay();
          this.ui.requestRender();
        } else if (event.message.role === "assistant") {
          this.streamingComponent = new AssistantMessageComponent(
            undefined,
            this.hideThinkingBlock,
            this.getMarkdownThemeWithSettings(),
            this.hiddenThinkingLabel,
            this.outputPad,
          );
          this.streamingMessage = event.message;
          this.chatContainer.addChild(this.streamingComponent);
          this.streamingComponent.updateContent(this.streamingMessage);
          this.ui.requestRender();
        }
        break;

      case "message_update":
        if (this.streamingComponent && event.message.role === "assistant") {
          this.streamingMessage = event.message;
          this.streamingComponent.updateContent(this.streamingMessage);

          for (const content of this.streamingMessage.content) {
            if (content.type === "toolCall") {
              if (!this.pendingTools.has(content.id)) {
                const component = new ToolExecutionComponent(
                  content.name,
                  content.id,
                  content.arguments,
                  {
                    showImages: this.settingsManager.getShowImages(),
                    imageWidthCells: this.settingsManager.getImageWidthCells(),
                  },
                  this.getRegisteredToolDefinition(content.name),
                  this.ui,
                  this.sessionManager.getCwd(),
                );
                component.setExpanded(this.toolOutputExpanded);
                this.chatContainer.addChild(component);
                this.pendingTools.set(content.id, component);
              } else {
                const component = this.pendingTools.get(content.id);
                if (component) {
                  component.updateArgs(content.arguments);
                }
              }
            }
          }
          this.ui.requestRender();
        }
        break;

      case "message_end":
        if (event.message.role === "user") break;
        if (this.streamingComponent && event.message.role === "assistant") {
          this.streamingMessage = event.message;
          let errorMessage: string | undefined;
          if (this.streamingMessage.stopReason === "aborted") {
            const existingAbortMessage =
              this.streamingMessage.errorMessage && this.streamingMessage.errorMessage !== "Request was aborted"
                ? this.streamingMessage.errorMessage
                : undefined;
            const retryAttempt = this.session.retryAttempt;
            errorMessage = existingAbortMessage ?? (
              retryAttempt > 0
                ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
                : "Operation aborted"
            );
            this.streamingMessage.errorMessage = errorMessage;
          }
          this.streamingComponent.updateContent(this.streamingMessage);

          if (
            this.streamingMessage.stopReason === "aborted" ||
            this.streamingMessage.stopReason === "error"
  ) {
            if (!errorMessage) {
              errorMessage = this.streamingMessage.errorMessage || "Error";
            }
            for (const [, component] of this.pendingTools.entries()) {
              component.updateResult({
                content: [{ type: "text", text: errorMessage }],
                isError: true,
              });
            }
            this.pendingTools.clear();
          } else {
            // Args are now complete - trigger diff computation for edit tools
            for (const [, component] of this.pendingTools.entries()) {
              component.setArgsComplete();
            }
          }
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
          this.footer.invalidate();
        }
        this.ui.requestRender();
        break;

      case "tool_execution_start": {
        let component = this.pendingTools.get(event.toolCallId);
        if (!component) {
          component = new ToolExecutionComponent(
            event.toolName,
            event.toolCallId,
            event.args,
            {
              showImages: this.settingsManager.getShowImages(),
              imageWidthCells: this.settingsManager.getImageWidthCells(),
            },
            this.getRegisteredToolDefinition(event.toolName),
            this.ui,
            this.sessionManager.getCwd(),
          );
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
          this.pendingTools.set(event.toolCallId, component);
        }
        component.markExecutionStarted();
        this.ui.requestRender();
        break;
      }

      case "tool_execution_update": {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult(
            { ...event.partialResult, isError: false },
            true,
          );
          this.ui.requestRender();
        }
        break;
      }

      case "tool_execution_end": {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult({ ...event.result, isError: event.isError });
          this.pendingTools.delete(event.toolCallId);
          this.ui.requestRender();
        }
        break;
      }

      case "agent_end":
        if (this.settingsManager.getShowTerminalProgress()) {
          this.ui.terminal.setProgress(false);
        }
        if (this.loadingAnimation) {
          this.loadingAnimation.stop();
          this.loadingAnimation = undefined;
          this.statusContainer.clear();
        }
        if (this.streamingComponent) {
          this.chatContainer.removeChild(this.streamingComponent);
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
        }
        this.pendingTools.clear();

		if (this.pendingLoadedResourcesDisclosure) {
			this.pendingLoadedResourcesDisclosure = false;
			this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
			this.showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true, targetContainer: this.startupNoticesContainer });
			// Keep the subscription warning after the RESOURCES disclosure.
			void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, this.startupNoticesContainer);
		}
        await this.checkShutdownRequested();

        this.ui.requestRender();
        break;

      case "compaction_start": {
        if (this.settingsManager.getShowTerminalProgress()) {
          this.ui.terminal.setProgress(true);
        }
        // Keep editor active; submissions are queued during compaction.
        this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          this.session.abortCompaction();
        };
        this.statusContainer.clear();
        const cancelHint = `(${keyText("app.interrupt")} Cancel)`;
        const isOverflowAutoCompaction = event.reason === "overflow";
        const label =
          event.reason === "manual"
            ? `Compacting context... ${cancelHint}`
            : `${isOverflowAutoCompaction ? "Context overflow detected. " : ""}Auto-compacting... ${cancelHint}`;
        this.autoCompactionLoader = new Loader(
          this.ui,
          (spinner) => theme.fg("accent", spinner),
          (text) => theme.fg(isOverflowAutoCompaction ? "warning" : "muted", text),
          label,
        );
        this.statusContainer.addChild(this.autoCompactionLoader);
        this.ui.requestRender();
        break;
      }

      case "compaction_end": {
        if (this.settingsManager.getShowTerminalProgress()) {
          this.ui.terminal.setProgress(false);
        }
        if (this.autoCompactionEscapeHandler) {
          this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
          this.autoCompactionEscapeHandler = undefined;
        }
        if (this.autoCompactionLoader) {
          this.autoCompactionLoader.stop();
          this.autoCompactionLoader = undefined;
          this.statusContainer.clear();
        }
        if (event.aborted) {
          if (event.reason === "manual") {
            this.showError("Compaction cancelled");
          } else {
            this.showStatus("Auto-compaction cancelled");
          }
        } else if (event.result) {
          this.chatContainer.clear();
          this.rebuildChatFromMessages();
          this.addContextCompactionSummaryToChat(event.result as ContextCompactionResult);
          this.footer.invalidate();
        } else if (event.errorMessage) {
          if (event.reason === "manual") {
            this.showError(event.errorMessage);
          } else {
            this.chatContainer.addChild(new Spacer(1));
            this.chatContainer.addChild(
              new Text(theme.fg("error", event.errorMessage), 1, 0),
            );
          }
        }
        void this.flushCompactionQueue({ willRetry: event.willRetry });
        this.ui.requestRender();
        break;
      }

      case "context_compaction_start": {
        if (this.settingsManager.getShowTerminalProgress()) {
          this.ui.terminal.setProgress(true);
        }
        this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          this.session.abortCompaction();
        };
        this.statusContainer.clear();
        const cancelHint = `(${keyText("app.interrupt")} Cancel)`;
        this.autoCompactionLoader = new Loader(
          this.ui,
          (spinner) => theme.fg("accent", spinner),
          (text) => theme.fg("muted", text),
          `Compacting context... ${cancelHint}`,
        );
        this.statusContainer.addChild(this.autoCompactionLoader);
        this.ui.requestRender();
        break;
      }

      case "context_compaction_end": {
        if (this.settingsManager.getShowTerminalProgress()) {
          this.ui.terminal.setProgress(false);
        }
        if (this.autoCompactionEscapeHandler) {
          this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
          this.autoCompactionEscapeHandler = undefined;
        }
        if (this.autoCompactionLoader) {
          this.autoCompactionLoader.stop();
          this.autoCompactionLoader = undefined;
          this.statusContainer.clear();
        }
        if (event.aborted) {
          this.showError("Context compaction cancelled");
        } else if (event.result) {
          this.chatContainer.clear();
          this.rebuildChatFromMessages();
          this.addContextCompactionSummaryToChat(event.result);
          this.footer.invalidate();
        } else if (event.errorMessage) {
          this.showError(event.errorMessage);
        }
        void this.flushCompactionQueue({ willRetry: event.willRetry });
        this.ui.requestRender();
        break;
      }

      case "auto_retry_start": {
        // Set up escape to abort retry
        this.retryEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          this.session.abortRetry();
        };
        // Show retry indicator
        this.statusContainer.clear();
        this.retryCountdown?.dispose();
        const retryMessage = (seconds: number) =>
          `Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} Cancel)`;
        this.retryLoader = new Loader(
          this.ui,
          (spinner) => theme.fg("warning", spinner),
          (text) => theme.fg("muted", text),
          retryMessage(Math.ceil(event.delayMs / 1000)),
        );
        this.retryCountdown = new CountdownTimer(
          event.delayMs,
          this.ui,
          (seconds) => {
            this.retryLoader?.setMessage(retryMessage(seconds));
          },
          () => {
            this.retryCountdown = undefined;
          },
        );
        this.statusContainer.addChild(this.retryLoader);
        this.ui.requestRender();
        break;
      }

      case "auto_retry_end": {
        // Restore escape handler
        if (this.retryEscapeHandler) {
          this.defaultEditor.onEscape = this.retryEscapeHandler;
          this.retryEscapeHandler = undefined;
        }
        if (this.retryCountdown) {
          this.retryCountdown.dispose();
          this.retryCountdown = undefined;
        }
        // Stop loader
        if (this.retryLoader) {
          this.retryLoader.stop();
          this.retryLoader = undefined;
          this.statusContainer.clear();
        }
        // Show error only on final failure (success shows normal response)
        if (!event.success) {
          this.showError(
            `Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
          );
        }
        this.ui.requestRender();
        break;
      }

      case "agent_continue_error": {
        this.showError(event.errorMessage);
        this.ui.requestRender();
        break;
      }
    }
  };

InteractiveModeBase.prototype.getUserMessageText = function(this: InteractiveModeBase, message: Message): string {
    if (message.role !== "user") return "";
    const textBlocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.filter((c: { type: string }) => c.type === "text");
    return textBlocks.map((c) => (c as { text: string }).text).join("");
  };
