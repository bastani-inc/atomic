/**
 * Shared state and constructor wiring for interactive mode.
 * Responsibility-specific behavior is installed by sibling modules.
 */
import type {} from "./interactive-mode-surface.ts";
import { type AssistantMessage, type AutocompleteProvider, type EditorComponent, type Component, type LoaderIndicatorOptions, type AgentSession, type AgentSessionRuntime, type AutocompleteProviderFactory, type EditorFactory, type HostCustomUiStateListener, Container, Loader, ProcessTerminal, Spacer, setKeybindings, Text, TUI, VERSION, FooterDataProvider, KeybindingsManager, AssistantMessageComponent, BashExecutionComponent, CountdownTimer, CustomEditor, ExtensionEditorComponent, ExtensionInputComponent, ExtensionSelectorComponent, FooterComponent, UsageMeterComponent, ToolExecutionComponent, getEditorTheme, setRegisteredThemes, InteractiveThemeController } from "./interactive-mode-deps.ts";
import type { CompactionQueuedMessage, InteractiveModeOptions } from "./interactive-mode-types.ts";
import type { EarlyInputSnapshot } from "../../main-early-input.ts";
import { shouldRenderEngineDiagnosticAsChatError } from "../interactive-engine/activity-watchdog.ts";
import { attachInteractiveEngineHost } from "../interactive-engine/extension-ui-bridge.ts";
import type { RemoteToolExecutionComponent } from "../interactive-engine/remote-renderer.ts";

function isCommandLikeStartupInput(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("/") || trimmed.startsWith("!");
}

export function seedStartupInput(
  pendingUserInputs: string[],
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
      pendingUserInputs.push(submission);
    }
  }
  if (startupInput.text.length === 0) return;
  if (commandReplayStarted) {
    setStartupDraftText?.(startupInput.text);
  } else {
    editor.setText(startupInput.text);
  }
}

export class InteractiveModeBase {

  runtimeHost: AgentSessionRuntime;


  ui: TUI;


  chatContainer: Container;

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


  footer: FooterComponent;


  usageMeter: UsageMeterComponent;


  footerDataProvider: FooterDataProvider;


  // Stored so the same manager can be injected into custom editors, selectors, and extension UI.
  keybindings: KeybindingsManager;


  version: string;


  isInitialized = false;


  // GitHub Copilot CAPI context-window catalog load state (gated on the Copilot provider).
  copilotCatalogApplied = false;


  copilotCatalogInFlight?: Promise<void>;


  onInputCallback?: (text: string) => void;


  pendingUserInputs: string[] = [];

  startupReplayInputs: string[] = [];


  startupReplayActiveInput: string | undefined = undefined;


  startupDraftText: string | undefined = undefined;

  startupCookedInputRecovered = false;


  deferredRenderedUserInputs: string[] = [];


  deferredRenderedUserInputComponents = new Map<string, Component[][]>();


  loadingAnimation: Loader | undefined = undefined;


  workingMessage: string | undefined = undefined;


  workingVisible = true;


  workingIndicatorOptions: LoaderIndicatorOptions | undefined =
    undefined;


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
  autoCompactionLoader: Loader | undefined = undefined;


  autoCompactionEscapeHandler?: () => void;



  // Auto-retry state
  retryLoader: Loader | undefined = undefined;
  fallbackLoader: Loader | undefined = undefined;

  retryCountdown: CountdownTimer | undefined = undefined;


  retryEscapeHandler?: () => void;



  // Messages queued while compaction is running
  compactionQueuedMessages: CompactionQueuedMessage[] = [];



  // Deferred extension load state (first paint happens before extensions load)
  deferredStartupPending = false;

  deferredStartupPromise: Promise<void> | undefined = undefined;


  inputHandlerReadyRecorded = false;

  firstSubmitRecorded = false;

  deferLoadedResourcesDisclosureUntilAgentEnd = false;


