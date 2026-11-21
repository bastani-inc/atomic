import { replaceControlCharacters, ScrollView, TuiAltScreen, VStack } from "@bastani/atomic-tui";
import { markEventLoopStartupComplete } from "../../core/event-loop-monitor.ts";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { formatModelLabel } from "../../core/model-label.ts";
import { isOfflineModeEnabled } from "../../core/package-manager-env.ts";
import { consumeStartupInput } from "../../main-early-input.ts";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { setDeprecationWarningSink } from "../../utils/deprecation.js";
import { ensurePngTranscoder } from "../../utils/image-convert.ts";
import { setMarkitDiagnosticSink } from "../../utils/markit.js";
import { shortenHomePath } from "../../utils/paths.ts";
import type { ToolStatus } from "../../utils/tools-manager.ts";
import { renderDiagnosticStatus } from "../interactive-engine/engine-diagnostic-view.js";
import {
	onInteractiveEngineProjectTrustChanged,
	onInteractiveEngineRemoteCommandsChanged,
	onInteractiveEngineResourceExtensionsChanged,
	onInteractiveEngineSessionStatsChanged,
	waitForInteractiveEngineBound,
} from "../interactive-engine/extension-ui-bridge.ts";
import { installAgentView } from "./agent-view/install.ts";
import {
	atomicWordmark,
	renderAtomicAssemblyBanner,
	renderStartupManifesto,
	supportsAtomicBanner,
} from "./components/atomic-banner.ts";
import { StartupIdentityComponent } from "./components/startup-identity.ts";
import { ThemedText } from "./components/themed-text.js";
import { clickableBlocksView } from "./components/transcript-block-clicks.ts";
import { bindInitialEagerSession } from "./interactive-initial-session-binding.ts";
import { InteractiveModeBase, seedStartupInput } from "./interactive-mode-base.ts";
import {
	APP_NAME,
	APP_TITLE,
	type Container,
	checkForNewPiVersion,
	composeStartupIdentity,
	configureHttpDispatcher,
	DefaultPackageManager,
	DynamicBorder,
	ENV_OFFLINE,
	ensureTool,
	getAgentDir,
	getCachedChangelog,
	getChangelogHighlights,
	getChangelogPath,
	getCwdRelativePath,
	getEntriesForVersion,
	getEnvValue,
	getMarkdownTheme,
	getNewEntries,
	getPiUserAgent,
	isInstallTelemetryEnabled,
	type MarkdownTheme,
	normalizeChangelogLinks,
	onThemeChange,
	path,
	preloadChangelog,
	recordTimeSinceReset,
	Spacer,
	setRegisteredThemes,
	spawn,
	Text,
	theme,
	VERSION,
	VERSION_ADOPTION_ENDPOINT,
	visibleWidth,
} from "./interactive-mode-deps.ts";
import {
	refreshCatalogsAfterTuiStartup,
	updateProviderCountFromSnapshot,
} from "./interactive-model-catalog-startup.ts";
import { ONBOARDING_COPY } from "./interactive-onboarding.ts";
import { holdTuiForStartupTrust } from "./interactive-startup-trust.ts";
import { restoreTerminalTitleAfterPackageCheck } from "./interactive-terminal-title.ts";
import { reportUnavailableTools } from "./interactive-unavailable-tools.ts";
import { showSessionNotices } from "./session-notices.ts";

export const shouldRefreshCatalogsOnStartup = (): boolean => !isOfflineModeEnabled();

function prepareStartupNotices(mode: InteractiveModeBase): void {
	if (mode.startupNoticesPrepared) return;
	mode.startupNoticesPrepared = true;
	mode.hadLastChangelogVersionAtStartup = Boolean(mode.settingsManager.getLastChangelogVersion?.());
	if (mode.changelogMarkdown === undefined) {
		mode.changelogMarkdown = mode.getChangelogForDisplay?.();
	}
	mode.initializeFirstRunOnboardingMarkers?.();
	if (!mode.firstRunNoticeVisible) {
		mode.firstRunNoticeVisible = mode.isFirstRunOnboardingEligible?.() ?? false;
	}
}

/**
 * Show non-fatal model-catalog warnings — today, a derived `-fast` variant suppressed because
 * something already owns that exact model ID.
 *
 * Called unconditionally at startup and again after deferred extension loading, because an extension
 * provider can introduce a collision that did not exist at startup. The last reported text is kept so
 * the second read only speaks when the diagnostic set actually changed.
 */
