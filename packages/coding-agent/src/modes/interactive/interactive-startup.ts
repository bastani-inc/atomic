import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type MarkdownTheme, os, path, Markdown, Spacer, Text, spawn, APP_NAME, APP_TITLE, ENV_OFFLINE, getEnvValue, getAgentDir, VERSION, formatCodexFastModeModelLabel, shouldApplyCodexFastMode, DefaultPackageManager, isInstallTelemetryEnabled, getChangelogPath, getEntriesForVersion, getNewEntries, normalizeChangelogLinks, parseChangelog, getCwdRelativePath, getPiUserAgent, recordTimeSinceReset, ensureTool, checkForNewPiVersion, renderAtomicAnsiBanner, DynamicBorder, getMarkdownTheme, onThemeChange, theme } from "./interactive-mode-deps.ts";
import { ExpandableText } from "./interactive-mode-helpers.ts";
import { ONBOARDING_COPY } from "./interactive-onboarding.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";

InteractiveModeBase.prototype.showStartupNoticesIfNeeded = function(this: InteractiveModeBase): void {
    if (this.startupNoticesShown) {
      return;
    }
    this.startupNoticesShown = true;

    const changelogMarkdown = this.changelogMarkdown;
    if (!changelogMarkdown && !this.firstRunNoticeVisible) {
      return;
    }

    if (changelogMarkdown) {
      if (this.chatContainer.children.length > 0) {
        this.chatContainer.addChild(new Spacer(1));
      }
      this.chatContainer.addChild(new DynamicBorder());
      if (this.settingsManager.getCollapseChangelog()) {
        const versionMatch = changelogMarkdown.match(
          /##\s+\[?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha\.)?(?:0|[1-9]\d*))?)\]?/,
        );
        const latestVersion = versionMatch ? versionMatch[1] : this.version;
        const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
        this.chatContainer.addChild(new Text(condensedText, 1, 0));
      } else {
        this.chatContainer.addChild(
          new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0),
        );
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(
          new Markdown(
            changelogMarkdown.trim(),
            1,
            0,
            this.getMarkdownThemeWithSettings(),
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }
      this.chatContainer.addChild(new DynamicBorder());
    }

    if (this.firstRunNoticeVisible) {
      this.firstRunOnboardingNoticeComponents = [];
      if (this.chatContainer.children.length > 0) {
        this.firstRunOnboardingNoticeComponents.push(new Spacer(1));
      }
      this.firstRunOnboardingNoticeComponents.push(
        new DynamicBorder(),
        new Text(ONBOARDING_COPY, 1, 0),
        new DynamicBorder(),
        new Spacer(1),
      );
      for (const component of this.firstRunOnboardingNoticeComponents) {
        this.chatContainer.addChild(component);
      }
      // Mark completion only after queueing the notice in the chat canvas so
      // launches that skip rendering retry the first-run notice next time.
      this.settingsManager.setOnboardedVersion(this.version);
    }

    this.ui.requestRender();
  };

InteractiveModeBase.prototype.init = async function(this: InteractiveModeBase): Promise<void> {
    if (this.isInitialized) return;

    this.registerSignalHandlers();

    // Load changelog (only show new entries, skip for resumed sessions)
    this.hadLastChangelogVersionAtStartup = Boolean(this.settingsManager.getLastChangelogVersion());
    this.changelogMarkdown = this.getChangelogForDisplay();
    this.initializeFirstRunOnboardingMarkers();

    // Add header container as first child. Populate it after theme initialization.
    this.ui.addChild(this.headerContainer);

    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.pendingMessagesContainer);
    this.ui.addChild(this.statusContainer);
    this.renderWidgets(); // Initialize with default spacer
    this.ui.addChild(this.widgetContainerAbove);
    this.ui.addChild(this.usageMeter);
    this.ui.addChild(this.editorContainer);
    // Footer (persistent model + cwd identity) stays pinned directly under the
    // editor; below-editor widgets render after it, at the very bottom. This
    // keeps the session identity line attached to the input and places
    // transient run status (e.g. the workflow companion counter) beneath it.
    // Rendering below-editor widgets last also keeps a live widget at the
    // absolute bottom of the buffer (always within the viewport), so its
    // per-tick updates never sit above the fold — preserving the #1109
    // resize-flicker fix.
    this.ui.addChild(this.footer);
    this.ui.addChild(this.widgetContainerBelow);
    this.ui.setFocus(this.editor);

    this.setupKeyHandlers();
    this.setupEditorSubmitHandler();

    this.firstRunNoticeVisible = this.isFirstRunOnboardingEligible();

    // Start the UI before initializing extensions so session_start handlers can use interactive dialogs.
    // fd/rg readiness is intentionally checked after first paint because ensureTool may spawn
    // or download tools on cold machines.
    this.ui.start();
    recordTimeSinceReset("time-to-first-frame");
    this.isInitialized = true;

    await this.themeController.applyFromSettings();

    // Add the quiet startup identity (unless silenced). Resource details are
    // disclosed separately in the chat canvas via the tools/resources toggle.
    if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
      this.builtInHeader = new ExpandableText(
        () => this.getStartupIdentityText(),
        () => this.getStartupIdentityText(),
        this.getStartupExpansionState(),
        1,
        0,
      );

      this.headerContainer.addChild(new Spacer(1));
      this.headerContainer.addChild(this.builtInHeader);
      this.headerContainer.addChild(new Spacer(1));
    } else {
      // Minimal header when silenced
      this.builtInHeader = new Text("", 0, 0);
      this.headerContainer.addChild(this.builtInHeader);
    }
    this.ui.requestRender();

    void Promise.all([ensureTool("fd"), ensureTool("rg")])
      .then(([fdPath]) => {
        this.fdPath = fdPath;
        this.setupAutocompleteProvider();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Tool readiness check failed: ${message}`);
      });

    // When startup resources are deferred, keep the already-painted editor responsive.
    // Extension UI bindings are installed at the deferred reload boundary, not here,
    // so no post-paint resource work can block visible typing.
    if (this.deferredStartupPending) {
      this.applyRuntimeSettings();
      this.subscribeToAgent();
      this.updateEditorBorderColor();
      this.updateTerminalTitle();
    } else {
      await this.rebindCurrentSession();
    }

    // Render initial messages AFTER the initial session binding is in place.
    this.renderInitialMessages();



	if (this.deferredStartupPending) {
		setTimeout(() => {
			if (!this.deferredStartupPending || this.deferredStartupPromise) return;
			void this.ensureDeferredStartupComplete();
		}, 2000);
	}
    // Set up theme file watcher
    onThemeChange(() => {
      this.ui.invalidate();
      this.updateEditorBorderColor();
      this.ui.requestRender();
    });

    // Set up git branch watcher (uses provider instead of footer)
    this.footerDataProvider.onBranchChange(() => {
      this.ui.requestRender();
    });

    // Initialize available provider count for footer display without delaying first-frame startup.
    void this.updateAvailableProviderCount().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to update provider count: ${message}`);
    });
  };

