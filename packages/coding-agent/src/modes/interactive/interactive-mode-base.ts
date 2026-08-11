/**
 * Shared state and constructor wiring for interactive mode.
 * Responsibility-specific behavior is installed by sibling modules.
 */
import { isKeyRelease, isViewportTUI, type ScrollView, type TuiInputListener } from "@earendil-works/pi-tui";

import type { AgentSessionQueuePauseControl } from "../../core/agent-session-methods.ts";
import type { MarkdownTransformer } from "../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../core/settings-manager.ts";
import type { EarlyInputSnapshot } from "../../main-early-input.ts";
import { readClipboardText } from "../../utils/clipboard.ts";
import { renderEngineDiagnostic } from "../interactive-engine/engine-diagnostic-view.ts";
import { attachInteractiveEngineHost } from "../interactive-engine/extension-ui-bridge.ts";
import type { RemoteToolExecutionComponent } from "../interactive-engine/remote-renderer.ts";
import { KeybindingsReloadCoordinator } from "../rpc/rpc-keybindings-reload.ts";
import type { AtomicWorkingLoader } from "./components/atomic-working-status.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type AssistantMessage,
	type AssistantMessageComponent,
	type AutocompleteProvider,
	type AutocompleteProviderFactory,
	type BashExecutionComponent,
	type Component,
	Container,
	type CountdownTimer,
	CustomEditor,
	type EditorComponent,
	type EditorFactory,
	type ExtensionEditorComponent,
	type ExtensionInputComponent,
	type ExtensionSelectorComponent,
	FooterComponent,
	FooterDataProvider,
	getEditorTheme,
	type HostCustomUiStateListener,
	InteractiveThemeController,
	KeybindingsManager,
	type Loader,
	type LoaderIndicatorOptions,
	type Spacer,
	setKeybindings,
	setRegisteredThemes,
	type Text,
	type ToolExecutionComponent,
	type TUI,
	theme,
	UsageMeterComponent,
	VERSION,
} from "./interactive-mode-deps.ts";
import type {} from "./interactive-mode-surface.ts";
import type { CompactionQueuedMessage, InteractiveModeOptions } from "./interactive-mode-types.ts";
import { StartupChatContainer } from "./interactive-startup-chat-container.ts";
import type { InteractiveSubmission } from "./interactive-submission.ts";
import { createInteractiveTui, createInteractiveTuiReference, type InteractiveTui } from "./interactive-tui.ts";

const FULLSCREEN_VIEWPORT_ACTIONS = [
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
] as const;

/**
 * Decide whether the fullscreen viewport should run before the focused
 * component. `isMouseInput` is classified by pi-tui's own mouse predicate in
 * `AtomicTuiAltScreen`, so this policy does not duplicate terminal grammars.
 * Mouse deferral is limited to actual overlays so inline components do not
 * disable pi-tui's application-owned transcript selection path.
 */
export function shouldHandleFullscreenViewportInput(
	focused: Component | null,
	editor: Component,
	data: string,
	isMouseInput: boolean,
	focusedIsOverlay: boolean,
	keybindings: KeybindingsManager,
): boolean {
	if (focused === editor || !focused?.handleInput) return true;
	if (isMouseInput) return !focusedIsOverlay;
	if (focusedIsOverlay && keybindings.matches(data, "app.thinking.toggle")) return false;
	return !FULLSCREEN_VIEWPORT_ACTIONS.some((action) => keybindings.matches(data, action));
}

function isCommandLikeStartupInput(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("/") || trimmed.startsWith("!");
}

export function seedStartupInput(
	pendingUserInputs: InteractiveSubmission[],
	editor: { setText(text: string): void },
	startupInput: EarlyInputSnapshot | undefined,
	startupReplayInputs: string[] = [],
	setStartupDraftText?: (text: string) => void,
	setStartupReplayActiveInput?: (text: string) => void,
): void {
	if (!startupInput) return;
	let commandReplayStarted = false;
	for (const submission of startupInput.submissions) {
		if (commandReplayStarted) {
			startupReplayInputs.push(submission);
		} else if (isCommandLikeStartupInput(submission)) {
			const commandText = submission.trim();
			commandReplayStarted = true;
			editor.setText(commandText);
			setStartupReplayActiveInput?.(commandText);
		} else {
			pendingUserInputs.push({ text: submission, draft: submission });
		}
	}
	if (startupInput.text.length === 0) return;
	if (commandReplayStarted) {
		setStartupDraftText?.(startupInput.text);
	} else {
		editor.setText(startupInput.text);
	}
}

export interface InteractiveTuiInputSubscription {
	handler: TuiInputListener;
	unsubscribe: () => void;
}

export class InteractiveModeBase {
	runtimeHost: AgentSessionRuntime;

	ui: TUI;
	private renderer: InteractiveTui;

