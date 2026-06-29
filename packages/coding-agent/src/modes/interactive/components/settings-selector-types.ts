import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai/compat";
import type { DefaultProjectTrust, WarningSettings } from "../../../core/settings-manager.ts";
import type { TerminalTheme } from "../theme/theme.ts";

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
	bashInterceptorEnabled: boolean;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: DoubleEscapeAction;
	treeFilterMode: TreeFilterMode;
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
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
	onBashInterceptorEnabledChange: (enabled: boolean) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: DoubleEscapeAction) => void;
	onTreeFilterModeChange: (mode: TreeFilterMode) => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}
