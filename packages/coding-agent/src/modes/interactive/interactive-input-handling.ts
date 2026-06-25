import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { pasteClipboardImageToEditor } from "./interactive-mode-deps.ts";
import { NORMAL_CHAT_TRANSITION_COPY, isCwdLocalExistingPathSeed, isExistingAbsolutePathSeed } from "./interactive-onboarding.ts";

InteractiveModeBase.prototype.setupKeyHandlers = function(this: InteractiveModeBase): void {
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
    this.defaultEditor.onAction("app.model.cycleForward", () =>
      this.cycleModel("forward"),
    );
    this.defaultEditor.onAction("app.model.cycleBackward", () =>
      this.cycleModel("backward"),
    );

    // Global debug handler on TUI (works regardless of focus)
    this.ui.onDebug = () => this.handleDebugCommand();
    this.defaultEditor.onAction("app.model.select", () =>
      this.showModelSelector(),
    );
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

InteractiveModeBase.prototype.setupEditorSubmitHandler = function(this: InteractiveModeBase): void {
    const submitFirstRunOnboardingSeed = async (text: string): Promise<void> => {
      if (this.firstRunOnboardingSeedInFlight) return;
      this.editor.addToHistory?.(text);
      this.editor.setText("");
      const readyForHandoff = typeof this.isFirstRunOnboardingReadyForHandoff === "function"
        ? this.isFirstRunOnboardingReadyForHandoff()
        : true;
      if (!readyForHandoff) {
        this.stashFirstRunOnboardingSeed(text);
        return;
      }
      this.firstRunOnboardingSeedInFlight = true;
      try {
        await this.handleOnboardingWorkflowSeed(text);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.showError(errorMessage);
        this.editor.setText(text);
      } finally {
        this.firstRunOnboardingSeedInFlight = false;
      }
    };

    this.defaultEditor.onSubmit = async (text: string) => {
      text = text.trim();
      if (!text) return;

      if (this.firstRunOnboardingActive && (text === "/chat" || text.startsWith("/chat "))) {
        const chatMessage = text.slice(5).trim();
        this.completeFirstRunOnboarding();
        this.showStatus(NORMAL_CHAT_TRANSITION_COPY);
        this.editor.setText("");
        if (!chatMessage) return;
        this.flushPendingBashComponents();
        if (this.onInputCallback) {
          this.onInputCallback(chatMessage);
        } else {
          this.pendingUserInputs.push(chatMessage);
        }
        this.editor.addToHistory?.(text);
        return;
      }

      if (this.firstRunOnboardingActive && text.startsWith("/") && (isCwdLocalExistingPathSeed(text, this.sessionManager.getCwd()) || isExistingAbsolutePathSeed(text))) {
        await submitFirstRunOnboardingSeed(text);
        return;
      }

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
        await this.showModelsSelector();
        return;
      }
      if (text === "/model" || text.startsWith("/model ")) {
        const searchTerm = text.startsWith("/model ")
          ? text.slice(7).trim()
          : undefined;
        this.editor.setText("");
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

      if (this.firstRunOnboardingActive && !text.startsWith("/")) {
        await submitFirstRunOnboardingSeed(text);
        return;
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
        this.onInputCallback(text);
      } else {
        this.pendingUserInputs.push(text);
      }
      this.editor.addToHistory?.(text);
    };
  };