InteractiveModeBase.prototype.reportModelCatalogWarning = function (
	this: InteractiveModeBase,
	targetContainer: Container = this.chatContainer,
): void {
	const warning = this.session.modelRuntime.getWarning?.();
	if (!warning || warning === this.reportedModelCatalogWarning) {
		return;
	}
	this.reportedModelCatalogWarning = warning;
	this.showWarning(warning, targetContainer);
};

InteractiveModeBase.prototype.showStartupNoticesIfNeeded = function (
	this: InteractiveModeBase,
	targetContainer: Container = this.chatContainer,
): void {
	if (this.startupNoticesShown) {
		// Deferred startup asks again after extensions load: redraw What's New with their transformers, don't repeat it.
		this.startupChangelogComponent?.invalidate();
		return;
	}
	prepareStartupNotices(this);
	this.startupNoticesShown = true;

	const changelogMarkdown = this.changelogMarkdown;
	if (!changelogMarkdown && !this.firstRunNoticeVisible) {
		return;
	}

	if (changelogMarkdown) {
		if (targetContainer.children.length > 0) {
			targetContainer.addChild(new Spacer(1));
		}
		targetContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = changelogMarkdown.match(
				/##\s+\[?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha\.)?(?:0|[1-9]\d*))?)\]?/,
			);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			targetContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			targetContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
			targetContainer.addChild(new Spacer(1));
			this.startupChangelogComponent = this.createChangelogMarkdown(changelogMarkdown.trim(), 1, 0);
			targetContainer.addChild(this.startupChangelogComponent);
			targetContainer.addChild(new Spacer(1));
		}
		targetContainer.addChild(new DynamicBorder());
	}

	if (this.firstRunNoticeVisible) {
		this.firstRunOnboardingNoticeComponents = [];
		if (targetContainer.children.length > 0) {
			this.firstRunOnboardingNoticeComponents.push(new Spacer(1));
		}
		this.firstRunOnboardingNoticeComponents.push(
			new DynamicBorder(),
			new Text(ONBOARDING_COPY, 1, 0),
			new DynamicBorder(),
			new Spacer(1),
		);
		for (const component of this.firstRunOnboardingNoticeComponents) {
			targetContainer.addChild(component);
		}
		// Mark completion only after queueing the notice in the chat canvas so
		// launches that skip rendering retry the first-run notice next time.
		this.settingsManager.setOnboardedVersion(this.version);
	}

	this.ui.requestRender();
};

/** Bring fd, rg, and git to readiness, reporting progress into the transcript. */
InteractiveModeBase.prototype.ensureManagedToolsReady = function (this: InteractiveModeBase): Promise<void> {
	const statusGeneration = ++this.managedToolStatusGeneration;
	const reportStatus = (status: ToolStatus): void => {
		if (this.managedToolStatusGeneration === statusGeneration) this.showManagedToolStatus(status);
	};
	// Autocomplete needs only fd, so a slow rg or git download never delays it.
	const fdReady = ensureTool("fd", reportStatus).then((fdPath) => {
		this.fdPath = fdPath;
		this.setupAutocompleteProvider();
	});
	return Promise.all([fdReady, ensureTool("rg", reportStatus), ensureTool("git", reportStatus)])
		.then(() => undefined)
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			reportStatus({ type: "warning", message: `Tool readiness check failed: ${message}` });
		});
};

/** Show a managed-tool status update in the chat, never on the console. */
InteractiveModeBase.prototype.showManagedToolStatus = function (this: InteractiveModeBase, status: ToolStatus): void {
	if (!this.managedToolStatusStarted) {
		this.chatContainer.addChild(new Spacer(1));
		this.managedToolStatusStarted = true;
	}
	const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
	const color = status.type === "warning" ? "warning" : "dim";
	this.chatContainer.addChild(new ThemedText(() => theme.fg(color, message), 1, 0));
	this.lastStatusSpacer = undefined;
	this.lastStatusText = undefined;
	this.ui.requestRender();
};

function refreshResourceDisclosure(mode: InteractiveModeBase, options?: { keepSections?: boolean }): void {
	mode.showLoadedResources({
		force: true,
		showDiagnosticsWhenQuiet: true,
		targetContainer: mode.resourceDisclosureContainer,
		...(options?.keepSections ? { keepSections: true } : {}),
	});
}