  pendingLoadedResourcesDisclosure = false;





  // Shutdown state
  shutdownRequested = false;



  // Extension UI state
  extensionSelector: ExtensionSelectorComponent | undefined = undefined;


  extensionInput: ExtensionInputComponent | undefined = undefined;


  extensionEditor: ExtensionEditorComponent | undefined = undefined;


  extensionTerminalInputUnsubscribers = new Set<() => void>();


  blockingInlineCustomUiDepth = 0;


  deferredInlineCustomUiFocusDepth = 0;


  pendingInlineCustomUiFocus: Component | undefined = undefined;


  hostCustomUiStateListeners = new Set<HostCustomUiStateListener>();


  themeController: InteractiveThemeController;



  // Extension widgets (components rendered above/below the editor)
  extensionWidgetsAbove = new Map<
    string,
    Component & { dispose?(): void }
  >();


  extensionWidgetsBelow = new Map<
    string,
    Component & { dispose?(): void }
  >();


  widgetContainerAbove!: Container;


  widgetContainerBelow!: Container;



  // Custom footer from extension (undefined = use built-in footer)
  customFooter: (Component & { dispose?(): void }) | undefined =
    undefined;



  // Header container that holds the built-in or custom header
  headerContainer: Container;



  // Built-in header (logo + keybinding hints + changelog)
  builtInHeader: Component | undefined = undefined;



  // Custom header from extension (undefined = use built-in header)
  customHeader: (Component & { dispose?(): void }) | undefined =
    undefined;



  // Convenience accessors
  get session(): AgentSession {
    return this.runtimeHost.session;
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



  declare options: InteractiveModeOptions;



  constructor(
    runtimeHost: AgentSessionRuntime,
    options: InteractiveModeOptions = {},
  ) {
    this.options = options;
    this.deferredStartupPending = Boolean(options.deferredExtensionLoad);
    this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
    this.runtimeHost = runtimeHost;
    this.runtimeHost.setBeforeSessionInvalidate(() => {
      this.resetExtensionUI();
    });
    this.runtimeHost.setRebindSession(async () => {
      await this.rebindCurrentSession();
    });
    this.version = VERSION;
    this.ui = new TUI(
      options.terminal ?? new ProcessTerminal(),
      this.settingsManager.getShowHardwareCursor(),
    );
    this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
    this.headerContainer = new Container();
    this.chatContainer = new Container();
    this.startupNoticesContainer = new Container();
    this.pendingMessagesContainer = new Container();
    this.statusContainer = new Container();
    this.widgetContainerAbove = new Container();
    this.widgetContainerBelow = new Container();
    this.keybindings = KeybindingsManager.create();
    setKeybindings(this.keybindings);
    const editorPaddingX = this.settingsManager.getEditorPaddingX();
    const autocompleteMaxVisible =
      this.settingsManager.getAutocompleteMaxVisible();
    this.defaultEditor = new CustomEditor(
      this.ui,
      getEditorTheme(),
      this.keybindings,
      {
        paddingX: editorPaddingX,
        autocompleteMaxVisible,
      },
    );

    this.editor = this.defaultEditor;
    this.editorContainer = new Container();
    this.editorContainer.addChild(this.editor as Component);
    this.footerDataProvider = new FooterDataProvider(
      this.sessionManager.getCwd(),
    );
    this.footer = new FooterComponent(this.session, this.footerDataProvider);
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
    attachInteractiveEngineHost(
      runtimeHost,
      this.createExtensionUIContext(),
		(diagnostic) => {
			if (diagnostic.message.startsWith("Engine terminated;")) {
				this.stopWorkingLoader();
				this.ui.setFocus(this.editor);
				this.ui.requestRender();
			}
			if (shouldRenderEngineDiagnosticAsChatError(diagnostic)) this.showError(diagnostic.message);
		},
      (handler) => { this.defaultEditor.onExtensionShortcut = handler; },
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
