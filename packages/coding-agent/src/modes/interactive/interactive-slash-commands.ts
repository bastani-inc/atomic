import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Component, fs, os, path, Container, Markdown, Spacer, Text, spawn, spawnSync, getShareViewerUrl, SessionImportFileNotFoundError, MissingSessionCwdError, getChangelogPath, normalizeChangelogLinks, parseChangelog, copyToClipboard, BorderedLoader, DynamicBorder, setRegisteredThemes, theme } from "./interactive-mode-deps.ts";
import { isExpandable } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.handleReloadCommand = async function(this: InteractiveModeBase): Promise<void> {
    if (this.session.isStreaming) {
      this.showWarning(
        "Wait for the current response to finish before reloading.",
      );
      return;
    }
    if (this.session.isCompacting) {
      this.showWarning("Wait for compaction to finish before reloading.");
      return;
    }

    this.resetExtensionUI();

    const reloadBox = new Container();
    const borderColor = (s: string) => theme.fg("border", s);
    reloadBox.addChild(new DynamicBorder(borderColor));
    reloadBox.addChild(new Spacer(1));
    reloadBox.addChild(
      new Text(
        theme.fg(
          "muted",
          "Reloading keybindings, extensions, skills, prompts, themes...",
        ),
        1,
        0,
      ),
    );
    reloadBox.addChild(new Spacer(1));
    reloadBox.addChild(new DynamicBorder(borderColor));

    const previousEditor = this.editor;
    this.editorContainer.clear();
    this.editorContainer.addChild(reloadBox);
    this.ui.setFocus(reloadBox);
    this.ui.requestRender(true);
    await new Promise((resolve) => process.nextTick(resolve));

    const dismissReloadBox = (editor: Component) => {
      this.editorContainer.clear();
      this.editorContainer.addChild(editor);
      this.ui.setFocus(editor);
      this.ui.requestRender();
    };

    try {
      await this.session.reload();
      this.keybindings.reload();
      const activeHeader = this.customHeader ?? this.builtInHeader;
      if (isExpandable(activeHeader)) {
        activeHeader.setExpanded(this.toolOutputExpanded);
      }
      setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
      this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
      await this.themeController.applyFromSettings();
      const editorPaddingX = this.settingsManager.getEditorPaddingX();
      const autocompleteMaxVisible =
        this.settingsManager.getAutocompleteMaxVisible();
      this.defaultEditor.setPaddingX(editorPaddingX);
      this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
      if (this.editor !== this.defaultEditor) {
        this.editor.setPaddingX?.(editorPaddingX);
        this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
      }
      this.ui.setShowHardwareCursor(
        this.settingsManager.getShowHardwareCursor(),
      );
      this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
      this.setupAutocompleteProvider();
      const runner = this.session.extensionRunner;
      this.setupExtensionShortcuts(runner);
      this.rebuildChatFromMessages();
      dismissReloadBox(this.editor as Component);
      const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
      this.showLoadedResources({
        force: false,
        showDiagnosticsWhenQuiet: true,
      });
      if (savedImplicitProjectTrust) {
        this.showStatus("Saved project trust for future sessions");
      }
      const modelsJsonError = this.session.modelRegistry.getError();
      if (modelsJsonError) {
        this.showError(`models.json error: ${modelsJsonError}`);
      }
      this.showStatus(
        "Reloaded keybindings, extensions, skills, prompts, themes",
      );
    } catch (error) {
      dismissReloadBox(previousEditor as Component);
      this.showError(
        `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

InteractiveModeBase.prototype.handleExportCommand = async function(this: InteractiveModeBase, text: string): Promise<void> {
    const outputPath = this.getPathCommandArgument(text, "/export");

    try {
      if (outputPath?.endsWith(".jsonl")) {
        const filePath = this.session.exportToJsonl(outputPath);
        this.showStatus(`Session exported to: ${filePath}`);
      } else {
        const filePath = await this.session.exportToHtml(outputPath);
        this.showStatus(`Session exported to: ${filePath}`);
      }
    } catch (error: unknown) {
      this.showError(
        `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

InteractiveModeBase.prototype.getPathCommandArgument = function(this: InteractiveModeBase, text: string, command: "/export" | "/import"): string | undefined {
    if (text === command) {
      return undefined;
    }
    if (!text.startsWith(`${command} `)) {
      return undefined;
    }

    const argsString = text.slice(command.length + 1).trimStart();
    if (!argsString) {
      return undefined;
    }

    const firstChar = argsString[0];
    if (firstChar === '"' || firstChar === "'") {
      const closingQuoteIndex = argsString.indexOf(firstChar, 1);
      if (closingQuoteIndex < 0) {
        return undefined;
      }
      return argsString.slice(1, closingQuoteIndex);
    }

    const firstWhitespaceIndex = argsString.search(/\s/);
    if (firstWhitespaceIndex < 0) {
      return argsString;
    }
    return argsString.slice(0, firstWhitespaceIndex);
  };

InteractiveModeBase.prototype.handleImportCommand = async function(this: InteractiveModeBase, text: string): Promise<void> {
    const inputPath = this.getPathCommandArgument(text, "/import");
    if (!inputPath) {
      this.showError("Usage: /import <path.jsonl>");
      return;
    }

    const confirmed = await this.showExtensionConfirm(
      "Import session",
      `Replace current session with ${inputPath}?`,
    );
    if (!confirmed) {
      this.showStatus("Import cancelled");
      return;
    }

    const finishSuccessfulImport = () => {
      this.renderCurrentSessionState();
      if (this.firstRunOnboardingActive) {
        this.clearFirstRunOnboardingUi();
      }
      this.showStatus(`Session imported from: ${inputPath}`);
    };

    try {
      if (this.loadingAnimation) {
        this.loadingAnimation.stop();
        this.loadingAnimation = undefined;
      }
      this.statusContainer.clear();
      const result = await this.runtimeHost.importFromJsonl(inputPath);
      if (result.cancelled) {
        this.showStatus("Import cancelled");
        return;
      }
      finishSuccessfulImport();
    } catch (error: unknown) {
      if (error instanceof MissingSessionCwdError) {
        const selectedCwd = await this.promptForMissingSessionCwd(error);
        if (!selectedCwd) {
          this.showStatus("Import cancelled");
          return;
        }
        const result = await this.runtimeHost.importFromJsonl(
          inputPath,
          selectedCwd,
        );
        if (result.cancelled) {
          this.showStatus("Import cancelled");
          return;
        }
        finishSuccessfulImport();
        return;
      }
      if (error instanceof SessionImportFileNotFoundError) {
        this.showError(`Failed to import session: ${error.message}`);
        return;
      }
      await this.handleFatalRuntimeError("Failed to import session", error);
    }
  };

InteractiveModeBase.prototype.handleShareCommand = async function(this: InteractiveModeBase): Promise<void> {
    // Check if gh is available and logged in
    try {
      const authResult = spawnSync("gh", ["auth", "status"], {
        encoding: "utf-8",
      });
      if (authResult.status !== 0) {
        this.showError(
          "GitHub CLI is not logged in. Run 'gh auth login' first.",
        );
        return;
      }
    } catch {
      this.showError(
        "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
      );
      return;
    }

    // Export to a temp file
    const tmpFile = path.join(os.tmpdir(), "session.html");
    try {
      await this.session.exportToHtml(tmpFile);
    } catch (error: unknown) {
      this.showError(
        `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return;
    }

    // Show cancellable loader, replacing the editor
    const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
    this.editorContainer.clear();
    this.editorContainer.addChild(loader);
    this.ui.setFocus(loader);
    this.ui.requestRender();

    const restoreEditor = () => {
      loader.dispose();
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    };

    // Create a secret gist asynchronously
    let proc: ReturnType<typeof spawn> | null = null;

    loader.onAbort = () => {
      proc?.kill();
      restoreEditor();
      this.showStatus("Share cancelled");
    };

    try {
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
      }>((resolve) => {
        proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
      });

      if (loader.signal.aborted) return;

      restoreEditor();

      if (result.code !== 0) {
        const errorMsg = result.stderr?.trim() || "Unknown error";
        this.showError(`Failed to create gist: ${errorMsg}`);
        return;
      }

      // Extract gist ID from the URL returned by gh
      // gh returns something like: https://gist.github.com/username/GIST_ID
      const gistUrl = result.stdout?.trim();
      const gistId = gistUrl?.split("/").pop();
      if (!gistId) {
        this.showError("Failed to parse gist ID from gh output");
        return;
      }

      // Create the preview URL
      const previewUrl = getShareViewerUrl(gistId);
      this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
    } catch (error: unknown) {
      if (!loader.signal.aborted) {
        restoreEditor();
        this.showError(
          `Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }
  };

InteractiveModeBase.prototype.handleCopyCommand = async function(this: InteractiveModeBase): Promise<void> {
    const text = this.session.getLastAssistantText();
    if (!text) {
      this.showError("No agent messages to copy yet.");
      return;
    }

    try {
      await copyToClipboard(text);
      this.showStatus("Copied last agent message to clipboard");
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  };

InteractiveModeBase.prototype.handleNameCommand = function(this: InteractiveModeBase, text: string): void {
    const name = text.replace(/^\/name\s*/, "").trim();
    if (!name) {
      const currentName = this.sessionManager.getSessionName();
      if (currentName) {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(
          new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0),
        );
      } else {
        this.showWarning("Usage: /name <name>");
      }
      this.ui.requestRender();
      return;
    }

    this.session.setSessionName(name);
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0),
    );
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleSessionCommand = function(this: InteractiveModeBase): void {
    const stats = this.session.getSessionStats();
    const sessionName = this.sessionManager.getSessionName();

    let info = `${theme.bold("Session Info")}\n\n`;
    if (sessionName) {
      info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
    }
    info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
    info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
    info += `${theme.bold("Messages")}\n`;
    info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
    info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
    info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
    info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
    info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
    info += `${theme.bold("Tokens")}\n`;
    info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
    info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
    if (stats.tokens.cacheRead > 0) {
      info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
    }
    if (stats.tokens.cacheWrite > 0) {
      info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
    }
    info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

    if (stats.cost > 0) {
      info += `\n${theme.bold("Cost")}\n`;
      info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
    }

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(info, 1, 0));
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleChangelogCommand = function(this: InteractiveModeBase): void {
    const changelogPath = getChangelogPath();
    const allEntries = parseChangelog(changelogPath);

    const changelogMarkdown =
      allEntries.length > 0
        ? allEntries
            .reverse()
            .map((e) => normalizeChangelogLinks(e.content, e))
            .join("\n\n")
        : "No changelog entries found.";

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(
      new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0),
    );
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Markdown(
        changelogMarkdown,
        1,
        1,
        this.getMarkdownThemeWithSettings(),
      ),
    );
    this.chatContainer.addChild(new DynamicBorder());
    this.ui.requestRender();
  };
