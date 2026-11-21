import { copyScopedModels } from "../../core/extensions/runner-context.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import { sessionLifetime } from "../../core/session-lifecycle-work.ts";
import { AtomicWorkingLoader } from "./components/atomic-working-status.ts";
import { mountIdleStatus } from "./components/idle-status.ts";
import { ScrollWidget } from "./components/scroll-widget.js";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	AssistantMessageComponent,
	type Component,
	Container,
	type ExtensionContext,
	type ExtensionRunner,
	type ExtensionWidgetOptions,
	type KeyId,
	keyTextHint,
	type LoaderIndicatorOptions,
	matchesKey,
	Text,
	type Theme,
	type TUI,
	theme,
} from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.setupExtensionShortcuts = function (
	this: InteractiveModeBase,
	extensionRunner: ExtensionRunner,
): void {
	const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
	if (shortcuts.size === 0) return;

	// Create a context for shortcut handlers
	const createContext = (): ExtensionContext => ({
		ui: extensionRunner.getUIContext(),
		mode: "tui",
		hasUI: true,
		get hasHumanInput() {
			return extensionRunner.createContext().hasHumanInput;
		},
		cwd: this.sessionManager.getCwd(),
		sessionManager: this.sessionManager,
		modelRegistry: new ModelRegistry(this.session.modelRuntime),
		model: this.session.model,
		// Copied through the same helper `createExtensionContext` uses: this
		// hand-built context reaches the same shortcut handlers, so it owes them
		// the same guarantee, entries included.
		scopedModels: copyScopedModels(this.session.scopedModels),
		isIdle: () => !this.session.isStreaming,
		isProjectTrusted: () => this.session.settingsManager.isProjectTrusted(),
		signal: this.session.agent.signal,
		sessionSignal: sessionLifetime(this.session),
		abort: () => this.session.abort(),
		hasPendingMessages: () => this.session.pendingMessageCount > 0,
		shutdown: () => {
			this.shutdownRequested = true;
		},
		getContextUsage: () => this.session.getContextUsage(),
		compact: (options) => {
			void (async () => {
				try {
					const result = await this.session.compact();
					options?.onComplete?.(result);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					options?.onError?.(err);
				}
			})();
		},
		getSystemPrompt: () => this.session.systemPrompt,
		getDecisionModel: () => this.session.settingsManager.getDecisionModel(),
		getHttpIdleTimeoutMs: () => this.session.settingsManager.getHttpIdleTimeoutMs(),
	});

	// Set up the extension shortcut handler on the default editor
	this.defaultEditor.onExtensionShortcut = (data: string) => {
		for (const [shortcutStr, shortcut] of shortcuts) {
			// Cast to KeyId - extension shortcuts use the same format
			if (matchesKey(data, shortcutStr as KeyId) && !shortcut.editorKeys?.some((key) => matchesKey(data, key))) {
				// Run handler async, don't block input
				Promise.resolve(shortcut.handler(createContext())).catch((err) => {
					this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
				});
				return true;
			}
		}
		return false;
	};
};

