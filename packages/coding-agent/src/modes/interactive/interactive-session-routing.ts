import { dirname } from "node:path";
import type { Focusable } from "@bastani/atomic-tui";
import { isResumeFailure } from "../../core/resume/failure.ts";
import type { SessionInfo, SessionListProgress } from "../../core/session-manager.ts";
import { worktreeRestoreNotices } from "../../core/session-worktree-snapshots.ts";
import {
	deleteWorkflowFromPicker,
	listWorkflowResumeEntries,
	resumeWorkflowFromPicker,
} from "../../core/workflow-resume.ts";
import { canonicalizePathAsync } from "../../utils/paths.ts";
import { withHostProjectTrustPrompt } from "../interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { mountIdleStatus } from "./components/idle-status.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	APP_NAME,
	type Component,
	type ExtensionCommandContext,
	getProjectTrustPathAsync,
	hasTrustRequiringProjectResourcesAsync,
	keyTextHint,
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
import type { MissingCwdForkSource } from "./interactive-mode-surface.ts";
import { showQueueRestoreFailure } from "./interactive-queueing.ts";
import { clearChatForRerender } from "./interactive-render-chat.ts";
import { onPreliminaryCatalogWithdrawn } from "./interactive-startup-trust.ts";
import { setSummaryCancellable } from "./interactive-summarization-retry-events.ts";
import { resolveResumeTarget, workflowResumeSession } from "./resume-catalog.ts";
import { showSessionNotices } from "./session-notices.ts";

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

InteractiveModeBase.prototype.maybeSaveImplicitProjectTrustAfterReload = async function (
	this: InteractiveModeBase,
): Promise<boolean> {
	const cwd = this.sessionManager.getCwd();
	if (this.autoTrustOnReloadCwd !== cwd) {
		return false;
	}
	if (!this.settingsManager.isProjectTrusted() || !(await hasTrustRequiringProjectResourcesAsync(cwd))) {
		return false;
	}

	const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
	try {
		if ((await trustStore.getAsync(cwd)) !== null) {
			this.autoTrustOnReloadCwd = undefined;
			return false;
		}
		await trustStore.setAsync(cwd, true);
		this.autoTrustOnReloadCwd = undefined;
		return true;
	} catch (error) {
		this.showWarning(
			`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
};

InteractiveModeBase.prototype.showTrustSelector = async function (this: InteractiveModeBase): Promise<void> {
	const cwd = this.sessionManager.getCwd();
	const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
	const trustData = Promise.all([trustStore.getEntryAsync(cwd), getProjectTrustPathAsync(cwd)]);
	await withHostProjectTrustPrompt(
		this.runtimeHost,
		"select",
		"Project trust",
		() =>
			new Promise<void>((resolve, reject) => {
				this.showSelector((done) => {
					const heldInput: string[] = [];
					let selector: TrustSelectorComponent | undefined;
					let focused = false;
					let closed = false;
					const view: Component & Focusable = {
						capturesViewportInput: true,
						get focused() {
							return focused;
						},
						set focused(value: boolean) {
							focused = value;
							if (selector) selector.focused = value;
						},
						render: (width) => selector?.render(width) ?? [],
						invalidate: () => selector?.invalidate(),
						handleInput: (data) => {
							if (selector) selector.handleInput(data);
							else heldInput.push(data);
						},
						handleMouse: (event) => selector?.handleMouse(event),
					};
					trustData.then(
						([savedDecision, trustPath]) => {
							if (closed) return;
							const shown = new TrustSelectorComponent({
								cwd,
								trustPath,
								savedDecision,
								projectTrusted: this.settingsManager.isProjectTrusted(),
								onSelect: (selection) => {
									trustStore.setManyAsync(selection.updates).then(
										() => {
											done();
											this.showStatus(
												`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
											);
										},
										(error: unknown) => {
											shown.selector.retrySelection();
											this.showError(error instanceof Error ? error.message : String(error));
										},
									);
								},
								onCancel: () => {
									done();
									this.ui.requestRender();
								},
							});
							shown.focused = focused;
							selector = shown;
							for (const data of heldInput.splice(0)) {
								if (closed) break;
								shown.handleInput(data);
							}
							this.ui.requestRender();
						},
						(error: unknown) => {
							reject(error);
							done();
						},
					);
					return {
						component: view,
						focus: view,
						dispose: () => {
							closed = true;
							resolve();
						},
					};
				});
			}),
	).catch((error: Error) => this.showError(error.message));
};

