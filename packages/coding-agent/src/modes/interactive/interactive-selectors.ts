import { onInteractiveEngineProjectTrustChanged } from "../interactive-engine/extension-ui-bridge.ts";
import type { SettingsCallbacks, SettingsConfig } from "./components/settings-selector-types.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Component,
	configureHttpDispatcher,
	decisionSettingScopes,
	getAvailableThemes,
	refreshCustomThemes,
	SettingsSelectorComponent,
	setDebugSetting,
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

InteractiveModeBase.prototype.showSettingsSelector = async function (this: InteractiveModeBase): Promise<void> {
	const availableThemes = getAvailableThemes();
	this.showSelector((done) => {
		const readConfig = (): SettingsConfig => {
			const project = this.settingsManager.getProjectSettings();
			return {
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
				cacheWarming: this.settingsManager.getCacheWarmingMode(),
				thinkingLevel: this.session.thinkingLevel,
				availableThinkingLevels: this.session.getAvailableThinkingLevels(),
				availableDefaultModels: [...this.session.modelRuntime.getAvailableSnapshot()],
				availableClassifierModels: [...this.session.modelRuntime.getModelsOfType("classifier")],
				modelThinkingLevels: this.settingsManager.getAllModelThinkingLevels(),
				decisionModel: this.settingsManager.getDecisionModel(),
				...decisionSettingScopes(project),
				autoAdvanceAfterSteer: this.settingsManager.getAutoAdvanceAfterSteer(),
				availableCompactorModels: [...this.session.modelRuntime.getModelsOfType("compactor")],
				morphAuthenticated: this.session.modelRuntime.hasConfiguredAuth("morph"),
				compactionModel: this.settingsManager.getCompactionModel(),
				compactionModelScope: project.compactionModel !== undefined ? "project" : "global",
				currentTheme: this.themeController.getThemeSelection() || "dark",
				terminalTheme: this.themeController.getTerminalTheme(),
				availableThemes,
				hideThinkingBlock: this.hideThinkingBlock,
				mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
				latexRenderingEnabled: this.settingsManager.getLatexRenderingEnabled(),
				collapseChangelog: this.settingsManager.getCollapseChangelog(),
				debug: this.settingsManager.getDebug(),
				enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
				doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
				treeFilterMode: this.settingsManager.getTreeFilterMode(),
				showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
				fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
				fullscreenExitOutput: this.settingsManager.getFullscreenExitOutput(),
				fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
				fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
				editorPaddingX: this.settingsManager.getEditorPaddingX(),
				outputPad: this.settingsManager.getOutputPad(),
				showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
				autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
				quietStartup: this.settingsManager.getQuietStartup(),
				defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
				clearOnShrink: this.settingsManager.getClearOnShrink(),
				showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
				warnings: this.settingsManager.getWarnings(),
			};
		};
		const callbacksFor = (config: SettingsConfig): SettingsCallbacks => ({
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
			onCacheWarmingChange: (mode) => {
				this.session.setCacheWarmingMode(mode);
			},
			onThinkingLevelChange: async (level) => {
				await this.session.setThinkingLevel(level, { persist: true });
				this.footer.invalidate();
				this.updateEditorBorderColor();
			},
			onDecisionModelChange: (model) => {
				this.settingsManager.setDecisionModel(model, config.decisionModelScope);
			},
			onAutoAdvanceAfterSteerChange: (enabled) => {
				this.settingsManager.setAutoAdvanceAfterSteer(enabled, config.autoAdvanceAfterSteerScope);
			},
			onCompactionModelChange: (model) => {
				this.settingsManager.setCompactionModel(model, config.compactionModelScope);
			},
			onModelThinkingLevelChange: (provider, modelId, level) => {
				this.settingsManager.setModelThinkingLevel(provider, modelId, level);
			},
			onModelThinkingLevelRemove: (provider, modelId) => {
				this.settingsManager.removeModelThinkingLevel(provider, modelId);
			},
			onThemeChange: (themeSetting) => {
				this.settingsManager.setTheme(themeSetting);
				void this.themeController.setThemeSetting(themeSetting);
			},
			onThemePreview: (themeName) => this.themeController.preview(themeName),
			onThemePreviewCancel: (themeName) => this.themeController.cancelPreview(themeName),
			onHideThinkingBlockChange: (hidden) => {
				this.hideThinkingBlock = hidden;
				this.settingsManager.setHideThinkingBlock(hidden);
				this.updateThinkingBlockVisibility();
			},
			onMermaidRenderingModeChange: (mode) => {
				this.mermaidUserEdit++;
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
			onDebugChange: (enabled) => {
				this.settingsManager.setDebug(enabled);
				setDebugSetting(enabled);
				this.ui.requestRender();
			},
			onEnableInstallTelemetryChange: (enabled) => {
				this.settingsManager.setEnableInstallTelemetry(enabled);
			},
			onQuietStartupChange: (quiet) => {
				this.settingsManager.setQuietStartup(quiet);
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
			onFullscreenExitOutputChange: (output) => {
				this.settingsManager.setFullscreenExitOutput(output);
			},
			onFullscreenCopyOnSelectChange: (enabled) => {
				this.settingsManager.setFullscreenCopyOnSelect(enabled);
				this.setFullscreenCopyOnSelect(enabled);
			},
			onFullscreenWheelScrollLinesChange: (lines) => {
				this.settingsManager.setFullscreenWheelScrollLines(lines);
				this.setFullscreenWheelScrollLines(lines);
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
				for (const container of [this.chatContainer, this.pendingMessagesContainer]) {
					for (const child of container.children) {
						if ("setOutputPad" in child && typeof child.setOutputPad === "function") {
							child.setOutputPad(padding);
						}
					}
				}
				this.ui.requestRender();
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
		});
		const config = readConfig();
		const callbacks = callbacksFor(config);
		const component = new SettingsSelectorComponent(config, callbacks);
		const readNextSubmenu = () => {
			const next = readConfig();
			return { config: next, callbacks: callbacksFor(next) };
		};
		if (this.deferredStartupPending && this.runtimeHost?.isProjectTrustPending?.()) {
			// The in-process host publishes the catalog only when the other startup sources have finished too.
			component.readSubmenusOnOpen(() => {
				if (this.deferredStartupPending) return { config, callbacks };
				availableThemes.splice(0, availableThemes.length, ...getAvailableThemes());
				return readNextSubmenu();
			});
		}
		const dispose = onInteractiveEngineProjectTrustChanged(this.runtimeHost, (changed) => {
			if (!changed) return;
			availableThemes.splice(0, availableThemes.length, ...getAvailableThemes());
			if (this.settingsManager.isProjectTrusted()) {
				component.readSubmenusOnOpen(readNextSubmenu);
			} else {
				// The first engine report can withdraw the saved trust a preliminary form was opened with.
				const safe = readConfig();
				Object.assign(callbacks, callbacksFor(safe));
				component.refreshSettings(safe);
				this.ui.requestRender();
			}
		});
		return {
			component,
			focus: component.getSettingsList(),
			dispose: () => {
				dispose();
				this.themeController.cancelPreview();
			},
		};
	});
	await refreshCustomThemes();
	availableThemes.splice(0, availableThemes.length, ...getAvailableThemes());
};
