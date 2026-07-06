import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type ExtensionCommandContext, Loader, Spacer, APP_NAME, MissingSessionCwdError, SessionManager, keyText, SessionSelectorComponent, TreeSelectorComponent, TrustSelectorComponent, hasTrustRequiringProjectResources, ProjectTrustStore, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.handleCloneCommand = async function(this: InteractiveModeBase): Promise<void> {
    const leafId = this.sessionManager.getLeafId();
    if (!leafId) {
      this.showStatus("Nothing to clone yet");
      return;
    }

    try {
      const result = await this.runtimeHost.fork(leafId, { position: "at" });
      if (result.cancelled) {
        this.ui.requestRender();
        return;
      }

      this.renderCurrentSessionState();
      this.editor.setText("");
      this.showStatus("Cloned to new session");
    } catch (error: unknown) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  };

InteractiveModeBase.prototype.maybeSaveImplicitProjectTrustAfterReload = function(this: InteractiveModeBase): boolean {
    const cwd = this.sessionManager.getCwd();
    if (this.autoTrustOnReloadCwd !== cwd) {
      return false;
    }
    if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
      return false;
    }

    const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
    try {
      if (trustStore.get(cwd) !== null) {
        this.autoTrustOnReloadCwd = undefined;
        return false;
      }
      trustStore.set(cwd, true);
      this.autoTrustOnReloadCwd = undefined;
      return true;
    } catch (error) {
      this.showWarning(
        `Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

InteractiveModeBase.prototype.showTrustSelector = function(this: InteractiveModeBase): void {
    const cwd = this.sessionManager.getCwd();
    const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
    const savedDecision = trustStore.getEntry(cwd);
    this.showSelector((done) => {
      const selector = new TrustSelectorComponent({
        cwd,
        savedDecision,
        projectTrusted: this.settingsManager.isProjectTrusted(),
        onSelect: (selection) => {
          trustStore.setMany(selection.updates);
          done();
          this.showStatus(
            `Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
          );
        },
        onCancel: () => {
          done();
          this.ui.requestRender();
        },
      });
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showTreeSelector = function(this: InteractiveModeBase, initialSelectedId?: string): void {
    const tree = this.sessionManager.getTree();
    const realLeafId = this.sessionManager.getLeafId();
    const initialFilterMode = this.settingsManager.getTreeFilterMode();

    if (tree.length === 0) {
      this.showStatus("No entries in session");
      return;
    }

    this.showSelector((done) => {
      const selector = new TreeSelectorComponent(
        tree,
        realLeafId,
        this.ui.terminal.rows,
        async (entryId) => {
          // Selecting the current leaf is a no-op (already there)
          if (entryId === realLeafId) {
            done();
            this.showStatus("Already at this point");
            return;
          }

          // Ask about summarization
          done(); // Close selector first

          // Loop until user makes a complete choice or cancels to tree
          let wantsSummary = false;
          let customInstructions: string | undefined;

          // Check if we should skip the prompt (user preference to always default to no summary)
          if (!this.settingsManager.getBranchSummarySkipPrompt()) {
            while (true) {
              const summaryChoice = await this.showExtensionSelector(
                "Summarize branch?",
                ["No summary", "Summarize", "Summarize with custom prompt"],
              );

              if (summaryChoice === undefined) {
                // User pressed escape - re-show tree selector with same selection
                this.showTreeSelector(entryId);
                return;
              }

              wantsSummary = summaryChoice !== "No summary";

              if (summaryChoice === "Summarize with custom prompt") {
                customInstructions = await this.showExtensionEditor(
                  "Custom summarization instructions",
                );
                if (customInstructions === undefined) {
                  // User cancelled - loop back to summary selector
                  continue;
                }
              }

              // User made a complete choice
              break;
            }
          }

          // Set up escape handler and loader if summarizing
          let summaryLoader: Loader | undefined;
          const originalOnEscape = this.defaultEditor.onEscape;

          if (wantsSummary) {
            this.defaultEditor.onEscape = () => {
              this.session.abortBranchSummary();
            };
            this.chatContainer.addChild(new Spacer(1));
            summaryLoader = new Loader(
              this.ui,
              (spinner) => theme.fg("accent", spinner),
              (text) => theme.fg("muted", text),
              `Summarizing branch... (${keyText("app.interrupt")} Cancel)`,
            );
            this.statusContainer.addChild(summaryLoader);
            this.ui.requestRender();
          }

          try {
            const result = await this.session.navigateTree(entryId, {
              summarize: wantsSummary,
              customInstructions,
            });

            if (result.aborted) {
              // Summarization aborted - re-show tree selector with same selection
              this.showStatus("Branch summarization cancelled");
              this.showTreeSelector(entryId);
              return;
            }
            if (result.cancelled) {
              this.showStatus("Navigation cancelled");
              return;
            }

            // Update UI
            this.chatContainer.clear();
            this.renderInitialMessages();
            if (result.editorText && !this.editor.getText().trim()) {
              this.editor.setText(result.editorText);
            }
            this.showStatus("Navigated to selected point");
            void this.flushCompactionQueue({ willRetry: false });
          } catch (error) {
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            if (summaryLoader) {
              summaryLoader.stop();
              this.statusContainer.clear();
            }
            this.defaultEditor.onEscape = originalOnEscape;
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
          this.ui.requestRender();
        },
        initialSelectedId,
        initialFilterMode,
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showSessionSelector = function(this: InteractiveModeBase): void {
    this.showSelector((done) => {
      const selector = new SessionSelectorComponent(
        (onProgress) =>
          SessionManager.list(
            this.sessionManager.getCwd(),
            this.sessionManager.getSessionDir(),
            onProgress,
          ),
        (onProgress) =>
          this.sessionManager.usesDefaultSessionDir()
            ? SessionManager.listAll(onProgress)
            : SessionManager.listAll(
                this.sessionManager.getSessionDir(),
                onProgress,
              ),
        async (sessionPath) => {
          done();
          await this.handleResumeSession(sessionPath);
        },
        () => {
          done();
          this.ui.requestRender();
        },
        () => {
          void this.shutdown();
        },
        () => this.ui.requestRender(),
        {
          renameSession: async (
            sessionFilePath: string,
            nextName: string | undefined,
          ) => {
            const next = (nextName ?? "").trim();
            if (!next) return;
            const mgr = SessionManager.open(sessionFilePath);
            mgr.appendSessionInfo(next);
          },
          showRenameHint: true,
          keybindings: this.keybindings,
        },

        this.sessionManager.getSessionFile(),
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.handleResumeSession = async function(this: InteractiveModeBase, sessionPath: string, options?: Parameters<ExtensionCommandContext["switchSession"]>[1]): Promise<{ cancelled: boolean }> {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();
    try {
      const result = await this.runtimeHost.switchSession(sessionPath, {
        withSession: options?.withSession,
        projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
      });
      if (result.cancelled) {
        return result;
      }
      this.renderCurrentSessionState();
      if (this.firstRunNoticeVisible) {
        this.clearFirstRunOnboardingUi();
      }
      this.showStatus("Resumed session");
      return result;
    } catch (error: unknown) {
      if (error instanceof MissingSessionCwdError) {
        const selectedCwd = await this.promptForMissingSessionCwd(error);
        if (!selectedCwd) {
          this.showStatus("Resume cancelled");
          return { cancelled: true };
        }
        const result = await this.runtimeHost.switchSession(sessionPath, {
          cwdOverride: selectedCwd,
          withSession: options?.withSession,
          projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
        });
        if (result.cancelled) {
          return result;
        }
        this.renderCurrentSessionState();
        if (this.firstRunNoticeVisible) {
          this.clearFirstRunOnboardingUi();
        }
        this.showStatus("Resumed session in current cwd");
        return result;
      }
      return this.handleFatalRuntimeError("Failed to resume session", error);
    }
  };
