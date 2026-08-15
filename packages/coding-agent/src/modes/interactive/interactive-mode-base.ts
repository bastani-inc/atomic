/**
 * Shared state and constructor wiring for interactive mode.
 * Responsibility-specific behavior is installed by sibling modules.
 */
import { isKeyRelease, isViewportTUI, type ScrollView, type TuiInputListener } from "@earendil-works/pi-tui";

import type { AgentSessionQueuePauseControl } from "../../core/agent-session-methods.ts";
import type { MarkdownTransformer } from "../../core/extensions/types.ts";
import type { FullscreenExitOutput, MermaidRenderingMode } from "../../core/settings-manager.ts";
import type { EarlyInputSnapshot } from "../../main-early-input.ts";
import { readClipboardText } from "../../utils/clipboard.ts";
import { renderEngineDiagnostic } from "../interactive-engine/engine-diagnostic-view.ts";
import { attachInteractiveEngineHost } from "../interactive-engine/extension-ui-bridge.ts";
import type { RemoteToolExecutionComponent } from "../interactive-engine/remote-renderer.ts";
import { KeybindingsReloadCoordinator } from "../rpc/rpc-keybindings-reload.ts";
import type { AtomicWorkingLoader } from "./components/atomic-working-status.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import type { TranscriptOverlayReserve } from "./components/reserved-bottom-overlay.ts";
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
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	handleFocusedOverlayInternalUiAction,
	type InteractiveTui,
	type InternalUiActionResult,
} from "./interactive-tui.ts";

/** Move the transcript and nothing else: what a reserving overlay may release. */
const FULLSCREEN_TRANSCRIPT_SCROLL_ACTIONS = [
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
] as const;

/** Open and drive pi-tui's find box over the transcript. */
const FULLSCREEN_SEARCH_ACTIONS = [
	"tui.altScreen.search",
	"tui.altScreen.searchNext",
	"tui.altScreen.searchPrevious",
	"tui.altScreen.searchClose",
] as const;

const FULLSCREEN_VIEWPORT_ACTIONS = [...FULLSCREEN_TRANSCRIPT_SCROLL_ACTIONS, ...FULLSCREEN_SEARCH_ACTIONS] as const;

export function isFullscreenViewportAction(data: string, keybindings: KeybindingsManager): boolean {
	return FULLSCREEN_VIEWPORT_ACTIONS.some((action) => keybindings.matches(data, action));
}

/**
 * Whether a key scrolls the transcript, as opposed to driving a search over it.
 * A reserving overlay — the `ask_user_question` dialog, an extension component
 * with `reserveTranscriptRows` — declines these so the strip above it still
 * pages and jumps (#2378), and keeps everything else.
 *
 * The search actions are deliberately excluded. Their default keys include
 * `enter`, `shift+enter`, `escape`, and `ctrl+g`, which such a dialog owns for
 * submit, cancel, and its own editing; and pi-tui acts on `searchNext`,
 * `searchPrevious`, and `searchClose` only while its find box holds focus,
 * which cannot be true while the dialog does. Releasing them would drop those
 * keys into a viewport that ignores them.
 */
export function isFullscreenTranscriptScrollAction(data: string, keybindings: KeybindingsManager): boolean {
	return FULLSCREEN_TRANSCRIPT_SCROLL_ACTIONS.some((action) => keybindings.matches(data, action));
}

