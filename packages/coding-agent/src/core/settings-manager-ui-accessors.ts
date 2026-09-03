import type { ScrollViewScrollbar, TerminalCapabilities } from "@earendil-works/pi-tui";
import { ENV_CLEAR_ON_SHRINK, ENV_HARDWARE_CURSOR, getEnvValue } from "../config.js";
import { SettingsManager } from "./settings-manager-core.ts";
import { settingsInternals } from "./settings-manager-internals.ts";
import type { FullscreenExitOutput, MermaidRenderingMode, WarningSettings } from "./settings-types.ts";

interface SettingsManagerUiAccessors {
	getShowImages(): boolean;
	setShowImages(show: boolean): void;
	getImageWidthCells(): number;
	setImageWidthCells(width: number): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	getShowTerminalProgress(): boolean;
	setShowTerminalProgress(enabled: boolean): void;
	getImageAutoResize(): boolean;
	setImageAutoResize(enabled: boolean): void;
	getBlockImages(): boolean;
	setBlockImages(blocked: boolean): void;
	getEnabledModels(): string[] | undefined;
	setEnabledModels(patterns: string[] | undefined): void;
	getDoubleEscapeAction(): "fork" | "tree" | "none";
	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void;
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getEditorPaddingX(): number;
	setEditorPaddingX(padding: number): void;
	getOutputPad(): 0 | 1;
	setOutputPad(padding: 0 | 1): void;
	getAutocompleteMaxVisible(): number;
	setAutocompleteMaxVisible(maxVisible: number): void;
	getCodeBlockIndent(): string;
	getMermaidRenderingMode(): MermaidRenderingMode;
	setMermaidRenderingMode(mode: MermaidRenderingMode): void;
	getLatexRenderingEnabled(): boolean;
	setLatexRenderingEnabled(enabled: boolean): void;
	getWarnings(): WarningSettings;
	setWarnings(warnings: WarningSettings): void;
	getFullscreenScrollbar(): ScrollViewScrollbar;
	setFullscreenScrollbar(mode: ScrollViewScrollbar): void;
	getFullscreenExitOutput(): FullscreenExitOutput;
	setFullscreenExitOutput(output: FullscreenExitOutput): void;
	getFullscreenCopyOnSelect(): boolean;
	setFullscreenCopyOnSelect(enabled: boolean): void;
	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities>;
}

declare module "./settings-manager-core.ts" {
	interface SettingsManager extends SettingsManagerUiAccessors {}
}

