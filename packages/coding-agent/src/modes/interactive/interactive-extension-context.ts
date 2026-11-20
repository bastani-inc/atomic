import { replaceControlCharacters } from "@bastani/atomic-tui";
import { taskPromptHost } from "../../core/extensions/held-prompts.ts";
import { promptHandle } from "./agent-view/agent-drafts.ts";
import { openLocalHostInputForm } from "./components/host-input-form-mount.ts";
import { openLocalHostSessionPicker } from "./components/host-session-picker.ts";
import { extensionChangedScreen } from "./extension-command-hold.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type ExtensionUIContext,
	getAvailableThemesWithPaths,
	getThemeByName,
	type HostCustomUiState,
	type HostCustomUiStateListener,
	type ProjectTrustContext,
	Theme,
	theme,
} from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.addExtensionTerminalInputListener = function (
	this: InteractiveModeBase,
	handler: (data: string) => { consume?: boolean; data?: string } | undefined,
): () => void {
	const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
	this.tuiInputSubscriptions.add(subscription);
	this.extensionTerminalInputSubscriptions.add(subscription);
	return () => {
		subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.delete(subscription);
		this.tuiInputSubscriptions.delete(subscription);
	};
};

InteractiveModeBase.prototype.clearExtensionTerminalInputListeners = function (this: InteractiveModeBase): void {
	for (const subscription of this.extensionTerminalInputSubscriptions) {
		subscription.unsubscribe();
		this.tuiInputSubscriptions.delete(subscription);
	}
	this.extensionTerminalInputSubscriptions.clear();
};

InteractiveModeBase.prototype.getHostCustomUiState = function (this: InteractiveModeBase): HostCustomUiState {
	const focusDeferred = this.blockingInlineCustomUiDepth > 0 && this.pendingInlineCustomUiFocus !== undefined;
	return {
		blockingInlineCustomUiDepth: this.blockingInlineCustomUiDepth,
		blockingInlineCustomUiActive: this.blockingInlineCustomUiDepth > 0,
		...(focusDeferred ? { blockingInlineCustomUiFocusDeferred: true } : {}),
		...(this.navigationInlineCustomUiDepth > 0
			? { blockingInlineCustomUiNeedsInput: this.blockingInlineCustomUiDepth > this.navigationInlineCustomUiDepth }
			: {}),
	};
};

InteractiveModeBase.prototype.notifyHostCustomUiStateListeners = function (this: InteractiveModeBase): void {
	const state = this.getHostCustomUiState();
	for (const listener of this.hostCustomUiStateListeners) {
		try {
			listener(state);
		} catch {
			/* ignore observer errors */
		}
	}
};

InteractiveModeBase.prototype.beginHostInlineCustomUi = function (
	this: InteractiveModeBase,
	purpose?: "prompt" | "navigation",
): () => void {
	let released = false;
	this.blockingInlineCustomUiDepth++;
	if (purpose === "navigation") {
		this.navigationInlineCustomUiDepth = (this.navigationInlineCustomUiDepth ?? 0) + 1;
		if (
			this.blockingInlineCustomUiDepth <= this.navigationInlineCustomUiDepth &&
			!this.runtimeHost?.session?.isStreaming &&
			this.workingRunMeter?.snapshot() === undefined
		) {
			this.promptTurnWorkingLoaderActive = false;
			if (this.loadingAnimation) this.stopWorkingLoader?.();
		}
		this.renderWidgets?.();
	}
	this.notifyHostCustomUiStateListeners();
	return () => {
		if (released) return;
		released = true;
		this.blockingInlineCustomUiDepth = Math.max(0, this.blockingInlineCustomUiDepth - 1);
		if (purpose === "navigation") {
			this.navigationInlineCustomUiDepth = Math.max(0, this.navigationInlineCustomUiDepth - 1);
			if (
				this.navigationInlineCustomUiDepth === 0 &&
				(Boolean(this.runtimeHost?.session?.isStreaming) || this.workingRunMeter?.snapshot() !== undefined) &&
				this.workingVisible &&
				!this.loadingAnimation &&
				!this.compactionActive
			) {
				this.showWorkingLoaderNow?.();
			}
			this.renderWidgets?.();
		}
		this.notifyHostCustomUiStateListeners();
	};
};