/**
 * Decide whether the fullscreen viewport should run before the focused
 * component. `isMouseInput` is classified by pi-tui's own mouse predicate in
 * `AtomicTuiAltScreen`, so this policy does not duplicate terminal grammars.
 * Mouse deferral is limited to actual overlays so inline components do not
 * disable pi-tui's application-owned transcript selection path.
 *
 * **Who owns viewport keys while an overlay is focused.** pi-tui 0.84.2 added
 * `shouldDeferViewportInputToOverlay()` (upstream #7894) and answers "the
 * overlay". Atomic answers "the overlay first, the transcript with whatever it
 * declines" (#2378 / PR #2381): the actions in `FULLSCREEN_VIEWPORT_ACTIONS`
 * and wheel reports are offered to the focused overlay, and
 * `AtomicTuiAltScreen` replays what it does not consume into pi-tui's viewport
 * listener. Atomic's answer stands, because a mounted dialog that keeps its
 * selection keys must not also freeze the transcript behind it.
 *
 * **The list covers every `tui.altScreen.*` action pi-tui defines**, transcript
 * search included. A focused overlay therefore gets first refusal on
 * `ctrl+shift+f` as well as on the scroll keys, which is what keeps a search
 * scoped to the surface the reader is looking at instead of opening a find box
 * over the main transcript hidden behind it. An action a focused overlay
 * declines still reaches the transcript, so the shortcut is never simply lost.
 *
 * **A focused overlay with no `handleInput` is still an overlay.** The handler
 * is optional — `ExtensionCustomComponent` marks it `handleInput?` and
 * `docs/tui.md` documents it as optional — and a component that cannot answer
 * declines by definition. Answering "the viewport owns it" for that shape
 * would hand the key to pi-tui, whose native deferral then drops it because an
 * overlay holds focus, so the transcript would freeze behind a component that
 * never asked for the key. A handler-less overlay therefore takes the same
 * route as one that returns `false`: nothing to offer, then replay. Only a
 * focused component that is *not* an overlay keeps the shortcut, because
 * pi-tui defers nothing to it.
 *
 * **Exemption: pi-tui's find box.** `focusedIsViewportSearch` reports whether
 * the focused overlay is the transcript-search box pi-tui mounts itself, which
 * is viewport chrome rather than an application overlay. It gets no first
 * offer: input goes straight to pi-tui, which exempts its own find box from
 * native deferral, so the transcript keeps scrolling while a search is open and
 * `home`/`end` scroll rather than move the query cursor — upstream's behavior
 * exactly. Everything the viewport does not claim still falls through to the
 * find box, so typing edits the query. Callers without a find box omit it.
 *
 * **Order matters: the host thinking toggle outranks the exemption.**
 * `app.thinking.toggle` is a documented, remappable host action, and it is
 * dispatched from `onOverlayUnhandledInput`, which only the gated route runs.
 * Exempting the find box first would send that key to pi-tui instead and drop
 * the toggle for as long as a search had focus. The gated route answers it
 * before the find box sees it (`interactive-tui.ts:routeViewportInput`),
 * because the binding may be a bare letter (`docs/keybindings.md`) and pi-tui's
 * `Input` types a printable character into the query rather than rejecting it.
 */
export function shouldHandleFullscreenViewportInput(
	focused: Component | null,
	editor: Component,
	data: string,
	isMouseInput: boolean,
	focusedIsOverlay: boolean,
	keybindings: KeybindingsManager,
	focusedIsViewportSearch = false,
): boolean {
	if (focused === editor || !focused) return true;
	if (!focused.handleInput && !focusedIsOverlay) return true;
	// The find box is exempt from mouse deferral too: a wheel report over the
	// transcript scrolls it rather than reaching the query.
	if (isMouseInput) return focusedIsViewportSearch || !focusedIsOverlay;
	if (focusedIsOverlay && keybindings.matches(data, "app.thinking.toggle")) return false;
	if (focusedIsViewportSearch) return true;
	return !isFullscreenViewportAction(data, keybindings);
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
		focusedIsViewportSearch: boolean,
	): boolean => {
		return shouldHandleFullscreenViewportInput(
			this.renderer.getFocusedComponent(),
			this.editor,
			data,
			isMouseInput,
			focusedIsOverlay,
			this.keybindings,
			focusedIsViewportSearch,
		);
	};
	private readonly onOverlayUnhandledInput = (data: string): boolean => this.handleOverlayUnhandledInput(data);
	private readonly onOverlayInternalUiAction = (url: string): InternalUiActionResult =>
		handleFocusedOverlayInternalUiAction(this.renderer, url);

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

	/** Leading spacer added once for the managed-tool startup status block. */
	managedToolStatusStarted = false;

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

	transcriptOverlayReserve: TranscriptOverlayReserve | undefined = undefined;

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

	stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		const isFullscreen = this.renderer.mode === "fullscreen";
		if (isFullscreen && fullscreenExitOutput === "transcript") {
			// Atomic has no regular renderer to switch into, so pi-tui's own
			// exit paint is the only painter: its stop renders the layout root
			// at natural height onto the main screen. The docked fullscreen
			// layout squeezes its scroll view to `basis` (one row) at natural
			// height, so hand it the document container directly — the exit
			// paint then carries the whole transcript. Drop overlays first so
			// what gets painted is the transcript, not the focused dialog.
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			if (isViewportTUI(this.renderer)) this.renderer.setLayoutRoot(this.documentContainer);
		}
		// `resume-hint` keeps whatever the alternate screen held: the prior
		// shell contents reappear and shutdown prints only the resume line.
		this.ui.stop({ preserveScreen: isFullscreen && fullscreenExitOutput === "resume-hint" });
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
			onOverlayInternalUiAction: this.onOverlayInternalUiAction,
			onInternalUiAction: () => {
				this.jumpToTranscriptEnd();
				return undefined;
			},
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
