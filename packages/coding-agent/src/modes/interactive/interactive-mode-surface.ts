/** Method surface installed onto InteractiveModeBase by sibling modules. */
import type { AgentMessage, Api, Message, Model, OAuthSelectPrompt, AutocompleteProvider, Keybinding, MarkdownTheme, OverlayHandle, OverlayOptions, Component, LoaderIndicatorOptions, AgentSession, AgentSessionEvent, EditorFactory, ExtensionCommandContext, ExtensionRunner, ExtensionUIContext, ExtensionUIDialogOptions, HostCustomUiState, HostCustomUiStateListener, ProjectTrustContext, ExtensionWidgetOptions, ReadonlyFooterDataProvider, AppKeybinding, ContextCompactionResult, ResourceDiagnostic, SessionContext, SourceInfo, ChatMessageEntry, ChatMessageRenderOptions, AuthSelectorProvider, Container, TUI, Theme, Loader, MissingSessionCwdError, KeybindingsManager, LoginDialogComponent } from "./interactive-mode-deps.ts";

declare module "./interactive-mode-base.ts" {
  interface InteractiveModeBase {
  getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined;
  prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined;
  getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[];
  getCodexFastModeCandidateModels(): Model<Api>[];
  hasCodexFastModeSupportedModels(): boolean;
  createBaseAutocompleteProvider(): AutocompleteProvider;
  setupAutocompleteProvider(): void;
  showStartupNoticesIfNeeded(): void;
  hadLastChangelogVersionAtStartup: boolean;
  firstRunNoticeVisible: boolean;
  firstRunOnboardingNoticeComponents: Component[];
  initializeFirstRunOnboardingMarkers(): void;
  isFirstRunOnboardingEligible(): boolean;
  clearFirstRunOnboardingUi(): void;
  init(): Promise<void>;
  completeDeferredStartup(): Promise<void>;
  retryDeferredModelRestore(): Promise<void>;
  updateTerminalTitle(): void;
  run(): Promise<void>;
  checkForPackageUpdates(): Promise<string[]>;
  checkTmuxKeyboardSetup(): Promise<string | undefined>;
  getChangelogForDisplay(): string | undefined;
  reportInstallTelemetry(version: string): void;
  getMarkdownThemeWithSettings(): MarkdownTheme;
  formatDisplayPath(p: string): string;
  formatExtensionDisplayPath(path: string): string;
  formatContextPath(p: string): string;
  getStartupModelLabel(): string;
  getStartupIdentityText(): string;
  getAtomicAnsiMarkLines(): string[];
  getStartupExpansionState(): boolean;
  getShortPath(fullPath: string, sourceInfo?: SourceInfo): string;
  getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
  getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string;
  getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
  getCompactDisplayPathSegments(resourcePath: string): string[];
  getCompactNonPackageExtensionLabel(resourcePath: string, index: number, allPaths: Array<{ path: string; segments: string[] }>): string;
  getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[];
  getDisplaySourceInfo(sourceInfo?: SourceInfo): {
    label: string;
    scopeLabel?: string;
    color: "accent" | "muted";
  };
  getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path";
  isPackageSource(sourceInfo?: SourceInfo): boolean;
  buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
    scope: "user" | "project" | "path";
    paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
    packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
  }>;
  formatScopeGroups(groups: Array<{
      scope: "user" | "project" | "path";
      paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
      packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
    }>, options: {
      formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
      formatPackagePath: (
        item: { path: string; sourceInfo?: SourceInfo },
        source: string,
      ) => string;
    }): string;
  findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined;
  formatPathWithSource(p: string, sourceInfo?: SourceInfo): string;
  formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string;
  getResourceDiagnosticsTotal(values: ResourceDiagnostic[][]): number;
  formatResourceCount(count: number, singular: string, plural?: string): string | undefined;
  addResourceDisclosure(options: {
    contextFiles: ReadonlyArray<{ path: string }>;
    skills: ReadonlyArray<{ filePath: string; name: string }>;
    prompts: ReadonlyArray<{ filePath: string; name: string }>;
    templates: ReadonlyArray<{ filePath: string; name: string }>;
    extensions: ReadonlyArray<{ path: string; sourceInfo?: SourceInfo }>;
    themes: ReadonlyArray<{ name?: string; sourcePath?: string }>;
    diagnosticsTotal: number;
    expandedBody: string;
  }): void;
  showLoadedResources(options?: {
    extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
    force?: boolean;
    showDiagnosticsWhenQuiet?: boolean;
  }): void;
  bindCurrentSessionExtensions(): Promise<void>;
  applyRuntimeSettings(): void;
  rebindCurrentSession(): Promise<void>;
  handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
  renderCurrentSessionState(): void;
  getRegisteredToolDefinition(toolName: string): ReturnType<AgentSession["getToolDefinition"]>;
  setupExtensionShortcuts(extensionRunner: ExtensionRunner): void;
  setExtensionStatus(key: string, text: string | undefined): void;
  getWorkingLoaderMessage(): string;
  createWorkingLoader(): Loader;
  stopWorkingLoader(): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: LoaderIndicatorOptions): void;
  setHiddenThinkingLabel(label?: string): void;
  setExtensionWidget(key: string, content: | string[]
      | ((tui: TUI, thm: Theme) => Component & { dispose?(): void })
      | undefined, options?: ExtensionWidgetOptions): void;
  clearExtensionWidgets(): void;
  resetExtensionUI(): void;
  renderWidgets(): void;
  renderWidgetContainer(container: Container, widgets: Map<string, Component & { dispose?(): void }>, spacerWhenEmpty: boolean, leadingSpacer: boolean): void;
  setExtensionFooter(factory: | ((
          tui: TUI,
          thm: Theme,
          footerData: ReadonlyFooterDataProvider,
        ) => Component & { dispose?(): void })
      | undefined): void;
  setExtensionHeader(factory: | ((tui: TUI, thm: Theme) => Component & { dispose?(): void })
      | undefined): void;
  addExtensionTerminalInputListener(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  clearExtensionTerminalInputListeners(): void;
  getHostCustomUiState(): HostCustomUiState;
  notifyHostCustomUiStateListeners(): void;
  beginHostInlineCustomUi(): () => void;
  beginInlineCustomUiFocusDeferral(): () => void;
  shouldDeferInlineCustomUiFocus(): boolean;
  focusHostInlineCustomUi(): boolean;
  onHostCustomUiStateChange(listener: HostCustomUiStateListener): () => void;
  createProjectTrustContext(cwd: string): ProjectTrustContext;
  createExtensionUIContext(): ExtensionUIContext;
  showExtensionSelector(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  hideExtensionSelector(): void;
  showExtensionConfirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
  promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
  showExtensionInput(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  hideExtensionInput(): void;
  showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
  hideExtensionEditor(): void;
  setCustomEditorComponent(factory: EditorFactory | undefined): void;
  showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void;
  showExtensionCustom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) =>
      | (Component & { dispose?(): void })
      | Promise<Component & { dispose?(): void }>, options?: {
      overlay?: boolean;
      deferInlineCustomUiFocus?: boolean;
      signal?: AbortSignal;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    }): Promise<T>;
  showExtensionError(extensionPath: string, error: string, stack?: string): void;
  setupKeyHandlers(): void;
  handleClipboardImagePaste(): Promise<void>;
  setupEditorSubmitHandler(): void;
  subscribeToAgent(): void;
  handleEvent(event: AgentSessionEvent): Promise<void>;
  getUserMessageText(message: Message): string;
  showStatus(message: string): void;
  chatMessageRenderOptions(): ChatMessageRenderOptions;
  addRenderedChatEntry(entry: ChatMessageEntry): Component;
  addContextCompactionSummaryToChat(result: ContextCompactionResult): void;
  addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
  renderSessionContext(sessionContext: SessionContext, options?: { updateFooter?: boolean; populateHistory?: boolean }): void;
  renderInitialMessages(): void;
  getUserInput(): Promise<string>;
  rebuildChatFromMessages(): void;
  handleCtrlC(): void;
  handleCtrlD(): void;
  shutdown(options?: { fromSignal?: boolean }): Promise<void>;
  emergencyTerminalExit(): never;
  uncaughtCrash(error: Error): never;
  checkShutdownRequested(): Promise<void>;
  registerSignalHandlers(): void;
  unregisterSignalHandlers(): void;
  handleCtrlZ(): void;
  handleFollowUp(): Promise<void>;
  handleDequeue(): void;
  refreshBuiltInHeader(): void;
  updateEditorBorderColor(): void;
  cycleThinkingLevel(): void;
  cycleModel(direction: "forward" | "backward"): Promise<void>;
  toggleToolOutputExpansion(): void;
  setToolsExpanded(expanded: boolean): void;
  toggleThinkingBlockVisibility(): void;
  openExternalEditor(): void;
  clearEditor(): void;
  showError(errorMessage: string): void;
  showWarning(warningMessage: string): void;
  showNewVersionNotification(newVersion: string): void;
  showPackageUpdateNotification(packages: string[]): void;
  getAllQueuedMessages(): { steering: string[]; followUp: string[] };
  clearAllQueues(): { steering: string[]; followUp: string[] };
  updatePendingMessagesDisplay(): void;
  restoreQueuedMessagesToEditor(options?: {
    abort?: boolean;
    currentText?: string;
  }): number;
  queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
  isExtensionCommand(text: string): boolean;
  flushCompactionQueue(options?: {
    willRetry?: boolean;
  }): Promise<void>;
  flushPendingBashComponents(): void;
  showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
  showFastModeSelector(): void;
  showSettingsSelector(): void;
  handleModelCommand(searchTerm?: string): Promise<void>;
  findExactModelMatch(searchTerm: string): Promise<Model<Api> | undefined>;
  getModelCandidates(): Promise<Model<Api>[]>;
  refreshCopilotModelCatalog(): Promise<void>;
  loadCopilotModelCatalog(): Promise<void>;
  updateAvailableProviderCount(): Promise<void>;
  maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<Api> | undefined): Promise<void>;
  showModelSelector(initialSearchInput?: string): void;
  showContextWindowSelector(model: Model<Api>): void;
  showModelsSelector(): Promise<void>;
  showUserMessageSelector(): void;
  handleCloneCommand(): Promise<void>;
  maybeSaveImplicitProjectTrustAfterReload(): boolean;
  showTrustSelector(): void;
  showTreeSelector(initialSelectedId?: string): void;
  showSessionSelector(): void;
  handleResumeSession(sessionPath: string, options?: Parameters<ExtensionCommandContext["switchSession"]>[1]): Promise<{ cancelled: boolean }>;
  getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[];
  getLogoutProviderOptions(): AuthSelectorProvider[];
  showLoginAuthTypeSelector(): void;
  showLoginProviderSelector(authType: "oauth" | "api_key"): void;
  showOAuthSelector(mode: "login" | "logout"): Promise<void>;
  completeProviderAuthentication(providerId: string, providerName: string, authType: "oauth" | "api_key", previousModel: Model<Api> | undefined): Promise<void>;
  showBedrockSetupDialog(providerId: string, providerName: string): void;
  showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void>;
  showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined>;
  showLoginDialog(providerId: string, providerName: string): Promise<void>;
  handleReloadCommand(): Promise<void>;
  handleExportCommand(text: string): Promise<void>;
  getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined;
  handleImportCommand(text: string): Promise<void>;
  handleShareCommand(): Promise<void>;
  handleCopyCommand(): Promise<void>;
  handleNameCommand(text: string): void;
  handleSessionCommand(): void;
  handleChangelogCommand(): void;
  getAppKeyDisplay(action: AppKeybinding): string;
  getEditorKeyDisplay(action: Keybinding): string;
  handleHotkeysCommand(): void;
  handleClearCommand(): Promise<void>;
  handleDebugCommand(): void;
  handleArminSaysHi(): void;
  handleDementedDelves(): void;
  handleDaxnuts(): void;
  checkDaxnutsEasterEgg(model: { provider: string; id: string }): void;
  handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
  handleCompactCommand(): Promise<void>;
  stop(): void;
  }
}
