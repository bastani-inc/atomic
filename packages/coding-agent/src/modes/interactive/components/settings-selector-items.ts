import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCapabilities, type SettingItem } from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { DEFAULT_PROJECT_TRUST_LABELS, THINKING_DESCRIPTIONS } from "./settings-selector-options.ts";
import { SelectSubmenu, ThemeSubmenu, WarningSettingsSubmenu } from "./settings-selector-submenus.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

function insertImageItems(items: SettingItem[], config: SettingsConfig): void {
	if (!getCapabilities().images) return;

	items.splice(1, 0, {
		id: "show-images",
		label: "Show images",
		description: "Render images inline in terminal",
		currentValue: config.showImages ? "true" : "false",
		values: ["true", "false"],
	});
	items.splice(2, 0, {
		id: "image-width-cells",
		label: "Image width",
		description: "Preferred inline image width in terminal cells",
		currentValue: String(config.imageWidthCells),
		values: ["60", "80", "120"],
	});
}

function insertAfter(items: SettingItem[], afterId: string, item: SettingItem): void {
	const index = items.findIndex((candidate) => candidate.id === afterId);
	items.splice(index + 1, 0, item);
}

function insertUiToggles(items: SettingItem[], config: SettingsConfig): void {
	const supportsImages = getCapabilities().images;
	items.splice(supportsImages ? 3 : 1, 0, {
		id: "auto-resize-images",
		label: "Auto-resize images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
		currentValue: config.autoResizeImages ? "true" : "false",
		values: ["true", "false"],
	});
	insertAfter(items, "auto-resize-images", {
		id: "block-images",
		label: "Block images",
		description: "Prevent images from being sent to LLM providers",
		currentValue: config.blockImages ? "true" : "false",
		values: ["true", "false"],
	});
	insertAfter(items, "block-images", {
		id: "skill-commands",
		label: "Skill commands",
		description: "Register skills as /skill:name commands",
		currentValue: config.enableSkillCommands ? "true" : "false",
		values: ["true", "false"],
	});
	insertAfter(items, "skill-commands", {
		id: "show-hardware-cursor",
		label: "Show hardware cursor",
		description: "Show the terminal cursor while still positioning it for IME support",
		currentValue: config.showHardwareCursor ? "true" : "false",
		values: ["true", "false"],
	});
	insertAfter(items, "show-hardware-cursor", {
		id: "editor-padding",
		label: "Editor padding",
		description: "Horizontal padding for input editor (0-3)",
		currentValue: String(config.editorPaddingX),
		values: ["0", "1", "2", "3"],
	});
	insertAfter(items, "editor-padding", {
		id: "autocomplete-max-visible",
		label: "Autocomplete max items",
		description: "Max visible items in autocomplete dropdown (3-20)",
		currentValue: String(config.autocompleteMaxVisible),
		values: ["3", "5", "7", "10", "15", "20"],
	});
	insertAfter(items, "autocomplete-max-visible", {
		id: "clear-on-shrink",
		label: "Clear on shrink",
		description: "Clear empty rows when content shrinks (may cause flicker)",
		currentValue: config.clearOnShrink ? "true" : "false",
		values: ["true", "false"],
	});
	insertAfter(items, "clear-on-shrink", {
		id: "terminal-progress",
		label: "Terminal progress",
		description: "Show OSC 9;4 progress indicators in the terminal tab bar",
		currentValue: config.showTerminalProgress ? "true" : "false",
		values: ["true", "false"],
	});
}

export function buildSettingsItems(config: SettingsConfig, callbacks: SettingsCallbacks): SettingItem[] {
	const followUpKey = keyDisplayText("app.message.followUp");
	let currentWarnings = { ...config.warnings };

	const items: SettingItem[] = [
		{
			id: "autocompact",
			label: "Auto-compact",
			description: "Automatically compact context when it gets too large",
			currentValue: config.autoCompact ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "steering-mode",
			label: "Steering mode",
			description:
				"enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
			currentValue: config.steeringMode,
			values: ["one-at-a-time", "all"],
		},
		{
			id: "follow-up-mode",
			label: "Follow-up mode",
			description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
			currentValue: config.followUpMode,
			values: ["one-at-a-time", "all"],
		},
		{
			id: "transport",
			label: "Transport",
			description: "Preferred transport for providers that support multiple transports",
			currentValue: config.transport,
			values: ["sse", "websocket", "websocket-cached", "auto"],
		},
		{
			id: "http-idle-timeout",
			label: "HTTP idle timeout",
			description:
				"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
			currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
			values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
		},
		{
			id: "bash-interceptor",
			label: "Bash Interceptor",
			description: "Block shell commands that have dedicated tools",
			currentValue: config.bashInterceptorEnabled ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "hide-thinking",
			label: "Hide thinking",
			description: "Hide thinking blocks in assistant responses",
			currentValue: config.hideThinkingBlock ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "collapse-changelog",
			label: "Collapse changelog",
			description: "Show condensed changelog after updates",
			currentValue: config.collapseChangelog ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "quiet-startup",
			label: "Quiet startup",
			description: "Disable verbose printing at startup",
			currentValue: config.quietStartup ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "install-telemetry",
			label: "Install telemetry",
			description: "Send an anonymous version/update ping after changelog-detected updates",
			currentValue: config.enableInstallTelemetry ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "default-project-trust",
			label: "Default project trust",
			description: "Fallback behavior when no extension or saved trust decision decides project trust",
			currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
			values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
		},
		{
			id: "double-escape-action",
			label: "Double-escape action",
			description: "Action when pressing esc twice with empty editor",
			currentValue: config.doubleEscapeAction,
			values: ["tree", "fork", "none"],
		},
		{
			id: "tree-filter-mode",
			label: "Tree filter mode",
			description: "Default filter when opening /tree",
			currentValue: config.treeFilterMode,
			values: ["default", "no-tools", "user-only", "labeled-only", "all"],
		},
		{
			id: "warnings",
			label: "Warnings",
			description: "Enable or disable individual warnings",
			currentValue: "configure",
			submenu: (_currentValue, done) =>
				new WarningSettingsSubmenu(
					currentWarnings,
					(warnings) => {
						currentWarnings = warnings;
						callbacks.onWarningsChange(warnings);
					},
					() => done(),
				),
		},
		{
			id: "thinking",
			label: "Thinking level",
			description: "Reasoning depth for thinking-capable models",
			currentValue: config.thinkingLevel,
			submenu: (currentValue, done) =>
				new SelectSubmenu(
					"Thinking Level",
					"Select reasoning depth for thinking-capable models",
					config.availableThinkingLevels.map((level) => ({
						value: level,
						label: level,
						description: THINKING_DESCRIPTIONS[level],
					})),
					currentValue,
					(value) => {
						callbacks.onThinkingLevelChange(value as ThinkingLevel);
						done(value);
					},
					() => done(),
				),
		},
		{
			id: "theme",
			label: "Theme",
			description: "Color theme for the interface",
			currentValue: config.currentTheme,
			submenu: (currentValue, done) =>
				new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
		},
	];

	insertImageItems(items, config);
	insertUiToggles(items, config);
	return items;
}