InteractiveModeBase.prototype.updateTerminalTitle = function(this: InteractiveModeBase): void {
    const cwdBasename = path.basename(this.sessionManager.getCwd());
    const sessionName = this.sessionManager.getSessionName();
    if (sessionName) {
      this.ui.terminal.setTitle(
        `${APP_TITLE} - ${sessionName} - ${cwdBasename}`,
      );
    } else {
      this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
    }
  };

InteractiveModeBase.prototype.run = async function(this: InteractiveModeBase): Promise<void> {
    await this.init();

	setTimeout(() => {
		void this.refreshCopilotModelCatalog();
		checkForNewPiVersion(this.version).then((newVersion) => {
			if (newVersion) this.showNewVersionNotification(newVersion);
		});
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) this.showPackageUpdateNotification(updates);
		});
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) this.showWarning(warning);
		});
		void this.maybeWarnAboutAnthropicSubscriptionAuth();
	}, 500);

    // Show startup warnings
    const {
      migratedProviders,
      modelFallbackMessage,
      initialMessage,
      initialImages,
      initialMessages,
    } = this.options;

    if (migratedProviders && migratedProviders.length > 0) {
      this.showWarning(
        `Migrated credentials to auth.json: ${migratedProviders.join(", ")}`,
      );
    }

    const modelsJsonError = this.session.modelRegistry.getError();
    if (modelsJsonError) {
      this.showError(`models.json error: ${modelsJsonError}`);
    }

    if (modelFallbackMessage && !this.deferredStartupPending) {
      this.showWarning(modelFallbackMessage);
    }


    // CLI-provided startup prompts need extension tools/resources; wait before sending them,
    // but do not block the normal no-prompt input loop from becoming ready.
    if (this.deferredStartupPending && (initialMessage || (initialMessages && initialMessages.length > 0))) {
      await this.ensureDeferredStartupComplete();
    }

    // Process initial messages
    if (initialMessage) {
      try {
        await this.session.prompt(initialMessage, { images: initialImages });
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
      }
    }

    if (initialMessages) {
      for (const message of initialMessages) {
        try {
          await this.session.prompt(message);
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          this.showError(errorMessage);
        }
      }
    }

    // Main interactive loop
    while (true) {
      const userInput = await this.getUserInput();
		if (this.deferredStartupPending) {
			this.deferLoadedResourcesDisclosureUntilAgentEnd = true;
			this.setWorkingVisible(true);
			await yieldToEventLoop();
		}
      try {
        await this.ensureDeferredStartupComplete();
        await this.session.prompt(userInput);
		this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
		if (this.pendingLoadedResourcesDisclosure) {
			this.pendingLoadedResourcesDisclosure = false;
			this.showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true });
		}
      } catch (error: unknown) {
		this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
        this.discardDeferredRenderedUserInput(userInput);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
      }
    }
  };

