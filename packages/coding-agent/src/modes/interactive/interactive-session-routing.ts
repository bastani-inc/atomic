import { dirname } from "node:path";
import { canonicalizePath } from "../../utils/paths.ts";
import { withHostProjectTrustPrompt } from "../interactive-engine/extension-ui-bridge.ts";
import { mountIdleStatus } from "./components/idle-status.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	APP_NAME,
	type ExtensionCommandContext,
	hasTrustRequiringProjectResources,
	keyText,
	Loader,
	MissingSessionCwdError,
	ProjectTrustStore,
	SessionManager,
	SessionSelectorComponent,
	Spacer,
	TreeSelectorComponent,
	TrustSelectorComponent,
	theme,
} from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.handleCloneCommand = async function (this: InteractiveModeBase): Promise<void> {
	await this.ensureDeferredStartupComplete();
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

InteractiveModeBase.prototype.maybeSaveImplicitProjectTrustAfterReload = function (this: InteractiveModeBase): boolean {
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

InteractiveModeBase.prototype.showTrustSelector = function (this: InteractiveModeBase): void {
	const cwd = this.sessionManager.getCwd();
	const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
	const savedDecision = trustStore.getEntry(cwd);
	void withHostProjectTrustPrompt(
		this.runtimeHost,
		"select",
		"Project trust",
		() =>
			new Promise<void>((resolve) => {
				this.showSelector((done) => {
					const selector = new TrustSelectorComponent({
						cwd,
						savedDecision,
						projectTrusted: this.settingsManager.isProjectTrusted(),
						onSelect: (selection) => {
							try {
								trustStore.setMany(selection.updates);
							} catch (error) {
								this.showError(error instanceof Error ? error.message : String(error));
								return;
							}
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
					return { component: selector, focus: selector, dispose: resolve };
				});
			}),
	).catch((error: Error) => this.showError(error.message));
};

InteractiveModeBase.prototype.showTreeSelector = async function (
	this: InteractiveModeBase,
	initialSelectedId?: string,
): Promise<void> {
	await this.ensureDeferredStartupComplete();
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
				// Compare against the live leaf: a response that was streaming while the
				// selector was open may have advanced it past the captured value.
				if (entryId === this.sessionManager.getLeafId()) {
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
						const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector with same selection
							this.showTreeSelector(entryId);
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.showExtensionEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}
				}

				if (this.session.isStreaming) {
					this.restoreQueuedMessagesToEditor();
					await this.session.abort();
				}
				if (this.session.isCompacting) {
					this.showError(
						"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
					);
					return;
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
					await this.ensureDeferredStartupComplete();
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
					this.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (summaryLoader) {
						summaryLoader.stop();
						this.statusContainer.clear();
						mountIdleStatus(this.statusContainer, this.settingsManager.getClearOnShrink());
					}
					this.defaultEditor.onEscape = originalOnEscape;
				}
			},
			() => {
				done();
				this.ui.requestRender();
			},
			async (entryId, label) => {
				await this.sessionManager.appendLabelChange(entryId, label);
			},
			initialSelectedId,
			initialFilterMode,
		);
		selector.onLabelError = (error) => this.showError(error.message);
		selector.onLabelUpdate = () => this.ui.requestRender();
		return { component: selector, focus: selector };
	});
};

InteractiveModeBase.prototype.showSessionSelector = function (this: InteractiveModeBase): void {
	this.showSelector((done) => {
		const selector = new SessionSelectorComponent(
			(onProgress) =>
				SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionStore(), onProgress),
			(onProgress) => SessionManager.listAll(this.sessionManager.getSessionStore(), onProgress),
			async (selected) => {
				selector.dispose();
				done();
				const directory =
					this.sessionManager.getSessionStore().descriptor.adapter === "jsonl"
						? dirname(selected.path)
						: undefined;
				await this.handleResumeSession(selected.id, undefined, directory);
			},
			() => {
				selector.dispose();
				done();
				this.ui.requestRender();
			},
			() => {
				selector.dispose();
				void this.shutdown();
			},
			() => this.ui.requestRender(),
			{
				deleteSession:
					this.sessionManager.getSessionStore().descriptor.adapter === "jsonl"
						? undefined
						: (id) => this.sessionManager.getSessionStore().delete(id),
				renameSession: async (selected, nextName) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					const store = this.sessionManager.getSessionStore();
					const directory = store.descriptor.adapter === "jsonl" ? dirname(selected.path) : undefined;
					if (
						selected.id === this.sessionManager.getSessionId() &&
						(directory === undefined ||
							canonicalizePath(directory) === canonicalizePath(this.sessionManager.getSessionDir()))
					) {
						await this.session.setSessionName(next);
					} else {
						const mgr = await this.sessionManager.openSessionById(selected.id, undefined, directory);
						try {
							await mgr.appendSessionInfo(next);
						} finally {
							if (mgr.getSessionStore() !== store) await mgr.getSessionStore().close();
						}
					}
				},
				showRenameHint: true,
				keybindings: this.keybindings,
			},

			{ id: this.sessionManager.getSessionId(), directory: this.sessionManager.getSessionDir() },
		);
		return { component: selector, focus: selector };
	});
};

InteractiveModeBase.prototype.handleResumeSession = async function (
	this: InteractiveModeBase,
	sessionId: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	sessionDirectory?: string,
): Promise<{ cancelled: boolean }> {
	await this.ensureDeferredStartupComplete();
	InteractiveModeBase.prototype.clearWorkingLoader.call(this);
	mountIdleStatus(this.statusContainer, this.settingsManager.getClearOnShrink());
	try {
		const result = await this.runtimeHost.switchSession(sessionId, {
			withSession: options?.withSession,
			sessionDirectory,
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
		this.startSessionRecovery("resume");
		return result;
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await this.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				this.showStatus("Resume cancelled");
				return { cancelled: true };
			}
			const result = await this.runtimeHost.switchSession(sessionId, {
				cwdOverride: selectedCwd,
				sessionDirectory,
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
			this.startSessionRecovery("resume");
			return result;
		}
		return this.handleFatalRuntimeError("Failed to resume session", error);
	}
};
