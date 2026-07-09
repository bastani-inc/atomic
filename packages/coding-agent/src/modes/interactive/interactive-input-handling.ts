import { InteractiveModeBase, seedStartupInput } from "./interactive-mode-base.ts";
import { pasteClipboardImageToEditor, recordTimeSinceReset } from "./interactive-mode-deps.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";

InteractiveModeBase.prototype.runUserPromptTurn = async function(this: InteractiveModeBase, userInput: string): Promise<void> {
    // Show the working spinner immediately on submit so there is no visible gap
    // while prompt preflight runs before the agent emits `agent_start`.
    this.showWorkingLoaderNow();
    const deferredStartupAlreadyRunning = this.deferredStartupPromise !== undefined;
    if (deferredStartupAlreadyRunning) {
      this.deferLoadedResourcesDisclosureUntilAgentEnd = true;
    }
    // Yield once so the freshly-mounted spinner paints before synchronous
    // preflight work can block the event loop.
    await yieldToEventLoop();
    try {
      if (deferredStartupAlreadyRunning) {
        await this.ensureDeferredStartupComplete();
      }
      await this.session.prompt(userInput);
      this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
      if (this.pendingLoadedResourcesDisclosure) {
        this.pendingLoadedResourcesDisclosure = false;
        this.showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true, targetContainer: this.startupNoticesContainer });
        void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, this.startupNoticesContainer);
      }
    } catch (error: unknown) {
      this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
      this.discardDeferredRenderedUserInput(userInput);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      this.showError(errorMessage);
    } finally {
      // A submission that resolves without starting an agent turn (e.g. an
      // extension slash-command) never emits `agent_end`, so clear the
      // pre-shown spinner here when idle to avoid a lingering indicator.
      if (!this.session.isStreaming) {
        this.stopWorkingLoader();
      }
    }
  };

InteractiveModeBase.prototype.setupKeyHandlers = function(this: InteractiveModeBase): void {
    this.ui.addInputListener((data) => {
      if (!this.keybindings.matches(data, "app.clear")) return undefined;
      if (this.ui.hasOverlay()) return undefined;
      this.handleCtrlC();
      this.ui.requestRender();
      return { consume: true };
    });

    // Set up handlers on defaultEditor - they use this.editor for text access
    // so they work correctly regardless of which editor is active
    this.defaultEditor.onEscape = () => {
      if (this.session.isStreaming) {
        this.restoreQueuedMessagesToEditor({ abort: true });
      } else if (this.session.isBashRunning) {
        this.session.abortBash();
      } else if (this.isBashMode) {
        this.editor.setText("");
        this.isBashMode = false;
        this.updateEditorBorderColor();
      } else if (!this.editor.getText().trim()) {
        // Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
        const action = this.settingsManager.getDoubleEscapeAction();
        if (action !== "none") {
          const now = Date.now();
          if (now - this.lastEscapeTime < 500) {
            if (action === "tree") {
              this.showTreeSelector();
            } else {
              this.showUserMessageSelector();
            }
            this.lastEscapeTime = 0;
          } else {
            this.lastEscapeTime = now;
          }
        }
      }
    };

    // Register app action handlers
    this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
    this.defaultEditor.onCtrlD = () => this.handleCtrlD();
    this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
    this.defaultEditor.onAction("app.thinking.cycle", () =>
      this.cycleThinkingLevel(),
    );
    this.defaultEditor.onAction("app.model.cycleForward", () => {
      void (async () => {
        await this.ensureDeferredStartupComplete();
        await this.cycleModel("forward");
      })();
    });
    this.defaultEditor.onAction("app.model.cycleBackward", () => {
      void (async () => {
        await this.ensureDeferredStartupComplete();
        await this.cycleModel("backward");
      })();
    });

    // Global debug handler on TUI (works regardless of focus)
    this.ui.onDebug = () => this.handleDebugCommand();
    this.defaultEditor.onAction("app.model.select", () => {
      void (async () => {
        await this.ensureDeferredStartupComplete();
        this.showModelSelector();
      })();
    });
    this.defaultEditor.onAction("app.tools.expand", () =>
      this.toggleToolOutputExpansion(),
    );
    this.defaultEditor.onAction("app.thinking.toggle", () =>
      this.toggleThinkingBlockVisibility(),
    );
    this.defaultEditor.onAction("app.editor.external", () =>
      this.openExternalEditor(),
    );
    this.defaultEditor.onAction("app.message.followUp", () =>
      this.handleFollowUp(),
    );
    this.defaultEditor.onAction("app.message.dequeue", () =>
      this.handleDequeue(),
    );
    this.defaultEditor.onAction("app.session.new", () =>
      this.handleClearCommand(),
    );
    this.defaultEditor.onAction("app.session.tree", () =>
      this.showTreeSelector(),
    );
    this.defaultEditor.onAction("app.session.fork", () =>
      this.showUserMessageSelector(),
    );
    this.defaultEditor.onAction("app.session.resume", () =>
      this.showSessionSelector(),
    );

    this.defaultEditor.onChange = (text: string) => {
      const wasBashMode = this.isBashMode;
      this.isBashMode = text.trimStart().startsWith("!");
      if (wasBashMode !== this.isBashMode) {
        this.updateEditorBorderColor();
      }
    };

    // Handle clipboard image paste (triggered on Ctrl+V)
    this.defaultEditor.onPasteImage = () => {
      this.handleClipboardImagePaste();
    };
  };