InteractiveModeBase.prototype.showTreeSelector = async function (
	this: InteractiveModeBase,
	initialSelectedId?: string,
): Promise<void> {
	await this.ensureDeferredStartupComplete();
	await this.sessionManager.loadFullHistory?.();
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
					// The clear goes out before the abort. The editor fills when the session answers, so a clear that
					// stalls or fails cannot hold up the abort.
					void this.restoreQueuedMessagesToEditor().catch((error: unknown) =>
						showQueueRestoreFailure(this, error),
					);
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
					setSummaryCancellable(this, true);
					this.chatContainer.addChild(new Spacer(1));
					summaryLoader = new Loader(
						this.ui,
						(spinner) => theme.fg("accent", spinner),
						(text) => theme.fg("muted", text),
						`Summarizing branch... (${keyTextHint("app.interrupt", "Cancel")})`,
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
					clearChatForRerender(this);
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
					setSummaryCancellable(this, false);
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
		const dispose = onPreliminaryCatalogWithdrawn(this, () => {
			selector.getTreeList().updateInitialFilter(this.settingsManager.getTreeFilterMode());
			this.ui.requestRender();
		});
		return { component: selector, focus: selector, dispose };
	});
};

InteractiveModeBase.prototype.showSessionSelector = function (this: InteractiveModeBase): void {
	this.showSelector((done) => {
		let closed = false;
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		let workflowCatalog: Promise<SessionInfo[]> | undefined;
		let lastWorkflowRows: SessionInfo[] = [];
		let workflowEpoch = 0;
		const invalidateWorkflowCatalog = () => {
			workflowEpoch += 1;
			workflowCatalog = undefined;
		};
		const close = () => {
			closed = true;
			invalidateWorkflowCatalog();
			clearInterval(refreshTimer);
			selector.dispose();
			done();
		};
		const workflows = () => {
			if (!workflowCatalog) {
				const requestEpoch = ++workflowEpoch;
				workflowCatalog = getResumeWorkflows(this).then(
					(rows) => {
						if (!closed && requestEpoch === workflowEpoch) {
							lastWorkflowRows = rows;
						}
						return lastWorkflowRows;
					},
					(error) => {
						if (!closed && requestEpoch === workflowEpoch) {
							workflowCatalog = undefined;
							selector.getSessionList().onError?.(error instanceof Error ? error.message : String(error));
						}
						return lastWorkflowRows;
					},
				);
			}
			return workflowCatalog;
		};
		const load = async (all: boolean, onProgress?: SessionListProgress): Promise<SessionInfo[]> => {
			let partial: readonly SessionInfo[] = [];
			const report = (loaded: number, total: number, sessions?: readonly SessionInfo[]) => {
				if (sessions) partial = sessions;
				onProgress?.(loaded + lastWorkflowRows.length, total + lastWorkflowRows.length, [
					...partial,
					...lastWorkflowRows,
				]);
			};
			const runs = workflows().then(() => {
				report(partial.length, partial.length);
			});
			const progress = this.runtimeHost ? report : onProgress;
			const sessions = all
				? SessionManager.listAll(this.sessionManager.getSessionStore(), progress)
				: SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionStore(), progress);
			const [sessionRows] = await Promise.all([sessions, runs]);
			return [...sessionRows, ...lastWorkflowRows];
		};
		const selector = new SessionSelectorComponent(
			(onProgress) => load(false, onProgress),
			(onProgress) => load(true, onProgress),
			async (selected) => {
				close();
				await resumeCatalogSelection(this, selected);
			},
			() => {
				close();
				this.ui.requestRender();
			},
			() => {
				close();
				void this.shutdown();
			},
			() => this.ui.requestRender(),
			{
				variant: "mixed",
				title: "Resume",
				deleteWorkflow: async (runId) => {
					if (this.runtimeHost instanceof IsolatedInteractiveRuntime)
						await this.runtimeHost.deleteWorkflowFromPicker(runId);
					else await deleteWorkflowFromPicker(this.session, runId);
					if (closed) return;
					invalidateWorkflowCatalog();
					lastWorkflowRows = lastWorkflowRows.filter((row) => row.id !== runId);
					void workflows().then((rows) => {
						if (!closed) selector.updateWorkflowSessions(rows);
					});
				},
				deleteSession:
					this.sessionManager.getSessionStore().descriptor.adapter === "jsonl"
						? undefined
						: (id) => this.sessionManager.deleteSession(id),
				renameSession: async (selected, nextName) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					const store = this.sessionManager.getSessionStore();
					const directory = store.descriptor.adapter === "jsonl" ? dirname(selected.path) : undefined;
					if (
						selected.id === this.sessionManager.getSessionId() &&
						(directory === undefined ||
							(await canonicalizePathAsync(directory)) ===
								(await canonicalizePathAsync(this.sessionManager.getSessionDir())))
					) {
						await this.session.setSessionName(next);
					} else {
						const mgr = await this.sessionManager.openSessionById(selected.id, undefined, directory, {
							history: "tail",
						});
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
		if (this.runtimeHost) {
			let refreshing = false;
			refreshTimer = setInterval(() => {
				if (closed || refreshing) return;
				refreshing = true;
				invalidateWorkflowCatalog();
				void workflows()
					.then((rows) => {
						if (!closed) selector.updateWorkflowSessions(rows);
					})
					.catch((error) => {
						if (!closed)
							selector.getSessionList().onError?.(error instanceof Error ? error.message : String(error));
					})
					.finally(() => {
						refreshing = false;
					});
			}, 5_000);
			refreshTimer.unref?.();
		}
		return {
			component: selector,
			focus: selector,
			dispose: () => {
				closed = true;
				invalidateWorkflowCatalog();
				clearInterval(refreshTimer);
				selector.dispose();
			},
		};
	});
};

async function getResumeWorkflows(mode: InteractiveModeBase, target?: string): Promise<SessionInfo[]> {
	if (!mode.runtimeHost) return [];
	await mode.ensureDeferredStartupComplete();
	const rows =
		mode.runtimeHost instanceof IsolatedInteractiveRuntime
			? await mode.runtimeHost.getWorkflowResumeEntries(target)
			: await listWorkflowResumeEntries(mode.session, target);
	return rows.map(workflowResumeSession);
}

async function resumeCatalogSelection(mode: InteractiveModeBase, selected: SessionInfo): Promise<void> {
	if (selected.resumeKind === "workflow") {
		try {
			const handled =
				mode.runtimeHost instanceof IsolatedInteractiveRuntime
					? await mode.runtimeHost.resumeWorkflowFromPicker(selected.id, selected.resumeSelection)
					: await resumeWorkflowFromPicker(mode.session, selected.id, selected.resumeSelection);
			if (!handled) mode.showError("Workflow resume is unavailable. Reload Atomic and try again.");
		} catch (error) {
			mode.showError(error instanceof Error ? error.message : String(error));
		}
		return;
	}
	const directory =
		mode.sessionManager.getSessionStore().descriptor.adapter === "jsonl" ? dirname(selected.path) : undefined;
	await mode.handleResumeSession(selected.id, undefined, directory);
}

InteractiveModeBase.prototype.handleResumeTarget = async function (
	this: InteractiveModeBase,
	target: string,
): Promise<void> {
	if (/\s/.test(target) || target.startsWith("-")) {
		this.showError("Usage: /resume [session-or-run-id].");
		return;
	}
	try {
		const [sessions, runs] = await Promise.allSettled([
			SessionManager.listAll(this.sessionManager.getSessionStore()),
			getResumeWorkflows(this, target),
		]);
		if (sessions.status === "rejected") throw sessions.reason;
		const resolution = resolveResumeTarget(target, [
			...sessions.value,
			...(runs.status === "fulfilled" ? runs.value : []),
		]);
		if (
			runs.status === "rejected" &&
			resolution.kind !== "ambiguous" &&
			resolution.kind !== "invalid" &&
			!(resolution.kind === "session" && resolution.session.id === target)
		)
			throw runs.reason;
		if (resolution.kind === "session" || resolution.kind === "workflow") {
			await resumeCatalogSelection(this, resolution.session);
		} else if (resolution.kind === "ambiguous") {
			this.showError(
				`Resume id "${target}" is ambiguous: ${resolution.matches.map((entry) => `${entry.resumeKind === "workflow" ? "workflow" : "session"} ${entry.id}`).join(", ")}. Use /resume to choose an entry, or provide a unique full id.`,
			);
		} else {
			this.showError(
				`No session or resumable workflow matches "${target}". Use /resume to choose an entry, or provide a full id or unique 8-character hexadecimal prefix.`,
			);
		}
	} catch (error) {
		this.showError(error instanceof Error ? error.message : String(error));
	}
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
	const resumeStartedAt = new Date().toISOString();
	try {
		const result = await this.runtimeHost.switchSession(sessionId, {
			withSession: options?.withSession,
			sessionDirectory,
			projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			history: "tail",
		});
		if (result.cancelled) {
			return result;
		}
		this.renderCurrentSessionState();
		if (this.firstRunNoticeVisible) {
			this.clearFirstRunOnboardingUi();
		}
		this.showStatus("Resumed session");
		showSessionNotices(this, [
			...worktreeRestoreNotices(this.sessionManager, resumeStartedAt),
			...this.runtimeHost.takeResumeNotices(),
		]);
		this.startSessionRecovery("resume");
		return result;
	} catch (error: unknown) {
		if (isResumeFailure(error)) {
			this.showError(error.message);
			return { cancelled: true };
		}
		if (error instanceof MissingSessionCwdError) {
			switch (await this.promptForMissingSessionCwd(error)) {
				case "continue": {
					const result = await this.runtimeHost.switchSession(sessionId, {
						cwdOverride: error.issue.fallbackCwd,
						sessionDirectory,
						withSession: options?.withSession,
						projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
						history: "tail",
					});
					if (!result.cancelled) finishMissingCwdResume(this, `Resumed session in ${error.issue.fallbackCwd}`);
					return result;
				}
				case "fork":
					return this.switchToForkedSession({ sessionId, sessionDirectory }, error.issue.fallbackCwd, options);
				case undefined:
					this.showStatus("Resume cancelled");
					return { cancelled: true };
			}
		}
		return this.handleFatalRuntimeError("Failed to resume session", error);
	}
};

function finishMissingCwdResume(mode: InteractiveModeBase, status: string): void {
	mode.renderCurrentSessionState();
	if (mode.firstRunNoticeVisible) {
		mode.clearFirstRunOnboardingUi();
	}
	mode.showStatus(status);
	mode.startSessionRecovery("resume");
}

async function forkIntoActiveStore(
	mode: InteractiveModeBase,
	source: MissingCwdForkSource,
	cwd: string,
): Promise<SessionManager> {
	const store = mode.sessionManager.getSessionStore();
	if ("exportPath" in source) return SessionManager.forkFrom(source.exportPath, cwd, store);
	const stored = await mode.sessionManager.openSessionById(source.sessionId, undefined, source.sessionDirectory);
	try {
		return await stored.forkTo(cwd, store);
	} finally {
		if (stored.getSessionStore() !== store) await stored.getSessionStore().close();
	}
}

/**
 * Fork a session whose stored cwd is gone into `cwd`, in the store the current session lives in, and switch to the
 * fork. An extension that cancels the switch leaves no copy behind.
 */
InteractiveModeBase.prototype.switchToForkedSession = async function (
	this: InteractiveModeBase,
	source: MissingCwdForkSource,
	cwd: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
	const forkId = (await forkIntoActiveStore(this, source, cwd)).getSessionId();
	const result = await this.runtimeHost.switchSession(forkId, {
		withSession: options?.withSession,
		projectTrustContextFactory: (forkCwd) => this.createProjectTrustContext(forkCwd),
		history: "tail",
	});
	if (result.cancelled) {
		await this.sessionManager.deleteSession(forkId);
		return result;
	}
	finishMissingCwdResume(this, `Forked into new session ${forkId} in ${cwd}`);
	return result;
};