InteractiveModeBase.prototype.checkForPackageUpdates = async function(this: InteractiveModeBase): Promise<string[]> {
    if (getEnvValue(ENV_OFFLINE)) {
      return [];
    }

    try {
      const packageManager = new DefaultPackageManager({
        cwd: this.sessionManager.getCwd(),
        agentDir: getAgentDir(),
        settingsManager: this.settingsManager,
      });
      const updates = await packageManager.checkForAvailableUpdates();
      return updates.map((update) => update.displayName);
    } catch {
      return [];
    }
  };

InteractiveModeBase.prototype.checkTmuxKeyboardSetup = async function(this: InteractiveModeBase): Promise<string | undefined> {
    if (!process.env.TMUX) return undefined;

    const runTmuxShow = (option: string): Promise<string | undefined> => {
      return new Promise((resolve) => {
        const proc = spawn("tmux", ["show", "-gv", option], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let stdout = "";
        const timer = setTimeout(() => {
          proc.kill();
          resolve(undefined);
        }, 2000);

        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.on("error", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : undefined);
        });
      });
    };

    const [extendedKeys, extendedKeysFormat] = await Promise.all([
      runTmuxShow("extended-keys"),
      runTmuxShow("extended-keys-format"),
    ]);

    // If we couldn't query tmux (timeout, sandbox, etc.), don't warn
    if (extendedKeys === undefined) return undefined;

    if (extendedKeys !== "on" && extendedKeys !== "always") {
      return "tmux extended-keys is off. Modified enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
    }

    if (extendedKeysFormat === "xterm") {
      return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
    }

    return undefined;
  };

InteractiveModeBase.prototype.getChangelogForDisplay = function(this: InteractiveModeBase): string | undefined {
    // Skip changelog for resumed/continued sessions (already have messages)
    if (this.session.state.messages.length > 0) {
      return undefined;
    }

    const lastVersion = this.settingsManager.getLastChangelogVersion();
    const changelogPath = getChangelogPath();
    const entries = parseChangelog(changelogPath);

    if (!lastVersion) {
      // Fresh install - record the version, send telemetry, don't show changelog
      this.settingsManager.setLastChangelogVersion(VERSION);
      this.reportInstallTelemetry(VERSION);
      return undefined;
    }

    const newEntries = getNewEntries(entries, lastVersion, VERSION);
    const currentEntries = getEntriesForVersion(newEntries, VERSION);
    if (currentEntries.length > 0) {
      this.settingsManager.setLastChangelogVersion(VERSION);
      this.reportInstallTelemetry(VERSION);
      return currentEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
    }

    return undefined;
  };

