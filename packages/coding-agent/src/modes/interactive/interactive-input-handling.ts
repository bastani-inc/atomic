import { bindBundledHintCommands, isHintActivation, isKeyRelease, Text } from "@bastani/atomic-tui";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { parseSlashCommand } from "../../core/slash-commands.js";
import { sourceError } from "../../core/tasks/agent-panel-source.ts";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { stopAllBackgroundWork } from "../../core/tasks/stop-all.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import {
	getInteractiveEngineRemoteCommands,
	interactiveEngineNeedsExplicitTermination,
	interruptBlockedInteractiveEngine,
	terminateInteractiveEngine,
} from "../interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import {
	dismissRemoteProxy,
	remoteEngineProxyOwner,
	remoteProxyHandlesCtrlC,
} from "../interactive-engine/remote-input-ownership.ts";
import { agentPanelCounts, agentPanelHasRows, showAgentPanel } from "../rpc/agent-panel-bridge.ts";
import {
	agentPanelBoardSource,
	openWaitedShellOf,
	showTaskInspector,
	type TaskInspectorUi,
} from "../rpc/task-ui-bridge.js";
import { setAgentPanelFocuser } from "./agent-panel-focus.ts";
import { type PromptHandle, promptHandle } from "./agent-view/agent-drafts.ts";
import { gateMovedDraft } from "./agent-view/viewed-commands.ts";
import { viewedAgentBackKeyList } from "./agent-view/viewed-keys.ts";
import { escapeViewedAgent, submitToViewedAgent } from "./agent-view/viewed-submit.ts";
import type { AgentsFocusInput } from "./components/custom-editor.ts";
import { isChatSessionWorking } from "./components/footer.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { bindMainComposerAgentRows, MainComposerKeyOverlay } from "./components/main-composer-keys.ts";
import { holdPromptSlot } from "./components/prompt-slot.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { StartupIdentityComponent } from "./components/startup-identity.ts";
import { holdForExtensionCommand, holdSubmittedExtensionCommand } from "./extension-command-hold.ts";
import { COMPACTION_ALREADY_IN_PROGRESS_WARNING } from "./interactive-bash-compact.ts";
import { routeGlobalClearInput } from "./interactive-global-clear.ts";
import { isPhysicalCtrlC, isPhysicalEscape, isSafetyKeyRelease } from "./interactive-key-identity.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { pasteClipboardImageToEditor, recordTimeSinceReset } from "./interactive-mode-deps.ts";
import { BUILTIN_SLASH_COMMAND_NAMES } from "./interactive-mode-helpers.ts";
import { cachedExactModelMatch } from "./interactive-model-routing.ts";
import { pauseAndAbortInteractiveSession } from "./interactive-pause.ts";
import { restoreFailedSubmissionDraft, restoreRefusedSubmission } from "./interactive-prompt-restore.ts";
import { handOffCompactionQueue, mainSteering } from "./interactive-queueing.ts";
import { followStartedRunEcho } from "./interactive-render-chat.ts";
import { createStopAllChord, createStopAllNotices, STOP_ALL_STATUS_KEY } from "./interactive-stop-all.ts";
import { screenHoldOf } from "./screen-hold.ts";
import type { SteeringSubmitResult } from "./steering-queue-controller.ts";
import { theme } from "./theme/theme.js";

/** Whether the prompt has the keyboard; a host without focus tracking always gives it the prompt. */
function promptHasFocus(mode: InteractiveModeBase): boolean {
	const focused = (mode.ui as { getFocusedComponent?(): object | null }).getFocusedComponent?.();
	return focused === undefined || focused === mode.editor;
}

/** Where `/tasks` mounts in this process, with the chat's render settings. */
function taskInspectorUi(mode: InteractiveModeBase): TaskInspectorUi {
	const ui = mode.createExtensionUIContext();
	return {
		custom: (factory, options) => mode.showExtensionCustom(factory, options),
		getChatRenderSettings: ui.getChatRenderSettings,
		getFooterDataProvider: ui.getFooterDataProvider,
		getToolsExpanded: ui.getToolsExpanded,
		setToolsExpanded: ui.setToolsExpanded,
		notify: ui.notify,
	};
}

function mainComposerPanelCounts(mode: InteractiveModeBase) {
	return mode.runtimeHost instanceof IsolatedInteractiveRuntime
		? mode.runtimeHost.agentPanelCounts
		: agentPanelCounts(mode.session);
}

