import type { Transport } from "@earendil-works/pi-ai";
import { HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { DEFAULT_PROJECT_TRUST_BY_LABEL } from "./settings-selector-options.ts";
import type { DoubleEscapeAction, QueueDeliveryMode, SettingsCallbacks, TreeFilterMode } from "./settings-selector-types.ts";

export function createSettingsChangeHandler(callbacks: SettingsCallbacks): (id: string, newValue: string) => void {
	return (id, newValue) => {
		switch (id) {
			case "autocompact":
				callbacks.onAutoCompactChange(newValue === "true");
				break;
			case "show-images":
				callbacks.onShowImagesChange(newValue === "true");
				break;
			case "image-width-cells":
				callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
				break;
			case "auto-resize-images":
				callbacks.onAutoResizeImagesChange(newValue === "true");
				break;
			case "block-images":
				callbacks.onBlockImagesChange(newValue === "true");
				break;
			case "skill-commands":
				callbacks.onEnableSkillCommandsChange(newValue === "true");
				break;
			case "steering-mode":
				callbacks.onSteeringModeChange(newValue as QueueDeliveryMode);
				break;
			case "follow-up-mode":
				callbacks.onFollowUpModeChange(newValue as QueueDeliveryMode);
				break;
			case "transport":
				callbacks.onTransportChange(newValue as Transport);
				break;
			case "http-idle-timeout": {
				const selected = HTTP_IDLE_TIMEOUT_CHOICES.find((choice) => choice.label === newValue);
				callbacks.onHttpIdleTimeoutChange(selected?.timeoutMs ?? 300_000);
				break;
			}
			case "bash-interceptor":
				callbacks.onBashInterceptorEnabledChange(newValue === "true");
				break;
			case "hide-thinking":
				callbacks.onHideThinkingBlockChange(newValue === "true");
				break;
			case "collapse-changelog":
				callbacks.onCollapseChangelogChange(newValue === "true");
				break;
			case "quiet-startup":
				callbacks.onQuietStartupChange(newValue === "true");
				break;
			case "install-telemetry":
				callbacks.onEnableInstallTelemetryChange(newValue === "true");
				break;
			case "default-project-trust": {
				const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
				if (defaultProjectTrust) {
					callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
				}
				break;
			}
			case "double-escape-action":
				callbacks.onDoubleEscapeActionChange(newValue as DoubleEscapeAction);
				break;
			case "tree-filter-mode":
				callbacks.onTreeFilterModeChange(newValue as TreeFilterMode);
				break;
			case "show-hardware-cursor":
				callbacks.onShowHardwareCursorChange(newValue === "true");
				break;
			case "editor-padding":
				callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
				break;
			case "autocomplete-max-visible":
				callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
				break;
			case "clear-on-shrink":
				callbacks.onClearOnShrinkChange(newValue === "true");
				break;
			case "terminal-progress":
				callbacks.onShowTerminalProgressChange(newValue === "true");
				break;
			case "theme":
				callbacks.onThemeChange(newValue);
				break;
		}
	};
}
