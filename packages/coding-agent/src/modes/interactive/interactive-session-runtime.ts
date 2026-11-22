import { type Component, type Container, setCapabilityOverrides } from "@bastani/atomic-tui";
import type { ExtensionBindings, SessionRecoveryReport } from "../../core/agent-session-types.js";
import { cancelInitialBinding, initialBindScope, registerInitialBindings } from "../../core/extension-startup-close.ts";
import type { SessionRecoveryReason, ToolRenderers } from "../../core/extensions/types.ts";
import { ensurePngTranscoder } from "../../utils/image-convert.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import { renderEngineDiagnostic } from "../interactive-engine/engine-diagnostic-view.js";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { promptHandle } from "./agent-view/agent-drafts.ts";
import { AtomicWorkedStatusComponent } from "./components/atomic-working-status.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { setRegisteredThemes, stopThemeWatcher, Text, theme } from "./interactive-mode-deps.ts";
import { clearChatForRerender } from "./interactive-render-chat.ts";
import { exitOnRefusedDecisionSetting } from "./refused-decision-setting.ts";

const stopRendererWatchByMode = new WeakMap<InteractiveModeBase, () => void>();

function refreshCustomMessageRenderers(
	root: Component,
	getRenderer: (
		customType: string,
	) => ReturnType<InteractiveModeBase["session"]["extensionRunner"]["getMessageRenderer"]>,
): boolean {
	let changed = false;
	const visit = (node: Component): void => {
		if (node instanceof CustomMessageComponent) {
			if (node.setCustomRenderer(getRenderer(node.customType))) changed = true;
			return;
		}
		const children = (node as Partial<Container>).children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
	};
	visit(root);
	return changed;
}

InteractiveModeBase.prototype.bindCurrentSessionExtensions = async function (this: InteractiveModeBase): Promise<void> {
	const uiContext = this.createExtensionUIContext();
	const session = this.session;
	this.runtimeHost?.setProjectTrustContextFactory?.((cwd) => this.createProjectTrustContext(cwd));
	const target = this.session;
	const bind = target.bindExtensions;
	const bindings: ExtensionBindings = {
		onUIPrompt: (event) => {
			if (!(this.runtimeHost instanceof IsolatedInteractiveRuntime) && this.session === session) {
				this.programStatus.handleUIPrompt(event);
			}
		},
		uiContext,
		mode: "tui",
		isPresentationOnly: this.runtimeHost instanceof IsolatedInteractiveRuntime,
		commandContextActions: {
			waitForIdle: () => this.session.agent.waitForIdle(),
			newSession: async (options) => {
				InteractiveModeBase.prototype.clearWorkingLoader.call(this);
				try {
					const result = await this.runtimeHost.newSession(options);
					if (!result.cancelled) {
						this.renderCurrentSessionState();
						this.ui.requestRender();
					}
					return result;
				} catch (error: unknown) {
					return this.handleFatalRuntimeError("Failed to create session", error);
				}
			},
			fork: async (entryId, options) => {
				try {
					const result = await this.runtimeHost.fork(entryId, options);
					if (!result.cancelled) {
						this.renderCurrentSessionState();
						this.editor.setText(result.selectedText ?? "");
						this.showStatus("Forked to new session");
					}
					return { cancelled: result.cancelled };
				} catch (error: unknown) {
					return this.handleFatalRuntimeError("Failed to fork session", error);
				}
			},
			navigateTree: async (targetId, options) => {
				// The navigation's text is for main's prompt, whichever agent the screen shows.
				const mainPrompt = promptHandle(this, "main");
				const result = await this.session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				if (result.cancelled) {
					return { cancelled: true };
				}

				clearChatForRerender(this);
				this.renderInitialMessages();
				if (result.editorText && !mainPrompt.getText().trim()) {
					mainPrompt.setText(result.editorText);
				}
				this.showStatus("Navigated to selected point");
				void this.flushCompactionQueue({ willRetry: false });
				return { cancelled: false };
			},
			switchSession: async (sessionPath, options) => {
				return this.handleResumeSession(sessionPath, options);
			},
			reload: async () => {
				await this.handleReloadCommand();
			},
		},
		shutdownHandler: () => {
			this.shutdownRequested = true;
			if (!this.session.isStreaming) {
				void this.shutdown();
			}
		},
		onError: (error) => {
			this.showExtensionError(error.extensionPath, error.error, error.stack);
		},
		// A user works in this session: a failing startup handler is shown like any other extension error.
		reportStartupErrors: true,
	};
	const initial = registerInitialBindings(this, session, bindings);
	const binding = Reflect.apply(bind, target, [bindings]);
	try {
		await binding;
	} catch (error) {
		if (!cancelInitialBinding(initial, binding, error)) throw error;
		return;
	}

	setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
	this.setupAutocompleteProvider();

	const extensionRunner = this.session.extensionRunner;
	this.setupExtensionShortcuts(extensionRunner);
	stopRendererWatchByMode.get(this)?.();
	stopRendererWatchByMode.delete(this);
	if (!(this.runtimeHost instanceof IsolatedInteractiveRuntime)) {
		const stopWatch = extensionRunner.onRenderersChanged?.(() => {
			if (this.isShuttingDown || this.session !== session || this.session.extensionRunner !== extensionRunner)
				return;
			if (refreshCustomMessageRenderers(this.chatContainer, (type) => extensionRunner.getMessageRenderer(type))) {
				this.ui.requestRender();
			}
		});
		if (stopWatch) stopRendererWatchByMode.set(this, stopWatch);
	}
	if (!this.deferredStartupPending && !this.initialStartupBinding) {
		this.showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}
};