/** How often a held approval checks again whether the screen is idle. */
const APPROVED_LISTING_RETRY_MS = 250;
const heldApprovedListings = new WeakMap<InteractiveModeBase, NodeJS.Timeout>();

function cancelApprovedResourceListing(mode: InteractiveModeBase): void {
	clearTimeout(heldApprovedListings.get(mode));
	heldApprovedListings.delete(mode);
}

/**
 * Lists the resources an approval added in the mounted resource list, in place: each section that stays keeps its
 * expansion. Rows only move while nothing on screen depends on where they are: no row above the chat's first visible
 * one changes (the chat shows its start or follows its end) and no text is selected or being selected, pressed,
 * searched or dragged. Until then the listing waits and checks again (#5693).
 */
function listApprovedResources(mode: InteractiveModeBase): void {
	cancelApprovedResourceListing(mode);
	if (!mode.isInitialized || !mode.settingsManager.isProjectTrusted()) return;
	if (mode.resourceDisclosureContainer.children.length === 0 || !mode.usesFullscreenRenderer) return;
	const view = mode.transcriptScrollView;
	const idle =
		mode.ui instanceof TuiAltScreen &&
		mode.ui.isPointerIdle() &&
		(view?.isFollowingEnd === true || view?.scrollTop === 0);
	if (!idle) {
		const retry = setTimeout(() => listApprovedResources(mode), APPROVED_LISTING_RETRY_MS);
		retry.unref?.();
		heldApprovedListings.set(mode, retry);
		return;
	}
	refreshResourceDisclosure(mode, { keepSections: true });
	mode.ui.requestRender();
}

export function attachInteractiveEngineResourceExtensionRefresh(mode: InteractiveModeBase): () => void {
	return onInteractiveEngineResourceExtensionsChanged(mode.runtimeHost, (_extensions, forNextView) => {
		if (forNextView) return;
		mode.chatContainer.invalidate();
		mode.ui.requestRender();
		if (mode.resourceDisclosureContainer.children.length > 0) refreshResourceDisclosure(mode);
	});
}

export const STARTUP_DRAFT_HELD_NOTICE = "Your earlier input is in the prompt; press Enter to send it.";

