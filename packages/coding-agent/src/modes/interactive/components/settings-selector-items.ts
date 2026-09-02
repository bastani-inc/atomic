import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCapabilities, type SettingItem } from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { DEFAULT_PROJECT_TRUST_LABELS } from "./settings-selector-options.ts";
import { SelectSubmenu, ThemeSubmenu, WarningSettingsSubmenu } from "./settings-selector-submenus.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

/**
 * Sentinel row shown when no default-model catalog entry exists to configure.
 * Upstream uses a double-underscore `none` marker; Atomic must not, because
 * `test/ci/subagents-clean-break-contracts.test.ts` bans that exact literal as
 * a deleted subagent environment key.
 */
const NO_DEFAULT_MODELS_VALUE = "__no-models__";

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
		id: "fullscreen-scrollbar",
		label: "Fullscreen scrollbar",
		description: "Scrollbar behavior for the fullscreen transcript",
		currentValue: config.fullscreenScrollbar,
		values: ["auto", "always", "hidden"],
	});
	insertAfter(items, "fullscreen-scrollbar", {
		id: "fullscreen-exit-output",
		label: "Fullscreen exit output",
		description: "Print the transcript or only a session resume hint when exiting",
		currentValue: config.fullscreenExitOutput,
		values: ["transcript", "resume-hint"],
	});
	insertAfter(items, "fullscreen-exit-output", {
		id: "fullscreen-copy-on-select",
		label: "Fullscreen copy on select",
		description: "Copy selected transcript text automatically on mouse release",
		currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
		values: ["true", "false"],
	});
	insertAfter(items, "fullscreen-copy-on-select", {
		id: "editor-padding",
		label: "Editor padding",
		description: "Horizontal padding for input editor (0-3)",
		currentValue: String(config.editorPaddingX),
		values: ["0", "1", "2", "3"],
	});
	insertAfter(items, "editor-padding", {
		id: "output-padding",
		label: "Output padding",
		description: "Horizontal padding for rendered chat output (0-1)",
		currentValue: String(config.outputPad),
		values: ["0", "1"],
	});
	insertAfter(items, "output-padding", {
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
	insertAfter(items, "terminal-progress", {
		id: "cache-miss-notices",
		label: "Cache miss notices",
		description: "Show prompt-cache misses and compaction or branch-summary billing",
		currentValue: config.showCacheMissNotices ? "true" : "false",
		values: ["true", "false"],
	});
}

export function buildSettingsItems(config: SettingsConfig, callbacks: SettingsCallbacks): SettingItem[] {
	const followUpKey = keyDisplayText("app.message.followUp");
	let currentWarnings = { ...config.warnings };

	const items: SettingItem[] = [
		{
			id: "keybindings",
			label: "Keybindings",
			description:
				"Edit this file, then run /reload. /hotkeys shows common active and extension shortcuts; the Keybindings documentation is the complete reference.",
			currentValue: config.keybindingsPath,
		},
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
			id: "mermaid-rendering",
			label: "Mermaid diagrams",
			description: "Render Mermaid code blocks as Unicode diagrams",
			currentValue: config.mermaidRenderingMode,
			values: ["off", "final", "streaming"],
		},
		{
			id: "latex-rendering",
			label: "LaTeX math",
			description: "Render LaTeX expressions as Unicode math",
			currentValue: config.latexRenderingEnabled ? "true" : "false",
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
			id: "model-thinking",
			label: "Default thinking level per model",
			description: "Search models and set a startup thinking override",
			currentValue:
				Object.keys(config.modelThinkingLevels ?? {}).length === 0
					? "none"
					: `${Object.keys(config.modelThinkingLevels ?? {}).length} configured`,
			submenu: (_currentValue, done) => {
				const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
				const thinkingCountLabel = () => {
					const count = Object.keys(config.modelThinkingLevels ?? {}).length;
					return count === 0 ? "none" : `${count} configured`;
				};
				const options = (config.availableDefaultModels ?? []).flatMap((model) => {
					const key = `${model.provider}/${model.id}`;
					const available = model.reasoning ? levels : (["off"] as ThinkingLevel[]);
					// Upstream pi #8900 marks the active option with a leading "✓ " so it stays
					// visible while the cursor browses elsewhere. Upstream marks the level label;
					// Atomic flattened the two-stage picker into one model × level list, so the
					// marker goes on the row whose level is the configured override.
					const activeLevel = config.modelThinkingLevels?.[key];
					const items = available.map((level) => ({
						value: `${key}\0${level}`,
						label: `${level === activeLevel ? "✓ " : "  "}${model.id} [${model.provider}]`,
						description: `${level}${activeLevel === level ? " · default" : ""}`,
					}));
					if (activeLevel !== undefined)
						items.push({
							value: `${key}\0`,
							label: `  ${model.id} [${model.provider}]`,
							description: "clear override",
						});
					return items;
				});
				// An empty catalog must explain itself instead of opening a zero-row
				// picker; upstream 2ff8ba6223/5133c9284f use a sentinel row for this.
				if (options.length === 0)
					options.push({
						value: NO_DEFAULT_MODELS_VALUE,
						label: "No models available",
						description: "Log in to a provider or configure an API key first",
					});
				return new SelectSubmenu(
					"Per-Model Thinking Level",
					"Select a model and thinking level",
					options,
					"",
					(value) => {
						if (value === NO_DEFAULT_MODELS_VALUE) {
							done();
							return;
						}
						const [key, level] = value.split("\0");
						const slash = key.indexOf("/");
						const provider = key.slice(0, slash);
						const modelId = key.slice(slash + 1);
						if (level) {
							callbacks.onModelThinkingLevelChange?.(provider, modelId, level as ThinkingLevel);
							config.modelThinkingLevels = { ...config.modelThinkingLevels, [key]: level as ThinkingLevel };
						} else {
							callbacks.onModelThinkingLevelRemove?.(provider, modelId);
							const next = { ...config.modelThinkingLevels };
							delete next[key];
							config.modelThinkingLevels = next;
						}
						done(thinkingCountLabel());
					},
					() => done(),
					undefined,
					true,
				);
			},
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