InteractiveModeBase.prototype.applyRuntimeSettings = function (this: InteractiveModeBase): void {
	setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
	ensurePngTranscoder(() => {
		this.ui.invalidate();
		this.ui.requestRender();
	});
	this.setFullscreenCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
	this.setFullscreenWheelScrollLines(this.settingsManager.getFullscreenWheelScrollLines());
	this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	this.footer.setSession(this.session);
	this.usageMeter.setSession(this.session);
	this.usageMeter.setAutoCompactEnabled(this.session.autoCompactionEnabled);
	this.footerDataProvider.setCwd(this.sessionManager.getCwd());
	this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
	this.outputPad = this.settingsManager.getOutputPad();
	this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
	this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
	const editorPaddingX = this.settingsManager.getEditorPaddingX();
	const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
	this.defaultEditor.setPaddingX(editorPaddingX);
	this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
	if (this.editor !== this.defaultEditor) {
		this.editor.setPaddingX?.(editorPaddingX);
		this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
	}
};

InteractiveModeBase.prototype.rebindCurrentSession = async function (this: InteractiveModeBase): Promise<void> {
	// The session this rebind was started for. Binding extensions is async, and a
	// session replacement (startup switch, /new, resume) can install a different
	// session and start its own rebind while this one is still awaiting. Without
	// the guard below both rebinds call subscribeToAgent() and every agent event
	// is rendered twice.
	const session = this.session;

	this.unsubscribe?.();
	this.unsubscribe = undefined;
	this.programStatus.reset();
	this.applyRuntimeSettings();
	await this.bindCurrentSessionExtensions();

	const initial = initialBindScope.getStore()?.deref();
	if (initial?.cancelled && initial.mode === this && initial.session === session) return;
	if (this.session !== session) {
		// A newer rebind owns the current session; it subscribes and finishes the
		// remaining runtime updates itself.
		return;
	}

	this.subscribeToAgent();
	await this.updateAvailableProviderCount();
	this.updateEditorBorderColor();
	this.updateTerminalTitle();
};