InteractiveModeBase.prototype.beginInlineCustomUiFocusDeferral = function (this: InteractiveModeBase): () => void {
	let released = false;
	this.deferredInlineCustomUiFocusDepth++;
	this.notifyHostCustomUiStateListeners();
	return () => {
		if (released) return;
		released = true;
		this.deferredInlineCustomUiFocusDepth = Math.max(0, this.deferredInlineCustomUiFocusDepth - 1);
		if (this.deferredInlineCustomUiFocusDepth === 0) {
			this.focusHostInlineCustomUi();
		}
		this.notifyHostCustomUiStateListeners();
	};
};

InteractiveModeBase.prototype.shouldDeferInlineCustomUiFocus = function (this: InteractiveModeBase): boolean {
	return this.deferredInlineCustomUiFocusDepth > 0;
};

InteractiveModeBase.prototype.focusHostInlineCustomUi = function (this: InteractiveModeBase): boolean {
	const component = this.pendingInlineCustomUiFocus;
	if (component === undefined) return false;
	this.pendingInlineCustomUiFocus = undefined;
	this.ui.setFocus(component);
	this.ui.requestRender();
	this.notifyHostCustomUiStateListeners();
	return true;
};

InteractiveModeBase.prototype.onHostCustomUiStateChange = function (
	this: InteractiveModeBase,
	listener: HostCustomUiStateListener,
): () => void {
	this.hostCustomUiStateListeners.add(listener);
	return () => {
		this.hostCustomUiStateListeners.delete(listener);
	};
};

InteractiveModeBase.prototype.onExtensionWidgetRelease = function (
	this: InteractiveModeBase,
	key: string,
	listener: () => void,
): () => void {
	let widgetReleaseListeners = this.widgetReleaseListeners;
	if (!widgetReleaseListeners) {
		widgetReleaseListeners = new Map();
		this.widgetReleaseListeners = widgetReleaseListeners;
	}
	const listeners = widgetReleaseListeners.get(key) ?? new Set<() => void>();
	listeners.add(listener);
	widgetReleaseListeners.set(key, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) widgetReleaseListeners.delete(key);
	};
};

InteractiveModeBase.prototype.notifyExtensionWidgetRelease = function (this: InteractiveModeBase, key: string): void {
	for (const listener of this.widgetReleaseListeners?.get(key) ?? []) {
		try {
			listener();
		} catch {
			/* ignore observer errors */
		}
	}
};

InteractiveModeBase.prototype.createProjectTrustContext = function (
	this: InteractiveModeBase,
	cwd: string,
): ProjectTrustContext {
	const ui = this.createExtensionUIContext();
	const runner = this.session.extensionRunner;
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		ui: {
			select: (title, options, opts) =>
				runner.withProjectTrustPrompt("select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) =>
				runner.withProjectTrustPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) =>
				runner.withProjectTrustPrompt("input", title, () => ui.input(title, placeholder, opts)),
			notify: ui.notify,
		},
	};
};