const uiAccessors: SettingsManagerUiAccessors = {
	getShowImages() {
		return settingsInternals(this).settings.terminal?.showImages ?? true;
	},

	setShowImages(show) {
		const state = settingsInternals(this);
		if (!state.globalSettings.terminal) {
			state.globalSettings.terminal = {};
		}
		state.globalSettings.terminal.showImages = show;
		state.markModified("terminal", "showImages");
		state.save();
	},

	getImageWidthCells() {
		const width = settingsInternals(this).settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	},

	setImageWidthCells(width) {
		const state = settingsInternals(this);
		if (!state.globalSettings.terminal) {
			state.globalSettings.terminal = {};
		}
		state.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		state.markModified("terminal", "imageWidthCells");
		state.save();
	},

	getClearOnShrink() {
		// Settings takes precedence, then env var, then default false
		const terminal = settingsInternals(this).settings.terminal;
		if (terminal?.clearOnShrink !== undefined) {
			return terminal.clearOnShrink;
		}
		return getEnvValue(ENV_CLEAR_ON_SHRINK) === "1";
	},

	setClearOnShrink(enabled) {
		const state = settingsInternals(this);
		if (!state.globalSettings.terminal) {
			state.globalSettings.terminal = {};
		}
		state.globalSettings.terminal.clearOnShrink = enabled;
		state.markModified("terminal", "clearOnShrink");
		state.save();
	},

	getShowTerminalProgress() {
		return settingsInternals(this).settings.terminal?.showTerminalProgress ?? false;
	},

	setShowTerminalProgress(enabled) {
		const state = settingsInternals(this);
		if (!state.globalSettings.terminal) {
			state.globalSettings.terminal = {};
		}
		state.globalSettings.terminal.showTerminalProgress = enabled;
		state.markModified("terminal", "showTerminalProgress");
		state.save();
	},

	getImageAutoResize() {
		return settingsInternals(this).settings.images?.autoResize ?? true;
	},

	setImageAutoResize(enabled) {
		const state = settingsInternals(this);
		if (!state.globalSettings.images) {
			state.globalSettings.images = {};
		}
		state.globalSettings.images.autoResize = enabled;
		state.markModified("images", "autoResize");
		state.save();
	},

	getBlockImages() {
		return settingsInternals(this).settings.images?.blockImages ?? false;
	},

	setBlockImages(blocked) {
		const state = settingsInternals(this);
		if (!state.globalSettings.images) {
			state.globalSettings.images = {};
		}
		state.globalSettings.images.blockImages = blocked;
		state.markModified("images", "blockImages");
		state.save();
	},

	getEnabledModels() {
		return settingsInternals(this).settings.enabledModels;
	},

	setEnabledModels(patterns) {
		const state = settingsInternals(this);
		state.globalSettings.enabledModels = patterns;
		state.markModified("enabledModels");
		state.save();
	},

	getDoubleEscapeAction() {
		return settingsInternals(this).settings.doubleEscapeAction ?? "tree";
	},

	setDoubleEscapeAction(action) {
		const state = settingsInternals(this);
		state.globalSettings.doubleEscapeAction = action;
		state.markModified("doubleEscapeAction");
		state.save();
	},

	getTreeFilterMode() {
		const mode = settingsInternals(this).settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	},

	setTreeFilterMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.treeFilterMode = mode;
		state.markModified("treeFilterMode");
		state.save();
	},

	getShowHardwareCursor() {
		return settingsInternals(this).settings.showHardwareCursor ?? getEnvValue(ENV_HARDWARE_CURSOR) === "1";
	},

	setShowHardwareCursor(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.showHardwareCursor = enabled;
		state.markModified("showHardwareCursor");
		state.save();
	},

	getFullscreenScrollbar() {
		const mode = settingsInternals(this).settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	},

	setFullscreenScrollbar(mode) {
		const state = settingsInternals(this);
		state.globalSettings.fullscreenScrollbar = mode;
		state.markModified("fullscreenScrollbar");
		state.save();
	},

	getFullscreenExitOutput() {
		return settingsInternals(this).settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	},

	setFullscreenExitOutput(output) {
		const state = settingsInternals(this);
		state.globalSettings.fullscreenExitOutput = output;
		state.markModified("fullscreenExitOutput");
		state.save();
	},

	getFullscreenCopyOnSelect() {
		return settingsInternals(this).settings.fullscreenCopyOnSelect !== false;
	},

	setFullscreenCopyOnSelect(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.fullscreenCopyOnSelect = enabled;
		state.markModified("fullscreenCopyOnSelect");
		state.save();
	},

	getTerminalCapabilityOverrides() {
		const terminal = settingsInternals(this).settings.terminal;
		const overrides: Partial<TerminalCapabilities> = {};
		if (typeof terminal?.hyperlinks === "boolean") overrides.hyperlinks = terminal.hyperlinks;
		if (terminal?.images === "kitty" || terminal?.images === "iterm2") overrides.images = terminal.images;
		else if (terminal?.images === false) overrides.images = null;
		if (typeof terminal?.trueColor === "boolean") overrides.trueColor = terminal.trueColor;
		return overrides;
	},

	getEditorPaddingX() {
		return settingsInternals(this).settings.editorPaddingX ?? 0;
	},

	setEditorPaddingX(padding) {
		const state = settingsInternals(this);
		state.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		state.markModified("editorPaddingX");
		state.save();
	},

	getOutputPad() {
		return settingsInternals(this).settings.outputPad === 0 ? 0 : 1;
	},

	setOutputPad(padding) {
		const state = settingsInternals(this);
		state.globalSettings.outputPad = padding;
		state.markModified("outputPad");
		state.save();
	},

	getAutocompleteMaxVisible() {
		return settingsInternals(this).settings.autocompleteMaxVisible ?? 5;
	},

	setAutocompleteMaxVisible(maxVisible) {
		const state = settingsInternals(this);
		state.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		state.markModified("autocompleteMaxVisible");
		state.save();
	},

	getCodeBlockIndent() {
		return settingsInternals(this).settings.markdown?.codeBlockIndent ?? "  ";
	},

	getMermaidRenderingMode() {
		const mode = settingsInternals(this).settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	},

	setMermaidRenderingMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.markdown ??= {};
		state.globalSettings.markdown.mermaid = mode;
		state.markModified("markdown", "mermaid");
		state.save();
	},

	getLatexRenderingEnabled() {
		return settingsInternals(this).settings.markdown?.latex !== false;
	},

	setLatexRenderingEnabled(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.markdown ??= {};
		state.globalSettings.markdown.latex = enabled;
		state.markModified("markdown", "latex");
		state.save();
	},

	getWarnings() {
		return { ...(settingsInternals(this).settings.warnings ?? {}) };
	},

	setWarnings(warnings) {
		const state = settingsInternals(this);
		state.globalSettings.warnings = { ...warnings };
		state.markModified("warnings");
		state.save();
	},
};

Object.assign(SettingsManager.prototype, uiAccessors);