InteractiveModeBase.prototype.handleFatalRuntimeError = async function (
	this: InteractiveModeBase,
	prefix: string,
	error: unknown,
): Promise<never> {
	const message = error instanceof Error ? error.message : String(error);
	this.showError(`${prefix}: ${message}`);
	const extensionHint = this.getCrashExtensionHint(error);
	if (extensionHint) {
		this.chatContainer.addChild(new Text(theme.fg("warning", extensionHint), this.outputPad, 0));
	}
	stopThemeWatcher();
	// A fatal exit keeps the transcript visible: the error the user just saw
	// must remain on screen after the process dies, whatever the setting says.
	this.stop("transcript");
	process.exit(1);
};

/** Shows an interactive-engine diagnostic, and stops Atomic when the engine refused a decision-model setting. */
InteractiveModeBase.prototype.handleEngineDiagnostic = function (
	this: InteractiveModeBase,
	diagnostic: ActivityWatchdogDiagnostic,
): void {
	exitOnRefusedDecisionSetting(this, diagnostic.error);
	renderEngineDiagnostic(diagnostic, {
		stopWorkingLoader: () => {
			this.workingRunMeter.stop();
			this.stopWorkingLoader();
		},
		showStatus: (message, persist) => this.showStatus(message, persist),
		showError: (message) => this.showError(message),
		showRepeatedError: (message, series) => this.showRepeatedError(message, series),
	});
};

InteractiveModeBase.prototype.renderCurrentSessionState = function (this: InteractiveModeBase): void {
	this.managedToolStatusGeneration++;
	this.managedToolStatusStarted = false;
	this.lastStatusSpacer = undefined;
	this.lastStatusText = undefined;
	clearChatForRerender(this);
	this.pendingMessagesContainer.clear();
	this.pendingBashComponents = [];
	this.compactionQueuedMessages = [];
	this.compactionSendFailed = false;
	this.streamingComponent = undefined;
	this.streamingMessage = undefined;
	this.pendingTools.clear();
	if (!this.session.isStreaming) {
		this.workingRunMeter.stop();
		this.workingMessage = undefined;
		this.lastWorkingMessage = undefined;
		for (const child of [...this.statusContainer.children]) {
			if (child instanceof AtomicWorkedStatusComponent) this.statusContainer.removeChild(child);
		}
	}
	this.renderInitialMessages();
	showRestartExtensionErrors(this);
};

/** Shows again, below the transcript a session switch or reload redrew, the extension errors reported while it ran. */
export function showRestartExtensionErrors(mode: InteractiveModeBase): void {
	const rows = mode.restartExtensionErrors ?? [];
	mode.restartExtensionErrors = undefined;
	for (const row of rows) if (!mode.chatContainer.children.includes(row)) mode.chatContainer.addChild(row);
}

function recoveryCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function formatSessionRecoveryStatus(report: SessionRecoveryReport): string | undefined {
	const parts = [
		report.replayed > 0
			? `replayed ${recoveryCount(report.replayed, "interrupted delivery", "interrupted deliveries")}`
			: "",
		report.dropped > 0 ? `skipped ${recoveryCount(report.dropped, "stale delivery", "stale deliveries")}` : "",
		report.completions > 0
			? `showed ${recoveryCount(report.completions, "background result", "background results")}`
			: "",
	].filter(Boolean);
	return parts.length > 0 ? `Recovered interrupted work: ${parts.join(", ")}` : undefined;
}

InteractiveModeBase.prototype.startSessionRecovery = function (
	this: InteractiveModeBase,
	reason: SessionRecoveryReason,
): void {
	const session = this.session;
	void session.startPendingRecovery(reason).then(
		(report) => {
			if (this.session !== session || this.isShuttingDown) return;
			const status = formatSessionRecoveryStatus(report);
			if (status) this.showStatus(status);
		},
		(error: unknown) => {
			if (this.session !== session || this.isShuttingDown) return;
			this.showError(`Session recovery failed: ${error instanceof Error ? error.message : String(error)}`);
		},
	);
};

InteractiveModeBase.prototype.getRegisteredToolDefinition = function (
	this: InteractiveModeBase,
	toolName: string,
): ToolRenderers | undefined {
	return this.session.extensionRunner.resolveToolRenderers(toolName, () => this.session.getToolDefinition(toolName));
};