export function registerStartupInputListeners(mode: InteractiveModeBase): void {
	if (mode.keybindings) {
		bindMainComposerAgentRows(mode.keybindings, () => mainComposerPanelCounts(mode));
	}
	// A part of the screen held while a view is on its way is shown live before any key handler acts on the key, a key
	// another handler then takes (Ctrl+C, the stop-all chord) included.
	mode.addTuiInputListener((data) => {
		screenHoldOf(mode).noteInput(data);
		return undefined;
	});
	mode.addTuiInputListener(() =>
		mode.builtInHeader instanceof StartupIdentityComponent ? void mode.builtInHeader.settle() : undefined,
	);
	mode.addTuiInputListener((data) =>
		routeGlobalClearInput(data, {
			// Physical identity first: safety routing must survive an `app.clear` remap.
			matchesCtrlC: isPhysicalCtrlC,
			matchesEscape: isPhysicalEscape,
			isSafetyKeyRelease,
			matchesClear: (candidate) => mode.keybindings.matches(candidate, "app.clear"),
			hasOverlay: () => mode.ui.hasOverlay(),
			blockingInlineCustomUiActive: () => mode.blockingInlineCustomUiDepth > 0,
			editorOwnsInput: () => mode.editorContainer.children.includes(mode.editor),
			remoteEngineProxyOwner: () =>
				remoteEngineProxyOwner(mode.runtimeHost, {
					hasOverlay: () => mode.ui.hasOverlay(),
					inlineComponents: () => mode.editorContainer.children,
				}),
			remoteProxyHandlesCtrlC: (owner) => remoteProxyHandlesCtrlC(mode.runtimeHost, owner),
			onRemoteProxyDismiss: (owner) => {
				dismissRemoteProxy(mode.runtimeHost, owner);
			},
			engineNeedsExplicitTermination: () => interactiveEngineNeedsExplicitTermination(mode.runtimeHost),
			onEngineTerminate: () => {
				terminateInteractiveEngine(mode.runtimeHost);
			},
			onClear: () => mode.handleCtrlC(),
			requestRender: () => mode.ui.requestRender(),
		}),
	);
}

