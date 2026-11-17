import { Container } from "@bastani/atomic-tui";
import { DynamicBorder } from "./dynamic-border.ts";
import { SettingsPicker } from "./settings-picker.ts";
import { createSettingsChangeHandler } from "./settings-selector-handlers.ts";
import { buildSettingsItems } from "./settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

export { decisionSettingScopes } from "./settings-selector-items.ts";
export type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsPicker;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsPicker(
			buildSettingsItems(config, callbacks),
			createSettingsChangeHandler(callbacks),
			callbacks.onCancel,
			{ title: "Settings", search: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsPicker {
		return this.settingsList;
	}
}