InteractiveModeBase.prototype.handleClipboardImagePaste = async function(this: InteractiveModeBase): Promise<void> {
    await pasteClipboardImageToEditor(this.editor, () => this.ui.requestRender(), {
      showWarning: (message) => this.showWarning(message),
    });
  };

InteractiveModeBase.prototype.deliverStartupReplayPrompt = function(this: InteractiveModeBase, text: string): void {
    if (this.onInputCallback) {
      if (!text.startsWith("/")) {
        this.renderDeferredUserInput(text);
      }
      const callback = this.onInputCallback;
      this.onInputCallback = undefined;
      callback(text);
    } else {
      this.pendingUserInputs.push(text);
    }
  };

InteractiveModeBase.prototype.recoverCookedStartupInput = function(this: InteractiveModeBase): boolean {
    if (this.startupCookedInputRecovered || this.pendingUserInputs.length > 0) return true;
    const text = this.editor.getText();
    const cookedLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const isCommandLike = (line: string | undefined) =>
      line !== undefined && (line.startsWith("/") || line.startsWith("!"));
    const singleCommandLike = cookedLines.length === 1 && isCommandLike(cookedLines[0]);
    if (cookedLines.length < 2 && !singleCommandLike) return false;

    this.startupCookedInputRecovered = true;
    const activeInput = this.startupReplayActiveInput?.trim();
    let draftText = "";
    let submissions = cookedLines;
    if (
      activeInput === undefined &&
      cookedLines.length > 1 &&
      !isCommandLike(cookedLines[cookedLines.length - 1]) &&
      (!isCommandLike(cookedLines[0]) || cookedLines.length > 2)
    ) {
      draftText = cookedLines[cookedLines.length - 1] ?? "";
      submissions = cookedLines.slice(0, -1);
    } else if (activeInput && cookedLines.length > 1 && !isCommandLike(cookedLines[cookedLines.length - 1])) {
      draftText = cookedLines[cookedLines.length - 1] ?? "";
      submissions = cookedLines.slice(0, -1);
    }
    if (submissions.length === 0) return true;

    if (activeInput) {
      const queuedSubmissions =
        submissions[0] === activeInput ? submissions.slice(1) : submissions;
      this.editor.setText(draftText);
      this.startupReplayInputs.push(...queuedSubmissions);
      return true;
    }

    this.editor.setText("");
    seedStartupInput(this.pendingUserInputs, this.editor, { text: draftText, submissions }, this.startupReplayInputs, (draft) => {
      this.startupDraftText = draft;
    }, (active) => {
      this.startupReplayActiveInput = active;
    });
    return true;
  };

InteractiveModeBase.prototype.drainStartupReplayCommands = async function(this: InteractiveModeBase): Promise<void> {
    while (this.pendingUserInputs.length === 0 && this.startupReplayActiveInput) {
      const activeInput = this.startupReplayActiveInput;
      await this.defaultEditor.onSubmit?.(activeInput);
      if (this.editor.getText().trim() === activeInput.trim()) {
        this.editor.setText("");
      }
      if (this.startupReplayActiveInput?.trim() === activeInput.trim()) break;
    }
  };

InteractiveModeBase.prototype.advanceStartupInputReplay = function(this: InteractiveModeBase, submittedText: string): void {
    if (this.startupReplayActiveInput?.trim() !== submittedText.trim()) return;
    this.startupReplayActiveInput = undefined;

    while (this.startupReplayInputs.length > 0) {
      const nextInput = this.startupReplayInputs.shift();
      if (nextInput === undefined) break;
      const trimmed = nextInput.trimStart();
      if (trimmed.startsWith("/") || trimmed.startsWith("!")) {
        this.startupReplayActiveInput = nextInput.trim();
        this.editor.setText(this.startupReplayActiveInput);
        this.ui.requestRender();
        return;
      }
      this.deliverStartupReplayPrompt(nextInput);
    }

    if (this.startupDraftText !== undefined) {
      this.editor.setText(this.startupDraftText);
      this.startupDraftText = undefined;
      this.ui.requestRender();
    }
  };