InteractiveModeBase.prototype.setExtensionStatus = function (
	this: InteractiveModeBase,
	key: string,
	text: string | undefined,
): void {
	this.footerDataProvider.setExtensionStatus(key, text);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.getWorkingLoaderMessage = function (this: InteractiveModeBase): string {
	return this.workingMessage ?? this.defaultWorkingMessage;
};

InteractiveModeBase.prototype.createWorkingLoader = function (this: InteractiveModeBase): AtomicWorkingLoader {
	const loader = new AtomicWorkingLoader(
		this.ui,
		undefined,
		(text) => theme.fg("muted", text),
		this.getWorkingLoaderMessage(),
		this.workingIndicatorOptions,
	);
	loader.setMeta(() => this.workingRunMeter.snapshot());
	return loader;
};

InteractiveModeBase.prototype.clearWorkingLoader = function (this: InteractiveModeBase): void {
	const shown = this.loadingAnimation !== undefined;
	this.loadingAnimation?.stop();
	this.loadingAnimation = undefined;
	this.workingIndicatorEmbedded = false;
	this.setEditorWorkingStatusIndicator?.(undefined);
	this.statusContainer.clear();
	// The stopped row no longer asks for frames: without one now, it stays on screen until something else draws.
	if (shown) this.ui.requestRender();
};

function stopLoader(mode: InteractiveModeBase): void {
	const hadLoader = mode.loadingAnimation !== undefined;
	const wasEmbedded = mode.workingIndicatorEmbedded;
	InteractiveModeBase.prototype.clearWorkingLoader.call(mode);
	if (hadLoader && !wasEmbedded)
		mountIdleStatus(mode.statusContainer, mode.settingsManager?.getClearOnShrink?.() ?? false);
}

/**
 * At a turn's end, keep its working row on screen, held still, while the run goes on: the next turn restarts the same
 * row in place, so no frame between two turns shows the status area without it and the chat above does not jump.
 * Only a row that is all the status area shows is held. Returns whether it was held.
 */
export function holdWorkingRowBetweenTurns(mode: InteractiveModeBase): boolean {
	const loader = mode.loadingAnimation;
	if (!(loader instanceof AtomicWorkingLoader) || loader.betweenTurns) return false;
	const shown = mode.statusContainer.children;
	const alone = mode.workingIndicatorEmbedded ? shown.length === 0 : shown.length === 1 && shown[0] === loader;
	if (!alone) return false;
	loader.holdBetweenTurns();
	return true;
}

/**
 * End a row held between turns as the turn's end used to end it. Everything but the next turn's start does this first,
 * so what it then does to the status area starts from the same state as before rows were held.
 */
export function endHeldWorkingRow(mode: InteractiveModeBase): void {
	const loader = mode.loadingAnimation;
	if (loader instanceof AtomicWorkingLoader && loader.betweenTurns) stopLoader(mode);
}

InteractiveModeBase.prototype.stopWorkingLoader = function (this: InteractiveModeBase): void {
	endHeldWorkingRow(this);
	stopLoader(this);
};

InteractiveModeBase.prototype.showWorkingLoaderNow = function (this: InteractiveModeBase): void {
	endHeldWorkingRow(this);
	// Mount the working spinner immediately, regardless of streaming state, so
	// there is no visible gap between submitting a prompt and the agent turn
	// actually starting. Prompt preflight (extension input hooks, template/skill
	// expansion, auth and compaction checks, deferred startup) runs before the
	// agent emits `agent_start`, which is otherwise the only place the loader is
	// created. Respect `workingVisible` so extensions can still suppress it.
	const pureNavigationActive =
		this.navigationInlineCustomUiDepth > 0 && this.blockingInlineCustomUiDepth <= this.navigationInlineCustomUiDepth;
	const agentTurnActive = Boolean(this.session?.isStreaming) || this.workingRunMeter?.snapshot() !== undefined;
	if (!this.workingVisible || this.loadingAnimation || (pureNavigationActive && !agentTurnActive)) {
		this.ui.requestRender();
		return;
	}
	this.statusContainer.clear();
	const loader = this.createWorkingLoader();
	this.loadingAnimation = loader;
	this.workingIndicatorEmbedded = this.setEditorWorkingStatusIndicator?.(loader) ?? false;
	if (!this.workingIndicatorEmbedded) this.statusContainer.addChild(loader);
	this.ui.requestRender();
};

function remountCompactionIndicator(mode: InteractiveModeBase): void {
	const loader = mode.autoCompactionLoader;
	if (!loader || !mode.compactionActive || mode.statusContainer.children.includes(loader)) return;
	mode.statusContainer.addChild(loader);
}

InteractiveModeBase.prototype.setWorkingVisible = function (this: InteractiveModeBase, visible: boolean): void {
	endHeldWorkingRow(this);
	this.workingVisible = visible;
	if (!visible) {
		this.stopWorkingLoader();
	} else if (
		(Boolean(this.session?.isStreaming) || this.workingRunMeter?.snapshot() !== undefined) &&
		!this.loadingAnimation &&
		!this.compactionActive
	) {
		this.statusContainer.clear();
		const loader = this.createWorkingLoader();
		this.loadingAnimation = loader;
		this.workingIndicatorEmbedded = this.setEditorWorkingStatusIndicator?.(loader) ?? false;
		if (!this.workingIndicatorEmbedded) this.statusContainer.addChild(loader);
	}
	remountCompactionIndicator(this);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.setWorkingIndicator = function (
	this: InteractiveModeBase,
	options?: LoaderIndicatorOptions,
): void {
	endHeldWorkingRow(this);
	this.workingIndicatorOptions = options;
	this.loadingAnimation?.setIndicator(options);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.setHiddenThinkingLabel = function (this: InteractiveModeBase, label?: string): void {
	this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
	for (const child of this.chatContainer.children) {
		if (child instanceof AssistantMessageComponent) {
			child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
	}
	if (this.streamingComponent) {
		this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
	}
	this.ui.requestRender();
};

InteractiveModeBase.prototype.setExtensionWidget = function (
	this: InteractiveModeBase,
	key: string,
	content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
	options?: ExtensionWidgetOptions,
): void {
	const placement = options?.placement ?? "aboveEditor";
	const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
		const existing = map.get(key);
		if (existing?.dispose) existing.dispose();
		map.delete(key);
	};

	removeExisting(this.extensionWidgetsAbove);
	removeExisting(this.extensionWidgetsBelow);

	if (content === undefined) {
		this.renderWidgets();
		this.notifyExtensionWidgetRelease(key);
		return;
	}

	let component: Component & { dispose?(): void };

	if (Array.isArray(content)) {
		// Wrap string array in a Container with Text components
		const container = new Container();
		for (const line of options?.scroll ? content : content.slice(0, InteractiveModeBase.MAX_WIDGET_LINES)) {
			container.addChild(new Text(line, 1, 0));
		}
		if (!options?.scroll && content.length > InteractiveModeBase.MAX_WIDGET_LINES) {
			container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
		}
		component = container;
	} else {
		// Factory function - create component
		component = content(this.ui, theme);
	}
	if (options?.scroll) {
		const { maxHeight, maxHeightFraction } = options.scroll;
		component = new ScrollWidget(component, maxHeight, () =>
			maxHeightFraction === undefined
				? maxHeight
				: Math.min(maxHeight, Math.max(1, Math.floor(this.ui.terminal.rows * maxHeightFraction))),
		);
	}

	const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
	targetMap.set(key, component);
	this.renderWidgets();
};

InteractiveModeBase.prototype.clearExtensionWidgets = function (this: InteractiveModeBase): void {
	const releasedKeys = new Set<string>();
	for (const [key, widget] of this.extensionWidgetsAbove) {
		widget.dispose?.();
		releasedKeys.add(key);
	}
	for (const [key, widget] of this.extensionWidgetsBelow) {
		widget.dispose?.();
		releasedKeys.add(key);
	}
	this.extensionWidgetsAbove.clear();
	this.extensionWidgetsBelow.clear();
	this.renderWidgets();
	for (const key of releasedKeys) this.notifyExtensionWidgetRelease(key);
};

InteractiveModeBase.prototype.resetExtensionUI = function (this: InteractiveModeBase): void {
	if (this.extensionDialogs.length > 0) {
		const dropped = this.extensionDialogs;
		this.extensionDialogs = [];
		for (const dialog of dropped) {
			try {
				dialog.component.dispose?.();
			} catch {}
		}
		this.showTopExtensionDialog();
		for (const dialog of dropped) dialog.release?.();
	}
	// Reload and session switches replace every extension without calling done(): remove their overlays,
	// newest first, the same way done() does, but leave the promises pending as for inline dialogs.
	for (const removeOverlay of [...this.extensionOverlays].reverse()) removeOverlay();
	this.clearExtensionTerminalInputListeners();
	this.setExtensionFooter(undefined);
	this.setExtensionHeader(undefined);
	this.clearExtensionWidgets();
	this.footerDataProvider.clearExtensionStatuses();
	this.footer.invalidate();
	this.autocompleteProviderWrappers = [];
	this.setCustomEditorComponent(undefined);
	this.setupAutocompleteProvider();
	this.defaultEditor.onExtensionShortcut = this.interactiveEngineShortcutHandler;
	this.updateTerminalTitle();
	this.workingMessage = undefined;
	this.setWorkingVisible(true);
	this.setWorkingIndicator();
	if (this.loadingAnimation) {
		this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyTextHint("app.interrupt", "Interrupt")})`);
	}
	this.setHiddenThinkingLabel();
	// The extensions that replace these report their startup errors before the transcript is redrawn: keep them for it.
	this.restartExtensionErrors = [];
};
