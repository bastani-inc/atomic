import { Container } from "@bastani/atomic-tui";
import { DynamicBorder } from "./dynamic-border.ts";
import { SettingsPicker } from "./settings-picker.ts";
import { createSettingsChangeHandler } from "./settings-selector-handlers.ts";
import { buildSettingsItems } from "./settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

export type { SettingsCallbacks, SettingsConfig } from "./settings-selector-types.ts";

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsPicker;

	private readonly callbacks: SettingsCallbacks;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();
		this.callbacks = callbacks;

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

	refreshSettings(config: SettingsConfig): void {
		this.settingsList.setItems(buildSettingsItems(config, this.callbacks));
	}

	/** Keep this form and its current child untouched; a later child reads its own values and save targets on open. */
	readSubmenusOnOpen(read: () => { config: SettingsConfig; callbacks: SettingsCallbacks }): void {
		this.settingsList.setSubmenuSource(() => {
			const { config, callbacks } = read();
			return buildSettingsItems(config, callbacks);
		});
	}

	getSettingsList(): SettingsPicker {
		return this.settingsList;
	}
}