InteractiveModeBase.prototype.reportInstallTelemetry = function(this: InteractiveModeBase, version: string): void {
    if (getEnvValue(ENV_OFFLINE)) {
      return;
    }

    if (!isInstallTelemetryEnabled(this.settingsManager)) {
      return;
    }

    void fetch(
      `https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`,
      {
        headers: {
          "User-Agent": getPiUserAgent(version),
        },
        signal: AbortSignal.timeout(5000),
      },
    )
      .then(() => undefined)
      .catch(() => undefined);
  };

InteractiveModeBase.prototype.getMarkdownThemeWithSettings = function(this: InteractiveModeBase): MarkdownTheme {
    return {
      ...getMarkdownTheme(),
      codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
    };
  };

InteractiveModeBase.prototype.formatDisplayPath = function(this: InteractiveModeBase, p: string): string {
    const home = os.homedir();
    let result = p;

    // Replace home directory with ~
    if (result.startsWith(home)) {
      result = `~${result.slice(home.length)}`;
    }

    return result;
  };

InteractiveModeBase.prototype.formatExtensionDisplayPath = function(this: InteractiveModeBase, path: string): string {
    let result = this.formatDisplayPath(path);
    result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
    return result;
  };

InteractiveModeBase.prototype.formatContextPath = function(this: InteractiveModeBase, p: string): string {
    const cwd = path.resolve(this.sessionManager.getCwd());
    const absolutePath = path.isAbsolute(p)
      ? path.resolve(p)
      : path.resolve(cwd, p);
    const relativePath = getCwdRelativePath(absolutePath, cwd);
    if (relativePath !== undefined) {
      return relativePath;
    }

    return this.formatDisplayPath(absolutePath);
  };

InteractiveModeBase.prototype.getStartupModelLabel = function(this: InteractiveModeBase): string {
    const model = this.session.state.model;
    let modelLabel = model?.id ?? "no-model";

    if (model?.reasoning) {
      modelLabel = `${modelLabel} ${this.session.thinkingLevel || "off"}`;
    }

    if (!model) {
      return modelLabel;
    }

    const fastModeEnabled = shouldApplyCodexFastMode(
      model,
      this.session.settingsManager.getCodexFastModeSettings(),
      this.session.orchestrationContext,
    );
    return formatCodexFastModeModelLabel(modelLabel, fastModeEnabled);
  };

InteractiveModeBase.prototype.getStartupIdentityText = function(this: InteractiveModeBase): string {
    const appLabel = APP_NAME.length > 0
      ? `${APP_NAME[0]!.toUpperCase()}${APP_NAME.slice(1)}`
      : "Atomic";
    const title = `${theme.bold(theme.fg("text", appLabel))} ${theme.fg("muted", `v${this.version}`)}`;
    const model = this.session.state.model;
    const provider = model ? theme.fg("dim", `(${model.provider})`) : theme.fg("dim", "(no-provider)");
    const modelLine = `${provider} ${theme.fg("muted", this.getStartupModelLabel())}`;
    const cwd = theme.fg("muted", this.formatDisplayPath(this.sessionManager.getCwd()));
    const metaLines = [title, modelLine, cwd];
    const markLines = this.getAtomicAnsiMarkLines();

    return markLines
      .map((line, index) => `${line}  ${metaLines[index] ?? ""}`.trimEnd())
      .join("\n");
  };

InteractiveModeBase.prototype.getAtomicAnsiMarkLines = function(this: InteractiveModeBase): string[] {
    return renderAtomicAnsiBanner(theme, this.session.thinkingLevel || "off");
  };

InteractiveModeBase.prototype.getStartupExpansionState = function(this: InteractiveModeBase): boolean {
    return this.options.verbose || this.toolOutputExpanded;
  };