InteractiveModeBase.prototype.createExtensionUIContext = function (this: InteractiveModeBase): ExtensionUIContext {
	// What the call shows is on the screen: an extension command's held prompt shows live with it
	// (extension-command-hold.ts). A custom view does so once it is mounted (showExtensionCustom).
	const shown = <T>(result: T): T => {
		extensionChangedScreen(this);
		return result;
	};
	return taskPromptHost({
		select: (title, options, opts) => shown(this.showExtensionSelector(title, options, opts)),
		confirm: (title, message, opts) => shown(this.showExtensionConfirm(title, message, opts)),
		input: (title, placeholder, opts) => shown(this.showExtensionInput(title, placeholder, opts)),
		notify: (message, type) => shown(this.showExtensionNotify(message, type)),
		requestRender: () => this.ui.requestRender(),
		getHostCustomUiState: () => this.getHostCustomUiState(),
		onHostCustomUiStateChange: (listener) => this.onHostCustomUiStateChange(listener),
		focusHostInlineCustomUi: () => this.focusHostInlineCustomUi(),
		onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
		setStatus: (key, text) => shown(this.setExtensionStatus(key, text)),
		setWorkingMessage: (message) => {
			this.workingMessage = message;
			this.lastWorkingMessage = message;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(message ?? this.defaultWorkingMessage);
			}
		},
		setWorkingVisible: (visible) => this.setWorkingVisible(visible),
		setWorkingIndicator: (options) => this.setWorkingIndicator(options),
		setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
		setWidget: (key, content, options) => shown(this.setExtensionWidget(key, content, options)),
		setFooter: (factory) => shown(this.setExtensionFooter(factory)),
		onWidgetRelease: (key, listener) => this.onExtensionWidgetRelease(key, listener),
		setHeader: (factory) => shown(this.setExtensionHeader(factory)),
		setTitle: (title) => this.ui.terminal.setTitle(replaceControlCharacters(title)),
		custom: (factory, options) => this.showExtensionCustom(factory, options),
		// In-process host session picker: extensions already run in the terminal
		// process here, so the selector mounts directly with no IPC. Isolated
		// mode exposes the same capability from the engine child over the
		// session-picker protocol channel; callers never branch.
		hostSessionPicker: (request) =>
			openLocalHostSessionPicker(
				{
					custom: (factory, options) => this.showExtensionCustom(factory, options),
					requestRender: () => this.ui.requestRender(),
				},
				request,
			),
		hostInputForm: (request) =>
			openLocalHostInputForm(
				{
					custom: (factory, options) => this.showExtensionCustom(factory, options),
					setWorkingVisible: (visible) => this.setWorkingVisible(visible),
				},
				request,
			),
		// The main chat's extensions write the main chat's prompt, also while the screen shows a subagent's.
		pasteToEditor: (text) => {
			const prompt = promptHandle(this, "main");
			if (prompt.isShown()) this.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
			else prompt.setText(prompt.getExpandedText() + text);
			shown(undefined);
		},
		setEditorText: (text) => shown(promptHandle(this, "main").setText(text)),
		getEditorText: () => promptHandle(this, "main").getExpandedText(),
		editor: (title, prefill, opts) => shown(this.showExtensionEditor(title, prefill, opts)),
		addAutocompleteProvider: (factory) => {
			this.autocompleteProviderWrappers.push(factory);
			this.setupAutocompleteProvider();
		},
		setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
		getEditorComponent: () => this.editorComponentFactory,
		getFooterDataProvider: () => this.footerDataProvider,
		get theme() {
			return theme;
		},
		getAllThemes: () => getAvailableThemesWithPaths(),
		getTheme: (name) => getThemeByName(name),
		setTheme: (themeOrName) => {
			if (themeOrName instanceof Theme) {
				return this.themeController.setThemeInstance(themeOrName);
			}
			const result = this.themeController.setThemeName(themeOrName);
			if (result.success && this.settingsManager.getThemeSetting() !== themeOrName) {
				this.settingsManager.setTheme(themeOrName);
			}
			return result;
		},
		getToolsExpanded: () => this.toolOutputExpanded,
		setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		getChatRenderSettings: () => {
			const rendering = this.chatMessageRenderOptions();
			return {
				hideThinkingBlock: this.hideThinkingBlock,
				hiddenThinkingLabel: this.hiddenThinkingLabel,
				toolOutputExpanded: this.toolOutputExpanded,
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
				outputPad: this.outputPad,
				renderLatex: this.settingsManager.getLatexRenderingEnabled(),
				fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
				fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
				markdownTransformers: this.getMarkdownTransformers(),
				createToolComponent: rendering.createToolComponent,
				createCustomMessageComponent: rendering.createCustomMessageComponent,
				getToolDefinition: (toolName: string) => this.getRegisteredToolDefinition(toolName),
				getCustomMessageRenderer: (customType: string) =>
					this.session.extensionRunner.getMessageRenderer(customType),
			};
		},
	});
};
