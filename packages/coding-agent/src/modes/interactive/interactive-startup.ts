import { ScrollView, VStack } from "@earendil-works/pi-tui";
import { isOfflineModeEnabled } from "../../core/package-manager-env.ts";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import {
	onInteractiveEngineRemoteCommandsChanged,
	waitForInteractiveEngineBound,
} from "../interactive-engine/extension-ui-bridge.ts";
import { renderAtomicAssemblyBanner, renderStartupManifesto } from "./components/atomic-banner.ts";
import { StartupIdentityComponent } from "./components/startup-identity.ts";
import { bindInitialEagerSession } from "./interactive-initial-session-binding.ts";
import { InteractiveModeBase, seedStartupInput } from "./interactive-mode-base.ts";
import {
	APP_NAME,
	APP_TITLE,
	type Container,
	checkForNewPiVersion,
	composeStartupIdentity,
	DefaultPackageManager,
	DynamicBorder,
	ENV_OFFLINE,
	ensureTool,
	formatCodexFastModeModelLabel,
	getAgentDir,
	getChangelogPath,
	getCwdRelativePath,
	getEntriesForVersion,
	getEnvValue,
	getMarkdownTheme,
	getNewEntries,
	getPiUserAgent,
	isInstallTelemetryEnabled,
	Markdown,
	type MarkdownTheme,
	normalizeChangelogLinks,
	onThemeChange,
	os,
	parseChangelog,
	path,
	recordTimeSinceReset,
	Spacer,
	shouldApplyCodexFastMode,
	spawn,
	Text,
	theme,
	VERSION,
	visibleWidth,
} from "./interactive-mode-deps.ts";
import {
	refreshCatalogsAfterTuiStartup,
	updateProviderCountFromSnapshot,
} from "./interactive-model-catalog-startup.ts";
import { ONBOARDING_COPY } from "./interactive-onboarding.ts";
import { restoreTerminalTitleAfterPackageCheck } from "./interactive-terminal-title.ts";

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

