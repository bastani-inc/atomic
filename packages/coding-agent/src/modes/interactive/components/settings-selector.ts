import { Container, SettingsList } from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { createSettingsChangeHandler } from "./settings-selector-handlers.ts";
import { buildSettingsItems } from "./settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

export type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			buildSettingsItems(config, callbacks),
			10,
			getSettingsListTheme(),
			createSettingsChangeHandler(callbacks),
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