InteractiveModeBase.prototype.init = async function (this: InteractiveModeBase): Promise<void> {
	if (this.isInitialized) return;

	if (this.options.holdTuiForStartupTrust) await holdTuiForStartupTrust(this);
	this.registerSignalHandlers();

	// Keep the transcript in its own viewport and reserve the bottom chrome in a
	// fixed dock for the fullscreen renderer. The same components also feed the
	// internal main-screen fallback used for guarded terminal paths.
	this.renderWidgets(); // Initialize the widget containers
	this.transcriptScrollView = new ScrollView(this.documentContainer, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: this.settingsManager.getFullscreenScrollbar(),
		scrollbarThumbStyle: (text) => theme.bg("scrollbarThumb", text),
	});
	// A shell command waiting for the turn to end expands on a click, as it will in the chat.
	const pendingMessagesPreview = clickableBlocksView(
		this.pendingMessagesContainer,
		() => this.navigationInlineCustomUiDepth > 0,
	);
	const dock = new VStack([
		{ component: pendingMessagesPreview, shrink: 1, minSize: 0 },
		{ component: this.statusContainer, shrink: 1, minSize: 0 },
		{ component: this.widgetContainerAbove, shrink: 1, minSize: 0 },
		{ component: this.usageMeter, shrink: 1, minSize: 1 },
		{ component: this.editorContainer, shrink: 1, minSize: 3 },
		{ component: this.footerContainer, shrink: 1, minSize: 1 },
		// Keep widgetContainerBelow after the footer for #1109's stable dock order.
		{ component: this.widgetContainerBelow, shrink: 1, minSize: 0 },
	]);
	this.fullscreenDock = dock;
	this.fullscreenLayoutRoot = new VStack([
		{ component: this.transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	this.mountInteractiveTui(this.ui, [
		this.documentContainer,
		pendingMessagesPreview,
		this.statusContainer,
		this.widgetContainerAbove,
		this.usageMeter,
		this.editorContainer,
		this.footerContainer,
		this.widgetContainerBelow,
	]);
	this.ui.setFocus(this.extensionDialogs.at(-1)?.component ?? this.editor);

	this.setupKeyHandlers();
	this.setupEditorSubmitHandler();
	// The single chat screen: a subagent's transcript and the retargeted prompt, set up after the main screen's keys.
	installAgentView(this);
	// Rebuild autocomplete whenever the engine child's command catalog arrives or
	// changes (initial bind, engine restart, reload, new/resume/fork). Subscribed
	// before bind so the first async catalog fetch can never be missed. No-op when
	// the host is not isolated.
	onInteractiveEngineRemoteCommandsChanged(this.runtimeHost, (_commands, forNextView) => {
		this.setupAutocompleteProvider(forNextView ? { preserveSelection: true } : undefined);
	});
	attachInteractiveEngineResourceExtensionRefresh(this);
	onInteractiveEngineProjectTrustChanged(this.runtimeHost, (resourcesChanged) => {
		// The cwd's own load can finish before the engine's full catalog. Apply the same settings as startup,
		// without rebinding extensions or replacing the live editor and transcript.
		if (resourcesChanged) {
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applyRuntimeSettings();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			const trusted = this.settingsManager.isProjectTrusted();
			void this.themeController.applyFromSettings({ keepPreview: trusted });
			if (this.isInitialized) {
				// Withholding resources removes any preliminary project data. Approval lists the approved resources in the
				// mounted resource list in place, once nothing on screen depends on where its rows are (#5693). An open
				// completion menu keeps its rows; the next lookup offers the approved commands.
				if (!trusted) {
					cancelApprovedResourceListing(this);
					refreshResourceDisclosure(this);
				} else listApprovedResources(this);
				this.setupAutocompleteProvider(trusted ? { preserveSelection: true } : undefined);
			}
		}
		this.refreshProjectTrustWarning();
	});
	// Engine stats can land after the last event of a run; repaint so the idle footer shows them.
	onInteractiveEngineSessionStatsChanged(this.runtimeHost, () => {
		this.ui.requestRender();
	});

	const startupInput = consumeStartupInput(this.options.startupInputCapture, {
		startupDecisionPending: this.options.startupTrustPromptPossible,
	});
	seedStartupInput(
		this.pendingUserInputs,
		this.defaultEditor,
		startupInput,
		this.startupReplayInputs,
		(text) => {
			this.startupDraftText = text;
		},
		(text) => {
			this.startupReplayActiveInput = text;
		},
	);

	// Start and paint the host-owned TUI before waiting for the isolated engine.
	// The editor remains local and responsive; session binding and provider work
	// still stay behind the engine-bound gate below.
	markLifecycleTiming("tui-start");
	this.ui.start();
	markEventLoopStartupComplete();
	this.programStatus.report();
	ensurePngTranscoder(() => {
		this.ui.invalidate();
		this.ui.requestRender();
	});
	this.disposeMarkitDiagnosticSink = setMarkitDiagnosticSink((message) => renderDiagnosticStatus(message, this));
	// A deprecation found once the UI owns the terminal (a settings reload after trust, a tool call) is shown as a
	// warning in the chat instead of being written over the screen.
	this.disposeDeprecationWarningSink = installDeprecationWarningSink(this);
	this.footerDataProvider.onBranchChange(() => {
		this.ui.requestRender();
	});

	await this.themeController.applyFromSettings();

	// Add the quiet startup identity unless silenced.
	if (this.shouldShowStartupHeader()) {
		this.builtInHeader = new StartupIdentityComponent(this.ui, (width, state) =>
			this.getStartupIdentityText(width, state.gap, state.manifestoPhase),
		);

		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(this.builtInHeader);
		this.headerContainer.addChild(new Spacer(1));
	} else {
		// Minimal header when silenced
		this.builtInHeader = new Text("", 0, 0);
		this.headerContainer.addChild(this.builtInHeader);
	}
	this.showFullscreenModelScopeNotice();
	if (startupInput.heldForStartupDecision && startupInput.text.length > 0) {
		this.startupNoticesContainer.addChild(new Spacer(1));
		this.startupNoticesContainer.addChild(new Text(theme.fg("dim", STARTUP_DRAFT_HELD_NOTICE), 1, 0));
	}
	markLifecycleTiming("header-mounted");
	this.ui.requestRender();
	// This legacy mark now means the first requested identity frame. The settled
	// animation frame remains the external benchmark's startup-complete mark.
	recordTimeSinceReset("time-to-first-frame");

	// A host attaching to an already populated, unsaved engine must own its archive before it
	// can bind. Paint recent visible text while its private pages arrive, without binding a partial session.
	let bootstrapPreview: Text | undefined;
	try {
		await waitForInteractiveEngineBound(this.runtimeHost, (lines) => {
			if (this.isShuttingDown) return;
			bootstrapPreview = new Text(lines.map(replaceControlCharacters).join("\n\n"), 1, 0);
			this.chatContainer.addChild(bootstrapPreview);
			this.ui.requestRender();
		});
	} finally {
		if (bootstrapPreview) {
			this.chatContainer.removeChild(bootstrapPreview);
			this.ui.requestRender();
		}
	}
	if (this.isShuttingDown) return;
	this.isInitialized = true;
	// The isolated engine may have replaced the preliminary model/provider view.
	this.ui.requestRender();

	// fd/rg readiness runs after first paint so slow downloads never make
	// startup appear frozen. Progress reports land in the transcript: a console
	// write here lands in the alternate screen and corrupts the frame.
	void this.ensureManagedToolsReady();

	// When startup resources are deferred, keep the already-painted editor responsive.
	// Extension UI bindings are installed at the deferred reload boundary, not here,
	// so no post-paint resource work can block visible typing.
	if (this.deferredStartupPending) {
		this.applyRuntimeSettings();
		this.subscribeToAgent();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	} else {
		await preloadChangelog(getChangelogPath());
		const startup = this.sessionStartup;
		await bindInitialEagerSession(this);
		if (startup?.cancelled) return;
		void reportUnavailableTools(this);
	}

	this.attachStartupNoticesContainer();
	// Render initial messages AFTER the initial session binding is in place.
	this.renderInitialMessages();
	if (!this.deferredStartupPending) this.startSessionRecovery("startup");
	// Set up theme file watcher
	onThemeChange(() => {
		this.ui.invalidate();
		this.updateEditorBorderColor();
		this.ui.requestRender();
	});

	updateProviderCountFromSnapshot(this);
};

InteractiveModeBase.prototype.updateTerminalTitle = function (this: InteractiveModeBase): void {
	const cwdBasename = path.basename(this.sessionManager.getCwd());
	const sessionName = this.sessionManager.getSessionName();
	// Session names come from session files: a BEL or ESC in the title would end the OSC title sequence early and send
	// the rest to the terminal as escape sequences.
	const title = sessionName ? `${APP_TITLE} - ${sessionName} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`;
	this.ui.terminal.setTitle(replaceControlCharacters(title));
};

/**
 * Shows how a resumed session's checkout was prepared with the startup notices, which survive the chat rebuild that
 * follows deferred startup.
 */
/**
 * Show deprecation warnings in the UI once it owns the terminal, instead of writing them over the screen. A warning
 * raised while deferred startup is still pending (accepting startup project trust loads the project's settings) joins the
 * retained startup notices: deferred startup rebuilds the chat before releasing it, and that rebuild would drop it.
 */
export function installDeprecationWarningSink(mode: InteractiveModeBase): () => void {
	return setDeprecationWarningSink((message) =>
		mode.showWarning(message, mode.deferredStartupPending ? mode.startupNoticesContainer : mode.chatContainer),
	);
}

export function showResumeNotices(
	mode: Pick<InteractiveModeBase, "startupNoticesContainer" | "showWarning">,
	notices: readonly { readonly type: "info" | "warning"; readonly message: string }[] | undefined,
): void {
	for (const notice of notices ?? []) {
		if (notice.type === "warning") mode.showWarning(notice.message, mode.startupNoticesContainer);
		else {
			mode.startupNoticesContainer.addChild(new Spacer(1));
			mode.startupNoticesContainer.addChild(new Text(theme.fg("dim", notice.message), 1, 0));
		}
	}
}

InteractiveModeBase.prototype.run = async function (this: InteractiveModeBase): Promise<void> {
	const startup = this.sessionStartup;
	await this.init();
	if (this.isShuttingDown || startup?.cancelled || this.sessionStartup?.cancelled) return;

	if (shouldRefreshCatalogsOnStartup()) void refreshCatalogsAfterTuiStartup(this);

	setTimeout(() => {
		const startupNoticesContainer = this.startupNoticesContainer;
		checkForNewPiVersion(this.version).then((newVersion) => {
			if (newVersion) this.showNewVersionNotification(newVersion, startupNoticesContainer);
		});
		restoreTerminalTitleAfterPackageCheck(this.checkForPackageUpdates(), {
			initialized: () => this.isInitialized,
			restore: () => this.updateTerminalTitle(),
		}).then((updates) => {
			if (updates.length > 0) this.showPackageUpdateNotification(updates, startupNoticesContainer);
		});
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) this.showWarning(warning, startupNoticesContainer);
		});
		// Deferred startup releases chat output immediately after rendering the
		// disclosure, so wait only while that startup work remains in flight.
		if (!this.deferredStartupPending && !this.deferredStartupPromise) {
			void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, startupNoticesContainer);
		}
	}, 500);

	// Show startup warnings
	const { migratedProviders, startupDiagnostics, resumeNotices, initialMessage, initialImages, initialMessages } =
		this.options;

	showSessionNotices(this, startupDiagnostics);
	showResumeNotices(this, resumeNotices);

	if (migratedProviders && migratedProviders.length > 0) {
		this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
	}

	const modelsJsonError = this.session.modelRuntime.getError();
	if (modelsJsonError) {
		this.showError(`models.json error: ${modelsJsonError}`);
	}

	const modelFallbackMessage = this.runtimeHost.modelFallbackMessage;
	if (modelFallbackMessage && !this.deferredStartupPending) {
		this.showWarning(modelFallbackMessage, this.startupNoticesContainer);
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
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			this.showError(errorMessage);
		}
	}

	if (initialMessages) {
		for (const message of initialMessages) {
			try {
				await this.session.prompt(message);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	// Main interactive loop
	while (true) {
		const userInput = await this.getUserInput();
		await this.runUserPromptTurn(userInput);
	}
};

InteractiveModeBase.prototype.checkForPackageUpdates = async function (this: InteractiveModeBase): Promise<string[]> {
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

InteractiveModeBase.prototype.checkTmuxKeyboardSetup = async function (
	this: InteractiveModeBase,
): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;

	const runTmuxShow = (option: string): Promise<string | undefined> => {
		return new Promise((resolve) => {
			const proc = spawn("tmux", ["show", "-gv", option], {
				stdio: ["ignore", "pipe", "ignore"],
				env: createChildProcessEnvironment(),
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
		return `tmux extended-keys-format is xterm. ${APP_TITLE} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;
	}

	return undefined;
};

const FULL_CHANGELOG_HINT = "Run `/changelog` for the full list of changes.";

InteractiveModeBase.prototype.getChangelogForDisplay = function (this: InteractiveModeBase): string | undefined {
	// Skip changelog for resumed/continued sessions (already have messages)
	if (this.session.state.messages.length > 0) {
		return undefined;
	}

	const lastVersion = this.settingsManager.getLastChangelogVersion();
	if (!lastVersion) {
		// Fresh install - record the version, send telemetry, don't show changelog
		this.settingsManager.setLastChangelogVersion(VERSION);
		this.reportInstallTelemetry(VERSION);
		return undefined;
	}

	const changelogPath = getChangelogPath();
	const entries = getCachedChangelog(changelogPath);

	const newEntries = getNewEntries(entries, lastVersion, VERSION);
	const currentEntries = getEntriesForVersion(newEntries, VERSION);
	if (currentEntries.length > 0) {
		this.settingsManager.setLastChangelogVersion(VERSION);
		this.reportInstallTelemetry(VERSION);
		return currentEntries
			.map((e) => {
				const highlights = getChangelogHighlights(e);
				if (!highlights) return normalizeChangelogLinks(e.content, e);
				const [heading] = e.content.split("\n");
				return normalizeChangelogLinks(`${heading}\n\n${highlights}\n\n${FULL_CHANGELOG_HINT}`, e);
			})
			.join("\n\n");
	}

	return undefined;
};

InteractiveModeBase.prototype.reportInstallTelemetry = function (this: InteractiveModeBase, version: string): void {
	if (getEnvValue(ENV_OFFLINE)) {
		return;
	}

	if (!isInstallTelemetryEnabled(this.settingsManager)) {
		return;
	}

	void fetch(`${VERSION_ADOPTION_ENDPOINT}?version=${encodeURIComponent(version)}`, {
		headers: {
			"User-Agent": getPiUserAgent(version),
		},
		signal: AbortSignal.timeout(5000),
	})
		.then(() => undefined)
		.catch(() => undefined);
};

InteractiveModeBase.prototype.getMarkdownThemeWithSettings = function (this: InteractiveModeBase): MarkdownTheme {
	return {
		...getMarkdownTheme(),
		codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
	};
};

InteractiveModeBase.prototype.formatDisplayPath = function (this: InteractiveModeBase, p: string): string {
	return shortenHomePath(p);
};

InteractiveModeBase.prototype.formatExtensionDisplayPath = function (this: InteractiveModeBase, path: string): string {
	return this.formatDisplayPath(path).replace(/[\\/]index\.(?:ts|js)$/, "");
};

InteractiveModeBase.prototype.formatContextPath = function (this: InteractiveModeBase, p: string): string {
	const cwd = path.resolve(this.sessionManager.getCwd());
	const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
	const relativePath = getCwdRelativePath(absolutePath, cwd);
	if (relativePath !== undefined) {
		return relativePath;
	}

	return this.formatDisplayPath(absolutePath);
};

InteractiveModeBase.prototype.getStartupModelLabel = function (this: InteractiveModeBase): string {
	const model = this.session.state.model;
	return model ? formatModelLabel(model, { thinkingLevel: this.session.thinkingLevel || "off" }) : "no-model";
};

InteractiveModeBase.prototype.getStartupIdentityText = function (
	this: InteractiveModeBase,
	maxWidth?: number,
	gap = 0,
	manifestoPhase = 4,
): string {
	const appLabel = APP_NAME.length > 0 ? `${APP_NAME[0]!.toUpperCase()}${APP_NAME.slice(1)}` : "Atomic";
	const fg = (role: "text" | "muted" | "dim", text: string): string => theme.fg(role, text);
	const showMark = supportsAtomicBanner();
	const wordmark = showMark ? "" : `${atomicWordmark()} `;
	const title = `${wordmark}${theme.bold(fg("text", appLabel))} ${fg("muted", `v${this.version}`)}`;
	const modelLine = fg("muted", this.getStartupModelLabel());
	const markLines = showMark ? this.getAtomicAnsiMarkLines(gap) : [];
	const markWidth = Math.max(0, ...markLines.map(visibleWidth));
	const showMeta = gap === 0 || (maxWidth !== undefined && maxWidth < markWidth);
	const metaLines = showMeta
		? [title, modelLine, fg("muted", this.formatDisplayPath(this.sessionManager.getCwd()))]
		: [];
	return composeStartupIdentity(
		markLines,
		metaLines,
		maxWidth,
		gap === 0 ? renderStartupManifesto(manifestoPhase) : [],
	);
};

InteractiveModeBase.prototype.getAtomicAnsiMarkLines = function (this: InteractiveModeBase, gap = 0): string[] {
	return renderAtomicAssemblyBanner(gap, theme, this.session.thinkingLevel || "off");
};

InteractiveModeBase.prototype.getStartupExpansionState = function (this: InteractiveModeBase): boolean {
	return this.options.verbose || this.toolOutputExpanded;
};

/**
 * Fullscreen paints on the alternate screen, so the "Model scope" line cannot be printed to stdout there
 * (it would stay in the shell after exit); it goes below the header instead (upstream #11508).
 */
InteractiveModeBase.prototype.showFullscreenModelScopeNotice = function (this: InteractiveModeBase): void {
	const notice = this.options.modelScopeNotice;
	if (!notice || !this.usesFullscreenRenderer) return;
	this.headerContainer.addChild(new ThemedText(() => theme.fg("dim", notice), 1, 0));
	this.headerContainer.addChild(new Spacer(1));
};

InteractiveModeBase.prototype.shouldShowStartupHeader = function (this: InteractiveModeBase): boolean {
	return this.options.verbose === true || this.settingsManager.getQuietStartup() !== true;
};

InteractiveModeBase.prototype.shouldShowStartupDetails = function (this: InteractiveModeBase): boolean {
	return this.options.verbose === true || this.settingsManager.getQuietStartup() === false;
};