InteractiveModeBase.prototype.showStartupNoticesIfNeeded = function (
	this: InteractiveModeBase,
	targetContainer: Container = this.chatContainer,
): void {
	if (this.startupNoticesShown) {
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
			targetContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			targetContainer.addChild(new Spacer(1));
			targetContainer.addChild(new Markdown(changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()));
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

InteractiveModeBase.prototype.init = async function (this: InteractiveModeBase): Promise<void> {
	if (this.isInitialized) return;

	this.registerSignalHandlers();

	// Keep the transcript in its own viewport and reserve the bottom chrome in a
	// fixed dock for the fullscreen renderer. The same components also feed the
	// internal main-screen fallback used for guarded terminal paths.
	this.renderWidgets(); // Initialize with default spacer
	this.transcriptScrollView = new ScrollView(this.documentContainer, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: this.settingsManager.getFullscreenScrollbar(),
		scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
	});
	const dock = new VStack([
		{ component: this.pendingMessagesContainer, shrink: 1, minSize: 0 },
		{ component: this.statusContainer, shrink: 1, minSize: 0 },
		{ component: this.widgetContainerAbove, shrink: 1, minSize: 0 },
		{ component: this.usageMeter, shrink: 1, minSize: 1 },
		{ component: this.editorContainer, shrink: 1, minSize: 3 },
		{ component: this.footerContainer, shrink: 1, minSize: 1 },
		// Keep widgetContainerBelow after the footer for #1109's stable dock order.
		{ component: this.widgetContainerBelow, shrink: 1, minSize: 0 },
	]);
	this.fullscreenLayoutRoot = new VStack([
		{ component: this.transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	this.mountInteractiveTui(this.ui, [
		this.documentContainer,
		this.pendingMessagesContainer,
		this.statusContainer,
		this.widgetContainerAbove,
		this.usageMeter,
		this.editorContainer,
		this.footerContainer,
		this.widgetContainerBelow,
	]);
	this.ui.setFocus(this.editor);

	this.setupKeyHandlers();
	this.setupEditorSubmitHandler();
	// Rebuild autocomplete whenever the engine child's command catalog arrives or
	// changes (initial bind, engine restart, reload, new/resume/fork). Subscribed
	// before bind so the first async catalog fetch can never be missed. No-op when
	// the host is not isolated.
	onInteractiveEngineRemoteCommandsChanged(this.runtimeHost, () => {
		this.setupAutocompleteProvider();
	});

	seedStartupInput(
		this.pendingUserInputs,
		this.defaultEditor,
		this.options.startupInputCapture?.consume(),
		this.startupReplayInputs,
		(text) => {
			this.startupDraftText = text;
		},
		(text) => {
			this.startupReplayActiveInput = text;
		},
	);

	// Start UI before extension/session work; fd/rg readiness and git watching move after first paint.
	this.ui.start();
	await waitForInteractiveEngineBound(this.runtimeHost);
	recordTimeSinceReset("time-to-first-frame");
	this.footerDataProvider.onBranchChange(() => {
		this.ui.requestRender();
	});
	this.isInitialized = true;

	await this.themeController.applyFromSettings();

	// Add the quiet startup identity unless silenced.
	if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
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
	this.ui.requestRender();

	void Promise.all([ensureTool("fd"), ensureTool("rg")])
		.then(([fdPath]) => {
			this.fdPath = fdPath;
			this.setupAutocompleteProvider();
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Tool readiness check failed: ${message}`);
		});

	// When startup resources are deferred, keep the already-painted editor responsive.
	// Extension UI bindings are installed at the deferred reload boundary, not here,
	// so no post-paint resource work can block visible typing.
	if (this.deferredStartupPending) {
		this.applyRuntimeSettings();
		this.subscribeToAgent();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	} else {
		await bindInitialEagerSession(this);
	}

	this.attachStartupNoticesContainer();
	// Render initial messages AFTER the initial session binding is in place.
	this.renderInitialMessages();
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
	if (sessionName) {
		this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
	} else {
		this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
	}
};

InteractiveModeBase.prototype.run = async function (this: InteractiveModeBase): Promise<void> {
	await this.init();

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
	const { migratedProviders, initialMessage, initialImages, initialMessages } = this.options;

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

InteractiveModeBase.prototype.getChangelogForDisplay = function (this: InteractiveModeBase): string | undefined {
	// Skip changelog for resumed/continued sessions (already have messages)
	if (this.session.state.messages.length > 0) {
		return undefined;
	}

	const lastVersion = this.settingsManager.getLastChangelogVersion();
	const changelogPath = getChangelogPath();
	const entries = parseChangelog(changelogPath);

	if (!lastVersion) {
		// Fresh install - record the version, send telemetry, don't show changelog
		this.settingsManager.setLastChangelogVersion(VERSION);
		this.reportInstallTelemetry(VERSION);
		return undefined;
	}

	const newEntries = getNewEntries(entries, lastVersion, VERSION);
	const currentEntries = getEntriesForVersion(newEntries, VERSION);
	if (currentEntries.length > 0) {
		this.settingsManager.setLastChangelogVersion(VERSION);
		this.reportInstallTelemetry(VERSION);
		return currentEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
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

	void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
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
	const home = os.homedir();
	let result = p;

	// Replace home directory with ~
	if (result.startsWith(home)) {
		result = `~${result.slice(home.length)}`;
	}

	return result;
};

InteractiveModeBase.prototype.formatExtensionDisplayPath = function (this: InteractiveModeBase, path: string): string {
	let result = this.formatDisplayPath(path);
	result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
	return result;
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
	let modelLabel = model?.id ?? "no-model";

	if (model?.reasoning) {
		modelLabel = `${modelLabel} ${this.session.thinkingLevel || "off"}`;
	}

	if (!model) {
		return modelLabel;
	}

	const fastModeEnabled = shouldApplyCodexFastMode(
		model,
		this.session.settingsManager.getCodexFastModeSettings(),
		this.session.orchestrationContext,
	);
	return formatCodexFastModeModelLabel(modelLabel, fastModeEnabled);
};

InteractiveModeBase.prototype.getStartupIdentityText = function (
	this: InteractiveModeBase,
	maxWidth?: number,
	gap = 0,
	manifestoPhase = 4,
): string {
	const appLabel = APP_NAME.length > 0 ? `${APP_NAME[0]!.toUpperCase()}${APP_NAME.slice(1)}` : "Atomic";
	const noColor = process.env.NO_COLOR !== undefined;
	const fg = (role: "text" | "muted" | "dim", text: string): string => (noColor ? text : theme.fg(role, text));
	const title = `${theme.bold(fg("text", appLabel))} ${fg("muted", `v${this.version}`)}`;
	const model = this.session.state.model;
	const provider = model ? fg("dim", `(${model.provider})`) : fg("dim", "(no-provider)");
	const modelLine = `${provider} ${fg("muted", this.getStartupModelLabel())}`;
	const markLines = this.getAtomicAnsiMarkLines(gap);
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
