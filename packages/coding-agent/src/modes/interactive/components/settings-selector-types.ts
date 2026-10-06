import type { CompactorModel } from "@bastani/pi-ai";
import type { Api, ClassifierApi, ClassifierModel, Model, Transport } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ScrollViewScrollbar, WheelScrollLines } from "@earendil-works/pi-tui";
import type {
	CacheWarmingMode,
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	QuietStartup,
	WarningSettings,
} from "../../../core/settings-manager.ts";
import type { TerminalTheme } from "../theme/theme.js";

export type QueueDeliveryMode = "all" | "one-at-a-time";
export type DoubleEscapeAction = "fork" | "tree" | "none";
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: QueueDeliveryMode;
	followUpMode: QueueDeliveryMode;
	transport: Transport;
	httpIdleTimeoutMs: number;
	cacheWarming: CacheWarmingMode;
	bashInterceptorEnabled: boolean;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	availableDefaultModels?: Model<Api>[];
	availableClassifierModels?: ClassifierModel<ClassifierApi>[];
	routerModel?: string;
	routerModelScope?: "global" | "project";
	availableCompactorModels?: CompactorModel[];
	compactionModel?: string;
	compactionModelScope?: "global" | "project";
	morphAuthenticated?: boolean;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	latexRenderingEnabled: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: DoubleEscapeAction;
	treeFilterMode: TreeFilterMode;
	showHardwareCursor: boolean;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenCopyOnSelect: boolean;
	fullscreenWheelScrollLines?: WheelScrollLines;
	editorPaddingX: number;
	outputPad: 0 | 1;
	showCacheMissNotices: boolean;
	autocompleteMaxVisible: number;
	quietStartup: QuietStartup;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: QueueDeliveryMode) => void;
	onFollowUpModeChange: (mode: QueueDeliveryMode) => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutChange: (timeoutMs: number) => void;
	onCacheWarmingChange: (mode: CacheWarmingMode) => void;
	onBashInterceptorEnabledChange: (enabled: boolean) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onRouterModelChange?: (model: string) => void;
	onCompactionModelChange?: (model: string) => void;
	onModelThinkingLevelChange?: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove?: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onLatexRenderingEnabledChange: (enabled: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: DoubleEscapeAction) => void;
	onTreeFilterModeChange: (mode: TreeFilterMode) => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onFullscreenWheelScrollLinesChange?: (lines: WheelScrollLines) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onShowCacheMissNoticesChange: (enabled: boolean) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (quiet: QuietStartup) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}