	private readonly shouldHandleViewportInput = (
		data: string,
		isMouseInput: boolean,
		focusedIsOverlay: boolean,
	): boolean => {
		return shouldHandleFullscreenViewportInput(
			this.renderer.getFocusedComponent(),
			this.editor,
			data,
			isMouseInput,
			focusedIsOverlay,
			this.keybindings,
		);
	};
	private readonly onOverlayUnhandledInput = (data: string): boolean => this.handleOverlayUnhandledInput(data);

	/** Dispatch the host thinking action after a focused workflow overlay declines input. */
	handleOverlayUnhandledInput(data: string): boolean {
		if (isKeyRelease(data) || !this.keybindings.matches(data, "app.thinking.toggle")) return false;
		// Reuse the default editor's action dispatcher even while a workflow
		// overlay owns focus. This keeps the host binding and its user remap as
		// the source of truth instead of calling the implementation directly.
		return this.defaultEditor.handleInput(data);
	}

	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};

	chatContainer: Container;
	documentContainer: Container;

	transcriptScrollView: ScrollView | undefined;

	fullscreenLayoutRoot: Component | undefined;

	resourceDisclosureContainer: Container;
	startupNoticesContainer: Container;
	pendingMessagesContainer: Container;

	statusContainer: Container;

	defaultEditor: CustomEditor;

	editor: EditorComponent;

	editorComponentFactory: EditorFactory | undefined;

	autocompleteProvider: AutocompleteProvider | undefined;

	autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];

	fdPath: string | undefined;

	editorContainer: Container;

	activeSelectorToken: object | undefined;

	activeSelectorDispose: (() => void) | undefined;

	footer: FooterComponent;
	footerContainer: Container;

	usageMeter: UsageMeterComponent;

	footerDataProvider: FooterDataProvider;

	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	keybindings: KeybindingsManager;

	reloadCoordinator: KeybindingsReloadCoordinator;

	interactiveEngineShortcutHandler: ((data: string) => boolean) | undefined;

	disposeInteractiveEngineHost: () => void = () => {};

	version: string;

	isInitialized = false;

	onInputCallback?: (submission: InteractiveSubmission) => void;

	pendingUserInputs: InteractiveSubmission[] = [];

	startupReplayInputs: string[] = [];

	startupReplayActiveInput: string | undefined = undefined;

	startupDraftText: string | undefined = undefined;

	startupCookedInputRecovered = false;

	deferredRenderedUserInputs: string[] = [];

	deferredRenderedUserInputComponents = new Map<string, Component[][]>();

	loadingAnimation: Loader | AtomicWorkingLoader | undefined = undefined;

	workingMessage: string | undefined = undefined;

	workingVisible = true;

	workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;

	readonly defaultWorkingMessage = "Working...";

	readonly defaultHiddenThinkingLabel = "Thinking...";

	hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	lastSigintTime = 0;

	lastEscapeTime = 0;

	changelogMarkdown: string | undefined = undefined;

	startupNoticesShown = false;
	startupNoticesPrepared = false;

	anthropicSubscriptionWarningShown = false;

	firstRunNoticeVisible = false;

	hadLastChangelogVersionAtStartup = false;

	firstRunOnboardingNoticeComponents: Component[] = [];

	autoTrustOnReloadCwd: string | undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	lastStatusSpacer: Spacer | undefined = undefined;

	lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	streamingComponent: AssistantMessageComponent | undefined = undefined;

	streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	pendingTools = new Map<string, ToolExecutionComponent | RemoteToolExecutionComponent>();

	// Tool output expansion state
	toolOutputExpanded = false;

	// Thinking block visibility state
	hideThinkingBlock = false;
	outputPad: 0 | 1 = 1;

	mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});
	mermaidMarkdownTransformerMode: MermaidRenderingMode | undefined;

	// Skill commands: command name -> skill file path
	skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	unsubscribe?: () => void;

	signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	isBashMode = false;

	// Track current bash execution component
	bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	autoCompactionLoader: AtomicWorkingLoader | undefined = undefined;

	autoCompactionEscapeHandler?: () => void;

	/** True once the pre-compaction Escape handler has been captured for restore. */
	autoCompactionEscapeHandlerSaved = false;

	/** True while `runUserPromptTurn()` owns the working loader. */
	promptTurnWorkingLoaderActive = false;

	// Auto-retry state
	retryLoader: Loader | undefined = undefined;
	fallbackLoader: Loader | undefined = undefined;

	retryCountdown: CountdownTimer | undefined = undefined;

	retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	compactionQueuedMessages: CompactionQueuedMessage[] = [];

	/** Keeps input queued while automatic compaction hands off to a manual request. */
	manualCompactionTakeoverPending = false;

	// Deferred extension load state (first paint happens before extensions load)
	deferredStartupPending = false;
	initialStartupBinding = false;
	deferredStartupPromise: Promise<void> | undefined = undefined;

	inputHandlerReadyRecorded = false;

	firstSubmitRecorded = false;

	// Shutdown state
	shutdownRequested = false;

	// Extension UI state
	extensionSelector: ExtensionSelectorComponent | undefined = undefined;

	extensionInput: ExtensionInputComponent | undefined = undefined;

	extensionEditor: ExtensionEditorComponent | undefined = undefined;

	tuiInputSubscriptions = new Set<InteractiveTuiInputSubscription>();

	extensionTerminalInputSubscriptions = new Set<InteractiveTuiInputSubscription>();

	tuiRendererChangeListeners = new Set<() => void>();

	blockingInlineCustomUiDepth = 0;

	deferredInlineCustomUiFocusDepth = 0;

	pendingInlineCustomUiFocus: Component | undefined = undefined;

	hostCustomUiStateListeners = new Set<HostCustomUiStateListener>();

	themeController: InteractiveThemeController;

	// Extension widgets (components rendered above/below the editor)
	extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();

	extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();

	widgetContainerAbove!: Container;

	widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Convenience accessors
	get session(): AgentSession & AgentSessionQueuePauseControl {
		return this.runtimeHost.session as AgentSession & AgentSessionQueuePauseControl;
	}

	/** Includes the short handoff window that an isolated engine cannot mirror. */
	get compactionActive(): boolean {
		return this.session.isCompacting || this.manualCompactionTakeoverPending;
	}

	get agent() {
		return this.session.agent;
	}

	get sessionManager() {
		return this.session.sessionManager;
	}

	get settingsManager() {
		return this.session.settingsManager;
	}

	/**
	 * Tears down the selector that owns `editorContainer`, including in-flight
	 * work such as a model catalog refresh.
	 *
	 * This lives on the base class so behavior modules can dispose a selector
	 * without relying on `interactive-selectors.ts` load order.
	 */
	disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	addTuiInputListener(handler: TuiInputListener): () => void {
		const subscription: InteractiveTuiInputSubscription = {
			handler,
			unsubscribe: this.ui.addInputListener(handler),
		};
		this.tuiInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.tuiInputSubscriptions.delete(subscription);
		};
	}

	rebindTuiInputListeners(): void {
		for (const subscription of this.tuiInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	onTuiRendererChange(listener: () => void): () => void {
		this.tuiRendererChangeListeners.add(listener);
		return () => this.tuiRendererChangeListeners.delete(listener);
	}

	mountInteractiveTui(tui: TUI, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
		if (isViewportTUI(tui)) {
			if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {
			// Clipboard paste is best-effort; permission and native-module failures are common.
		}
	}

	stopInteractiveTui(): void {
		while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
		this.ui.stop();
	}

	declare options: InteractiveModeOptions;

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.deferredStartupPending = Boolean(options.deferredExtensionLoad);
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession();
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: runtimeHost.services.agentDir,
			terminal: options.terminal,
			onRightClickPaste: this.onRightClickPaste,
			shouldHandleViewportInput: this.shouldHandleViewportInput,
			onOverlayUnhandledInput: this.onOverlayUnhandledInput,
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.chatContainer = new StartupChatContainer();
		this.documentContainer.addChild(this.chatContainer);
		this.resourceDisclosureContainer = new Container();
		this.startupNoticesContainer = new Container();
		// The isolated engine can emit session_start UI requests as soon as its
		// bridge attaches below, before init() mounts chat in the TUI. Reserve the
		// ordering slots now so those messages can never precede RESOURCES.
		this.chatContainer.addChild(this.resourceDisclosureContainer);
		this.chatContainer.addChild(this.startupNoticesContainer);
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create(runtimeHost.services.agentDir);
		this.reloadCoordinator = new KeybindingsReloadCoordinator(this.keybindings);
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});

		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);
		this.usageMeter = new UsageMeterComponent(this.session);
		this.usageMeter.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(
			this.ui,
			this.settingsManager,
			(message) => this.showError(message),
			() => this.updateEditorBorderColor(),
		);
		this.disposeInteractiveEngineHost = attachInteractiveEngineHost(
			runtimeHost,
			this.createExtensionUIContext(),
			(diagnostic) =>
				renderEngineDiagnostic(diagnostic, {
					stopWorkingLoader: () => this.stopWorkingLoader(),
					showStatus: (message) => this.showStatus(message),
					showError: (message) => this.showError(message),
				}),
			{
				isFullscreen: () => this.renderer.mode === "fullscreen",
				onRendererReplaced: (listener) => this.onTuiRendererChange(listener),
			},
			(handler) => {
				this.interactiveEngineShortcutHandler = handler;
				this.defaultEditor.onExtensionShortcut = handler;
				return () => {
					if (this.interactiveEngineShortcutHandler === handler) this.interactiveEngineShortcutHandler = undefined;
					if (this.defaultEditor.onExtensionShortcut === handler)
						this.defaultEditor.onExtensionShortcut = undefined;
				};
			},
			this.keybindings,
		);
	}

	// Maximum total widget lines to prevent viewport overflow
	static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	isShuttingDown = false;
}
