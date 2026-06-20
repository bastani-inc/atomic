import type { Settings } from "./settings-types.ts";

export interface SettingsManagerInternals {
	globalSettings: Settings;
	projectSettings: Settings;
	settings: Settings;
	runtimeSettingsOverrides: Settings;
	markModified(field: keyof Settings, nestedKey?: string): void;
	markProjectModified(field: keyof Settings, nestedKey?: string): void;
	save(): void;
	saveProjectSettings(settings: Settings): void;
}

export function settingsInternals(manager: object): SettingsManagerInternals {
	return manager as unknown as SettingsManagerInternals;
}
