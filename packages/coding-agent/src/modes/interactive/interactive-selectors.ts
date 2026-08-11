import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	AssistantMessageComponent,
	type Component,
	configureHttpDispatcher,
	FastModeSelectorComponent,
	getAvailableThemes,
	SettingsSelectorComponent,
	setCodexFastModeEnvironmentSettings,
	ToolExecutionComponent,
} from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.showSelector = function (
	this: InteractiveModeBase,
	create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
): void {
	const token = {};
	let dispose: (() => void) | undefined;
	let disposed = false;
	const disposeSelector = () => {
		if (disposed) return;
		disposed = true;
		dispose?.();
	};
	const done = () => {
		disposeSelector();
		if (this.activeSelectorToken !== token) return;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
	};
	const created = create(done);
	dispose = created.dispose;
	if (disposed) {
		dispose?.();
		return;
	}
	this.disposeActiveSelector();
	this.activeSelectorToken = token;
	this.activeSelectorDispose = disposeSelector;
	this.editorContainer.clear();
	this.editorContainer.addChild(created.component);
	this.ui.setFocus(created.focus);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showFastModeSelector = function (this: InteractiveModeBase): void {
	if (!this.hasCodexFastModeSupportedModels()) {
		this.showWarning("Codex fast mode requires an available openai/* or openai-codex/* model.");
		return;
	}

	this.showSelector((done) => {
		let pendingStatusMessage: string | undefined;
		const selector = new FastModeSelectorComponent(this.settingsManager.getCodexFastModeSettings(), {
			onChange: (settings, changedRow) => {
				this.settingsManager.setCodexFastModeSettings({ [changedRow]: settings[changedRow] });
				const effectiveSettings = this.settingsManager.getCodexFastModeSettings();
				setCodexFastModeEnvironmentSettings(effectiveSettings);
				this.footer.invalidate();
				this.refreshBuiltInHeader();
				const changedLabel = changedRow === "chat" ? "Chat" : "Workflow";
				const changedState = effectiveSettings[changedRow] ? "on" : "off";
				pendingStatusMessage = `${changedLabel} fast mode ${changedState}`;
			},
			onCancel: async () => {
				await this.settingsManager.flush();
				done();
				if (pendingStatusMessage) {
					this.showStatus(pendingStatusMessage);
				}
				this.ui.requestRender();
			},
		});
		return { component: selector, focus: selector };
	});
};

InteractiveModeBase.prototype.showSettingsSelector = function (this: InteractiveModeBase): void {
	this.showSelector((done) => {
		const component = new SettingsSelectorComponent(
			{
				autoCompact: this.session.autoCompactionEnabled,
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				blockImages: this.settingsManager.getBlockImages(),
				enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
				steeringMode: this.session.steeringMode,
				followUpMode: this.session.followUpMode,
				transport: this.settingsManager.getTransport(),
				httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
				bashInterceptorEnabled: this.settingsManager.getBashInterceptorEnabled(),
				thinkingLevel: this.session.thinkingLevel,
				availableThinkingLevels: this.session.getAvailableThinkingLevels(),
				currentTheme: this.settingsManager.getThemeSetting() || "dark",
				terminalTheme: this.themeController.getTerminalTheme(),
				availableThemes: getAvailableThemes(),
				hideThinkingBlock: this.hideThinkingBlock,
				mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
				latexRenderingEnabled: this.settingsManager.getLatexRenderingEnabled(),
				collapseChangelog: this.settingsManager.getCollapseChangelog(),
				enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
				doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
				treeFilterMode: this.settingsManager.getTreeFilterMode(),
				showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
				fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
				editorPaddingX: this.settingsManager.getEditorPaddingX(),
				outputPad: this.settingsManager.getOutputPad(),
				showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
				autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
				quietStartup: this.settingsManager.getQuietStartup(),
				defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
				clearOnShrink: this.settingsManager.getClearOnShrink(),
				showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
				warnings: this.settingsManager.getWarnings(),
			},
			{
				onAutoCompactChange: (enabled) => {
					this.session.setAutoCompactionEnabled(enabled);
					this.usageMeter.setAutoCompactEnabled(enabled);
				},
				onShowImagesChange: (enabled) => {
					this.settingsManager.setShowImages(enabled);
					for (const child of this.chatContainer.children) {
						if (child instanceof ToolExecutionComponent) {
							child.setShowImages(enabled);
						}
					}
				},
				onImageWidthCellsChange: (width) => {
					this.settingsManager.setImageWidthCells(width);
					for (const child of this.chatContainer.children) {
						if (child instanceof ToolExecutionComponent) {
							child.setImageWidthCells(width);
						}
					}
				},
				onAutoResizeImagesChange: (enabled) => {
					this.settingsManager.setImageAutoResize(enabled);
				},
				onBlockImagesChange: (blocked) => {
					this.settingsManager.setBlockImages(blocked);
				},
				onEnableSkillCommandsChange: (enabled) => {
					this.settingsManager.setEnableSkillCommands(enabled);
					this.setupAutocompleteProvider();
				},
				onSteeringModeChange: (mode) => {
					this.session.setSteeringMode(mode);
				},
				onFollowUpModeChange: (mode) => {
					this.session.setFollowUpMode(mode);
				},
				onTransportChange: (transport) => {
					this.settingsManager.setTransport(transport);
					this.session.agent.transport = transport;
				},
				onHttpIdleTimeoutChange: (timeoutMs) => {
					this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
					configureHttpDispatcher(timeoutMs);
				},
				onBashInterceptorEnabledChange: (enabled) => {
					this.settingsManager.setBashInterceptorEnabled(enabled);
				},
				onThinkingLevelChange: (level) => {
					this.session.setThinkingLevel(level);
					this.footer.invalidate();
					this.updateEditorBorderColor();
				},
				onThemeChange: (themeSetting) => {
					this.settingsManager.setTheme(themeSetting);
					void this.themeController.applyFromSettings();
				},
				onThemePreview: (themeName) => this.themeController.preview(themeName),
				onHideThinkingBlockChange: (hidden) => {
					this.hideThinkingBlock = hidden;
					this.settingsManager.setHideThinkingBlock(hidden);
					for (const child of this.chatContainer.children) {
						if (child instanceof AssistantMessageComponent) {
							child.setHideThinkingBlock(hidden);
						}
					}
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
				},
				onMermaidRenderingModeChange: (mode) => {
					this.settingsManager.setMermaidRenderingMode(mode);
					this.chatContainer.invalidate();
					this.ui.requestRender();
				},
				onLatexRenderingEnabledChange: (enabled) => {
					this.settingsManager.setLatexRenderingEnabled(enabled);
					this.rebuildChatFromMessages();
				},
				onCollapseChangelogChange: (collapsed) => {
					this.settingsManager.setCollapseChangelog(collapsed);
				},
				onEnableInstallTelemetryChange: (enabled) => {
					this.settingsManager.setEnableInstallTelemetry(enabled);
				},
				onQuietStartupChange: (enabled) => {
					this.settingsManager.setQuietStartup(enabled);
				},
				onDefaultProjectTrustChange: (defaultProjectTrust) => {
					this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
				},
				onDoubleEscapeActionChange: (action) => {
					this.settingsManager.setDoubleEscapeAction(action);
				},
				onTreeFilterModeChange: (mode) => {
					this.settingsManager.setTreeFilterMode(mode);
				},
				onShowHardwareCursorChange: (enabled) => {
					this.settingsManager.setShowHardwareCursor(enabled);
					this.ui.setShowHardwareCursor(enabled);
				},
				onFullscreenScrollbarChange: (mode) => {
					this.settingsManager.setFullscreenScrollbar(mode);
					this.transcriptScrollView?.setScrollbar(mode);
					this.ui.requestRender();
				},
				onEditorPaddingXChange: (padding) => {
					this.settingsManager.setEditorPaddingX(padding);
					this.defaultEditor.setPaddingX(padding);
					if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
						this.editor.setPaddingX(padding);
					}
				},
				onOutputPadChange: (padding) => {
					this.settingsManager.setOutputPad(padding);
					this.outputPad = padding;
					this.rebuildChatFromMessages();
				},
				onShowCacheMissNoticesChange: (enabled) => {
					this.settingsManager.setShowCacheMissNotices(enabled);
				},
				onAutocompleteMaxVisibleChange: (maxVisible) => {
					this.settingsManager.setAutocompleteMaxVisible(maxVisible);
					this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
					if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
						this.editor.setAutocompleteMaxVisible(maxVisible);
					}
				},
				onClearOnShrinkChange: (enabled) => {
					this.settingsManager.setClearOnShrink(enabled);
					this.ui.setClearOnShrink(enabled);
				},
				onShowTerminalProgressChange: (enabled) => {
					this.settingsManager.setShowTerminalProgress(enabled);
				},
				onWarningsChange: (warnings) => {
					this.settingsManager.setWarnings(warnings);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			},
		);
		return { component, focus: component.getSettingsList() };
	});
};