InteractiveModeBase.prototype.setupEditorSubmitHandler = function(this: InteractiveModeBase): void {
    this.defaultEditor.onSubmit = async (text: string) => {
      if (!this.firstSubmitRecorded) {
        this.firstSubmitRecorded = true;
        recordTimeSinceReset("interactive-first-submit");
      }
      text = text.trim();
      if (!text) return;

      if (this.startupReplayActiveInput && this.startupReplayActiveInput.trim() !== text.trim()) {
        this.startupReplayInputs.push(text);
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        return;
      }
      try {
      // Handle commands
      if (text === "/settings") {
        this.showSettingsSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/fast") {
        this.editor.setText("");
        this.showFastModeSelector();
        return;
      }
      if (text === "/scoped-models") {
        this.editor.setText("");
        await this.ensureDeferredStartupComplete();
        await this.showModelsSelector();
        return;
      }
      if (text === "/model" || text.startsWith("/model ")) {
        const searchTerm = text.startsWith("/model ")
          ? text.slice(7).trim()
          : undefined;
        this.editor.setText("");
        await this.ensureDeferredStartupComplete();
        await this.handleModelCommand(searchTerm);
        return;
      }
      if (text === "/export" || text.startsWith("/export ")) {
        await this.handleExportCommand(text);
        this.editor.setText("");
        return;
      }
      if (text === "/import" || text.startsWith("/import ")) {
        await this.handleImportCommand(text);
        this.editor.setText("");
        return;
      }
      if (text === "/share") {
        await this.handleShareCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/copy") {
        await this.handleCopyCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/name" || text.startsWith("/name ")) {
        this.handleNameCommand(text);
        this.editor.setText("");
        return;
      }
      if (text === "/session") {
        this.handleSessionCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/changelog") {
        this.handleChangelogCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/atomic" || text.startsWith("/atomic ")) {
        this.editor.setText("");
        await this.session.prompt(text);
        return;
      }
      if (text === "/hotkeys") {
        this.handleHotkeysCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/fork") {
        this.showUserMessageSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/clone") {
        this.editor.setText("");
        await this.handleCloneCommand();
        return;
      }
      if (text === "/tree") {
        this.showTreeSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/trust") {
        this.showTrustSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/login") {
        this.showOAuthSelector("login");
        this.editor.setText("");
        return;
      }
      if (text === "/logout") {
        this.showOAuthSelector("logout");
        this.editor.setText("");
        return;
      }
      if (text === "/new") {
        this.editor.setText("");
        await this.handleClearCommand();
        return;
      }
      if (/^\/compact(?:\s|$)/.test(text)) {
        this.editor.setText("");
        if (text !== "/compact") {
          this.showWarning("Usage: /compact");
          return;
        }
        await this.handleCompactCommand();
        return;
      }
      if (text === "/reload") {
        this.editor.setText("");
        await this.handleReloadCommand();
        return;
      }
      if (text === "/debug") {
        this.handleDebugCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/arminsayshi") {
        this.handleArminSaysHi();
        this.editor.setText("");
        return;
      }
      if (text === "/dementedelves") {
        this.handleDementedDelves();
        this.editor.setText("");
        return;
      }
      if (text === "/resume") {
        this.showSessionSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/quit" || text === "/exit") {
        this.editor.setText("");
        await this.shutdown();
        return;
      }

      if (text.startsWith("/") && this.deferredStartupPending) {
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        this.ui.requestRender();
        await yieldToEventLoop();
        await this.ensureDeferredStartupComplete();
        await this.session.prompt(text);
        return;
      }
      // Handle bash command (! for normal, !! for excluded from context)
      if (text.startsWith("!")) {
        const isExcluded = text.startsWith("!!");
        const command = isExcluded
          ? text.slice(2).trim()
          : text.slice(1).trim();
        if (command) {
          if (this.session.isBashRunning) {
            this.showWarning(
              "A bash command is already running. esc cancel first.",
            );
            this.editor.setText(text);
            return;
          }
          this.editor.addToHistory?.(text);
          await this.handleBashCommand(command, isExcluded);
          this.isBashMode = false;
          this.updateEditorBorderColor();
          return;
        }
      }

      // Queue input during compaction (extension commands execute immediately)
      if (this.session.isCompacting) {
        if (this.isExtensionCommand(text)) {
          this.editor.addToHistory?.(text);
          this.editor.setText("");
          await this.session.prompt(text);
        } else {
          this.queueCompactionMessage(text, "steer");
        }
        return;
      }

      // If streaming, use prompt() with steer behavior
      // This handles extension commands (execute immediately), prompt template expansion, and queueing
      if (this.session.isStreaming) {
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        await this.session.prompt(text, { streamingBehavior: "steer" });
        this.updatePendingMessagesDisplay();
        this.ui.requestRender();
        return;
      }

      // Normal message submission
      // First, move any pending bash components to chat
      this.flushPendingBashComponents();

      if (this.onInputCallback) {
        if (!text.startsWith("/")) {
          this.renderDeferredUserInput(text);
        }
        this.onInputCallback(text);
      } else {
        this.pendingUserInputs.push(text);
      }
      this.editor.addToHistory?.(text);
      } finally {
        this.advanceStartupInputReplay?.(text);
      }
    };
  };