InteractiveModeBase.prototype.setupKeyHandlers = async function (this: InteractiveModeBase): Promise<void> {
	registerStartupInputListeners(this);
	registerHintCommandHandler(this);
	const isolated = this.runtimeHost instanceof IsolatedInteractiveRuntime ? this.runtimeHost : undefined;
	const notices = createStopAllNotices({
		...(isolated === undefined
			? {
					setFooterStatus: (text: string | undefined) =>
						this.footerDataProvider.setExtensionStatus(STOP_ALL_STATUS_KEY, text),
					showToast: (text: string) => {
						const toast = this.ui.showOverlay(new Text(theme.fg("warning", text), 1, 0), {
							anchor: "bottom-center",
							width: "100%",
							offsetY: -3,
							nonCapturing: true,
						});
						return () => toast.hide();
					},
				}
			: { setEngineNotice: (text: string | undefined) => void isolated.setStopAllNotice(text).catch(() => {}) }),
		hasOverlay: () => this.ui.hasOverlay(),
		requestRender: () => this.ui.requestRender(),
	});
	this.addTuiInputListener(
		createStopAllChord({
			keybindings: this.keybindings,
			chordAllowed: () => {
				const focused = (this.ui as { getFocusedComponent?(): object | null }).getFocusedComponent?.();
				return !(focused instanceof LoginDialogComponent || focused instanceof ScopedModelsSelectorComponent);
			},
			stopAll: () =>
				this.runtimeHost instanceof IsolatedInteractiveRuntime
					? this.runtimeHost.stopAllBackgroundWork()
					: stopAllBackgroundWork(this.session),
			showStatus: (message) => notices.show(message),
			showWarning: (message) => notices.show(message),
			clearStatus: () => notices.clear(),
		}),
	);
	let agentPanelRequested = false;
	/** The agent panel's key from the prompt: answers whether it took the key (it focused the panel, or is doing so). */
	const focusAgentPanel = ({ promptEmpty, clicked }: AgentsFocusInput): boolean => {
		if (this.ui.hasOverlay() || !this.editorContainer.children.includes(this.editor)) return false;
		if (this.editor.capturesViewportInput) return false;
		// A shown subagent's question form takes the keys while it has the focus: ↓ moves its choice there.
		if (this.agentView?.viewed.kind === "agent" && !promptHasFocus(this)) return false;
		// A click on the `↓ agents` hint focuses the panel whatever the prompt holds; a typed ↓ does only on an empty one.
		if (this.isBashMode || (!clicked && !promptEmpty())) return false;
		if (agentPanelRequested || this.blockingInlineCustomUiDepth > 0) return true;
		if (this.runtimeHost instanceof IsolatedInteractiveRuntime) {
			agentPanelRequested = true;
			void this.runtimeHost
				.openAgentPanel()
				.catch((error: unknown) => this.showWarning(sourceError(error).message))
				.finally(() => {
					agentPanelRequested = false;
				});
			return true;
		}
		if (!agentPanelHasRows(this.session)) return false;
		const ui = this.createExtensionUIContext();
		void showAgentPanel(this.session, {
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			getChatRenderSettings: ui.getChatRenderSettings,
			getFooterDataProvider: ui.getFooterDataProvider,
			getToolsExpanded: ui.getToolsExpanded,
			setToolsExpanded: ui.setToolsExpanded,
			notify: ui.notify,
		}).catch((error: unknown) => this.showWarning(sourceError(error).message));
		return true;
	};
	// An extension's editor built on the prompt's editor gets the key first, and leaves it to this through its base.
	setAgentPanelFocuser(this, focusAgentPanel);
	this.addTuiInputListener((data) => {
		if (isKeyRelease(data) || isPhysicalEscape(data) || !this.keybindings.matches(data, "app.agents.focus"))
			return undefined;
		if (this.editor !== this.defaultEditor) return undefined;
		const taken = focusAgentPanel({ promptEmpty: () => this.editor.getText() === "", clicked: isHintActivation() });
		return taken ? { consume: true } : undefined;
	});
	// While the screen shows a subagent that waits on its shells, the waited-shell key opens the newest one's output.
	this.addTuiInputListener((data) => {
		const viewed = this.agentView?.viewed;
		if (viewed?.kind !== "agent" || isKeyRelease(data) || !this.keybindings.matches(data, "app.tasks.openWaited"))
			return undefined;
		if (this.ui.hasOverlay() || !this.editorContainer.children.includes(this.editor) || !promptHasFocus(this))
			return undefined;
		const status = viewed.port.status();
		if (status.state !== "waiting") return undefined;
		const opened =
			this.runtimeHost instanceof IsolatedInteractiveRuntime
				? this.runtimeHost.openTaskInspector(undefined, { waitedShellOf: status.taskId })
				: openWaitedShellOf(this.session, taskInspectorUi(this), status.taskId);
		void opened.catch((error: unknown) => this.showWarning(sourceError(error).message));
		return { consume: true };
	});
	// Set up handlers on defaultEditor - they use this.editor for text access
	// so they work correctly regardless of which editor is active
	this.defaultEditor.onEscape = () => {
		if (!this.session.isStreaming && interruptBlockedInteractiveEngine(this.runtimeHost)) return;
		// While a subagent is shown, Esc is about it: it pauses it, and never interrupts the main chat.
		if (escapeViewedAgent(this)) return;
		if (this.session.isStreaming || this.session.agent.hasQueuedMessages() || this.session.queuedMessagesPaused) {
			pauseAndAbortInteractiveSession(this, { restoreQueuedMessages: true });
		} else if (this.session.isRetrying) {
			this.session.abortRetry();
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
	this.defaultEditor.onAction("app.thinking.cycle", () => {
		void this.cycleThinkingLevel().catch((error: Error) => this.showError(error.message));
	});
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
	this.defaultEditor.onAction("app.history.search", () => this.showPromptHistorySearch());
	this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
	this.defaultEditor.onAction("app.keys.help", () => {
		void this.showExtensionCustom<void>(
			(_tui, _theme, keybindings, done) =>
				new MainComposerKeyOverlay(
					keybindings,
					() => {
						const agentRows = mainComposerPanelCounts(this).total;
						const viewed = this.agentView?.viewed;
						// While a subagent is shown, the keys are its prompt's: ← leads back to main, Esc pauses it.
						return viewed?.kind === "agent"
							? {
									agentRows,
									working: viewed.port.status().busy,
									viewedAgent: { backKeys: viewedAgentBackKeyList(this) },
								}
							: { agentRows, working: isChatSessionWorking(this.session) };
					},
					() => done(),
				),
		);
	});
	this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
	this.defaultEditor.onAction("app.editor.external", () => {
		void this.openExternalEditor();
	});
	this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
	this.defaultEditor.onAction("app.message.dequeue", () => {
		void this.handleDequeue();
	});
	this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
	this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
	this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
	this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

	this.defaultEditor.onChange = (text: string) => {
		const wasBashMode = this.isBashMode;
		this.isBashMode = text.trimStart().startsWith("!");
		if (wasBashMode !== this.isBashMode) {
			this.updateEditorBorderColor();
		}
	};

	// Handle clipboard paste (triggered on Ctrl+V). Copied files use their original paths,
	// images are attached via temporary files, and plain text is the final fallback.
	this.defaultEditor.onPasteImage = () => {
		this.handleClipboardImagePaste();
	};
};

InteractiveModeBase.prototype.handleClipboardImagePaste = async function (this: InteractiveModeBase): Promise<void> {
	await pasteClipboardImageToEditor(this.editor, () => this.ui.requestRender(), {
		showWarning: (message) => this.showWarning(message),
		isBashMode: this.isBashMode,
	});
};

InteractiveModeBase.prototype.deliverStartupReplayPrompt = function (this: InteractiveModeBase, text: string): void {
	if (this.onInputCallback) {
		if (!text.startsWith("/")) {
			this.renderDeferredUserInput(text);
		}
		const callback = this.onInputCallback;
		this.onInputCallback = undefined;
		callback({ text, draft: text });
	} else {
		this.pendingUserInputs.push({ text, draft: text });
	}
};

InteractiveModeBase.prototype.drainStartupReplayCommands = async function (this: InteractiveModeBase): Promise<void> {
	while (this.pendingUserInputs.length === 0 && this.startupReplayActiveInput) {
		const activeInput = this.startupReplayActiveInput;
		await this.defaultEditor.onSubmit?.(activeInput);
		if (this.editor.getText().trim() === activeInput.trim()) {
			this.editor.setText("");
		}
		if (this.startupReplayActiveInput?.trim() === activeInput.trim()) break;
	}
};

InteractiveModeBase.prototype.advanceStartupInputReplay = function (
	this: InteractiveModeBase,
	submittedText: string,
): void {
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

InteractiveModeBase.prototype.setupEditorSubmitHandler = function (this: InteractiveModeBase): void {
	this.defaultEditor.onSubmit = async (text: string) => {
		if (!this.firstSubmitRecorded) {
			this.firstSubmitRecorded = true;
			recordTimeSinceReset("interactive-first-submit");
			markLifecycleTiming("interactive-first-submit");
		}
		// pi-tui trims, expands pastes, and clears the editor before it calls
		// onSubmit, so the callback argument is already reduced. Prefer the buffer
		// CustomEditor snapshotted for this very dispatch, which is what the user
		// actually had, and fall back to the argument for other editors and for
		// tests that invoke onSubmit directly.
		const submittedDraft = this.defaultEditor.takeSubmittedDraft?.() ?? text;
		text = text.trim();
		if (!text) return;

		if (this.startupReplayActiveInput && this.startupReplayActiveInput.trim() !== text.trim()) {
			this.startupReplayInputs.push(text);
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			return;
		}
		// While a subagent is shown, the prompt is its; the main chat's path is untouched otherwise.
		const viewed = this.agentView?.viewed;
		if (viewed?.kind === "agent") {
			await submitToViewedAgent(this, viewed.port, text, submittedDraft);
			return;
		}
		// Text a gone subagent's prompt moved here, submitted unedited, asks first when it would rewrite main. Decided
		// synchronously: with nothing moved, main's path runs exactly as before.
		const moved = gateMovedDraft(this, text, submittedDraft);
		if (moved !== undefined) {
			await moved;
			return;
		}
		await mainSubmit(this, text, submittedDraft);
	};
};

/**
 * What the main chat does with a submission: `text` trimmed and non-empty, `submittedDraft` the buffer as typed.
 * While a subagent is shown, the commands that run as in the main chat come here too.
 */
export function mainSubmit(
	mode: InteractiveModeBase,
	text: string,
	submittedDraft: string,
	prompt: PromptHandle = promptHandle(mode, "viewed"),
): Promise<void> {
	return submitToMainChat.call(mode, text, submittedDraft, prompt);
}

/**
 * `prompt` is the prompt the submission came from, captured before anything here awaits: its clears and history reach
 * that prompt even when the screen shows another agent by then. While main is shown it is the editor itself.
 */
async function submitToMainChat(
	this: InteractiveModeBase,
	text: string,
	submittedDraft: string,
	prompt: PromptHandle,
): Promise<void> {
	try {
		// Built-in commands split their name from their arguments at the first
		// whitespace, the same way prompt templates, skills and extension commands do.
		const { name: command, args } = text.startsWith("/") ? parseSlashCommand(text) : { name: "", args: "" };
		const argument = args.trim() || undefined;
		const bare = (name: string) => command === name && args === "";
		if (command === "tasks") {
			// The panel takes the prompt's place: until it is up, the prompt's slot keeps showing what it showed.
			const held = holdPromptSlot(this.editorContainer);
			try {
				if (this.runtimeHost instanceof IsolatedInteractiveRuntime) {
					await this.runtimeHost.openTaskInspector(argument);
					return;
				}
				if (!getOwnerTaskStore(this.session)) this.session.getAgentTaskHost();
				const store = getOwnerTaskStore(this.session);
				prompt.setText("");
				if (!store) {
					this.showStatus("Launched agents and shells will appear here.");
					return;
				}
				const ui = this.createExtensionUIContext();
				await showTaskInspector(
					{
						custom: (factory, options) => this.showExtensionCustom(factory, options),
						getChatRenderSettings: ui.getChatRenderSettings,
						getFooterDataProvider: ui.getFooterDataProvider,
						getToolsExpanded: ui.getToolsExpanded,
						setToolsExpanded: ui.setToolsExpanded,
						notify: ui.notify,
					},
					store,
					argument,
					{ board: agentPanelBoardSource(this.session) },
				);
				return;
			} finally {
				held.settle();
			}
		}
		if (bare("settings")) {
			const shown = this.showSettingsSelector();
			prompt.setText("");
			await shown;
			return;
		}
		if (bare("scoped-models")) {
			const held = holdPromptSlot(this.editorContainer);
			prompt.setText("");
			try {
				await this.ensureDeferredStartupComplete();
				this.showModelsSelector();
			} finally {
				held.settle();
			}
			return;
		}
		if (command === "model") {
			// Without a model to pick, it opens the selector. A name that matches no model known yet is looked up after a
			// refresh, and opens the selector unless the refresh finds it.
			const held =
				argument === undefined || cachedExactModelMatch(this, argument) === undefined
					? holdPromptSlot(this.editorContainer)
					: undefined;
			prompt.setText("");
			try {
				await this.ensureDeferredStartupComplete();
				await this.handleModelCommand(argument);
			} finally {
				held?.settle();
			}
			return;
		}
		if (command === "thinking") {
			// Without a level to set, it opens the selector.
			const held = argument === undefined ? holdPromptSlot(this.editorContainer) : undefined;
			prompt.setText("");
			try {
				await this.ensureDeferredStartupComplete();
				await this.handleThinkingCommand(argument);
			} finally {
				held?.settle();
			}
			return;
		}
		if (command === "export") {
			await this.handleExportCommand(text);
			prompt.setText("");
			return;
		}
		if (command === "import") {
			await this.handleImportCommand(text);
			prompt.setText("");
			return;
		}
		if (bare("share")) {
			// Its loader takes the prompt's place at once; the prompt is back as soon as a cancel shows it.
			prompt.setText("");
			await this.handleShareCommand();
			return;
		}
		if (bare("copy")) {
			await this.handleCopyCommand();
			prompt.setText("");
			return;
		}
		if (command === "name") {
			await this.handleNameCommand(text);
			prompt.setText("");
			return;
		}
		if (bare("session")) {
			await this.handleSessionCommand();
			prompt.setText("");
			return;
		}
		if (command === "session" && args === "snapshot") {
			prompt.setText("");
			await this.handleSessionSnapshotCommand();
			return;
		}
		if (bare("tools")) {
			prompt.setText("");
			await this.handleToolsCommand();
			return;
		}
		if (bare("changelog")) {
			prompt.setText("");
			await this.handleChangelogCommand();
			return;
		}
		if (bare("hotkeys")) {
			this.handleHotkeysCommand();
			prompt.setText("");
			return;
		}
		if (bare("fork")) {
			const held = holdPromptSlot(this.editorContainer);
			const shown = this.showUserMessageSelector();
			prompt.setText("");
			void shown.finally(() => held.settle());
			return;
		}
		if (bare("clone")) {
			prompt.setText("");
			await this.handleCloneCommand();
			return;
		}
		if (bare("tree")) {
			const held = holdPromptSlot(this.editorContainer);
			const shown = this.showTreeSelector();
			prompt.setText("");
			void shown.finally(() => held.settle());
			return;
		}
		if (bare("trust")) {
			void this.showTrustSelector();
			prompt.setText("");
			return;
		}
		if (command === "login") {
			prompt.setText("");
			await this.handleLoginCommand(argument);
			return;
		}
		if (command === "logout") {
			prompt.setText("");
			await this.showOAuthSelector("logout", argument);
			return;
		}
		if (bare("new")) {
			prompt.setText("");
			await this.handleClearCommand();
			return;
		}
		if (command === "compact") {
			prompt.setText("");
			// A manual request can take over automatic compaction, but a second manual
			// compaction or branch summary still has no safe independent owner.
			const automaticCompaction =
				this.session.compactionReason === "threshold" || this.session.compactionReason === "overflow";
			if (this.manualCompactionTakeoverPending || (this.compactionActive && !automaticCompaction)) {
				this.showWarning(COMPACTION_ALREADY_IN_PROGRESS_WARNING);
				return;
			}
			await this.handleCompactCommand(args);
			return;
		}
		if (bare("reload")) {
			const held = holdPromptSlot(this.editorContainer);
			prompt.setText("");
			try {
				await this.ensureDeferredStartupComplete();
				await this.handleReloadCommand();
			} finally {
				held.settle();
			}
			return;
		}
		if (bare("debug")) {
			const written = this.handleDebugCommand();
			prompt.setText("");
			await written;
			return;
		}
		if (bare("arminsayshi")) {
			this.handleArminSaysHi();
			prompt.setText("");
			return;
		}
		if (bare("dementedelves")) {
			const shown = this.handleDementedDelves();
			prompt.setText("");
			await shown;
			return;
		}
		if (command === "resume") {
			prompt.setText("");
			if (argument) await this.handleResumeTarget(argument);
			else {
				const held = holdPromptSlot(this.editorContainer);
				this.showSessionSelector();
				held.settle();
			}
			return;
		}
		if (bare("quit") || bare("exit")) {
			prompt.setText("");
			await this.shutdown();
			return;
		}

		if (text.startsWith("/") && this.deferredStartupPending) {
			prompt.addToHistory(text);
			prompt.setText("");
			this.ui.requestRender();
			// A command an extension has registered already is held like any extension command; a name not known yet
			// is not.
			const held = this.isExtensionCommand(text) ? holdForExtensionCommand(this) : undefined;
			try {
				await yieldToEventLoop();
				await this.ensureDeferredStartupComplete();
				await this.session.prompt(text);
			} finally {
				held?.settle();
			}
			return;
		}
		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (this.session.isBashRunning) {
					this.showWarning("A bash command is already running. esc cancel first.");
					prompt.setText(text);
					return;
				}
				prompt.addToHistory(text);
				await this.handleBashCommand(command, isExcluded);
				this.isBashMode = false;
				this.updateEditorBorderColor();
				return;
			}
		}

		// Queue input behind compaction-queued messages (extension commands execute immediately)
		if (
			this.compactionActive ||
			(!this.session.queuedMessagesPaused &&
				(this.compactionFlushPending || this.compactionSendFailed || this.promptTurn?.dispatched === false))
		) {
			if (this.isExtensionCommand(text)) {
				prompt.addToHistory(text);
				prompt.setText("");
				// Messages the command sends must follow the ones already typed (#4251).
				if (this.compactionActive) handOffCompactionQueue(this);
				const held = holdForExtensionCommand(this);
				try {
					await this.session.prompt(text);
				} finally {
					held.settle();
				}
			} else {
				this.queueCompactionMessage(text, "steer");
			}
			return;
		}

		// A paused submission releases the session queue before its own turn, so move held
		// messages there first to keep them ahead of this one.
		if (this.session.queuedMessagesPaused && this.compactionSendFailed && !this.compactionFlushPending) {
			await this.flushCompactionQueue({ willRetry: false });
		}

		// If streaming, use prompt() with steer behavior
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if ((this.session.isStreaming || this.promptTurn !== undefined) && !this.session.queuedMessagesPaused) {
			const extensionCommand = this.isExtensionCommand(text);
			prompt.addToHistory(text);
			prompt.setText("");
			// The session can show the message before this prompt's answer arrives: an engine sends its answer as the run
			// starts, before or after the run's first events. If the session already showed the message, echoing it again
			// here would show it twice (#4272). It shows the message as sent, which an `input` hook may have rewritten
			// (#4277), so any message it showed meanwhile counts.
			const shownBefore = this.userMessagesShownBySession;
			const startedEcho = followStartedRunEcho(this, text, { sendShowsWorkingRow: false });
			const held = extensionCommand ? holdForExtensionCommand(this) : undefined;
			let submitted: SteeringSubmitResult;
			try {
				submitted = await mainSteering(this).submit(text, "steer", {
					route: "queue",
					// An extension command runs at once instead of queueing, so only other input is shown as queued (#4696).
					showAsQueued: !extensionCommand,
					onAnswered: (success, disposition) => {
						const echoed =
							success &&
							disposition === "started" &&
							!text.startsWith("/") &&
							this.userMessagesShownBySession === shownBefore;
						if (echoed) {
							this.renderDeferredUserInput(text);
							this.expectStartedUserInput(text, shownBefore);
						}
						// The run's own events decide this echo (#5135), however they and this answer are ordered.
						startedEcho.answer(echoed);
					},
				});
			} finally {
				startedEcho.close();
				held?.settle();
			}
			if (submitted.kind === "failed") throw submitted.error;
			if (submitted.kind === "lost") {
				this.showError(submitted.error.message);
				return;
			}
			if (submitted.kind === "refused") {
				restoreRefusedSubmission(this, submitted.error, submittedDraft, prompt);
				return;
			}
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			return;
		}

		// Normal message submission
		// First, move any pending bash components to chat
		this.flushPendingBashComponents();
		// The draft travels with this submission, never through shared state: a
		// later submission whose trimmed text is identical must not be able to
		// claim, or clear, this one's exact buffer.
		const submission = { text, draft: submittedDraft };

		if (this.onInputCallback) {
			if (!text.startsWith("/")) {
				this.renderDeferredUserInput(text);
			}
			this.promptTurn ??= { dispatched: false };
			this.onInputCallback(submission);
		} else {
			this.pendingUserInputs.push(submission);
		}
		prompt.addToHistory(text);
		// The turn that runs an extension command, which starts after this, ends its hold of the prompt's slot.
		if (text.startsWith("/") && this.isExtensionCommand(text)) holdSubmittedExtensionCommand(this, submission);
	} catch (error) {
		// Direct dispatch branches above hand text straight to the engine and
		// never reach runUserPromptTurn(), so this is the only place their send
		// failures can put the draft back. Anything else is not ours to absorb.
		if (!restoreFailedSubmissionDraft(this, error, submittedDraft, { prompt })) throw error;
	} finally {
		this.advanceStartupInputReplay?.(text);
	}
}

/**
 * A click on a hint that names a slash command, such as `/tasks to manage`, runs it as if it were typed into an empty
 * prompt. The prompt keeps what it held.
 */
function registerHintCommandHandler(mode: InteractiveModeBase): void {
	const remoteCommand = (name: string) =>
		getInteractiveEngineRemoteCommands(mode.runtimeHost).find((cmd) => cmd.name === name);
	bindBundledHintCommands(mode.keybindings, (name) => {
		const local = mode.session.extensionRunner.getCommand(name);
		if (local) return local.sourceInfo.configurationOrigin === "bundled";
		const remote = remoteCommand(name);
		return remote?.source === "extension" && remote.sourceInfo.configurationOrigin === "bundled";
	});
	mode.ui.setHintCommandHandler?.((command) => {
		const submit = mode.defaultEditor.onSubmit;
		if (!submit) return;
		const { name } = parseSlashCommand(command);
		// A painted hint may outlive its registration. Never submit unrecognized slash text as a user message.
		if (
			!BUILTIN_SLASH_COMMAND_NAMES.has(name) &&
			!mode.session.extensionRunner.getCommand(name) &&
			!remoteCommand(name) &&
			!mode.session.promptTemplates?.some((template) => template.name === name) &&
			!mode.skillCommands?.has(name)
		)
			return;
		const draft = mode.editor.getText();
		const run = submit(command);
		if (draft !== "" && mode.editor.getText() === "") mode.editor.setText(draft);
		void Promise.resolve(run).catch((error: unknown) => mode.showError(sourceError(error).message));
	});
}
