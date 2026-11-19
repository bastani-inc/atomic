import type { SettingsManager } from "./settings-manager-core.ts";
import type { Settings, SettingsScope } from "./settings-types.ts";

export interface SettingsManagerInternals {
	globalSettings: Settings;
	projectSettings: Settings;
	settings: Settings;
	legacyWorkflowPaths: Partial<Record<SettingsScope, string[]>>;
	markModified(field: keyof Settings, nestedKey?: string): void;
	markProjectModified(field: keyof Settings, nestedKey?: string): void;
	save(): void;
	saveProjectSettings(settings: Settings): void;
}

export function settingsInternals(manager: object): SettingsManagerInternals {
	return manager as unknown as SettingsManagerInternals;
}

/** Read-only migration input, kept out of the SDK settings interface. */
export function legacyWorkflowFilePaths(manager: SettingsManager, scope: SettingsScope): string[] {
	if (scope === "project" && !manager.isProjectTrusted()) return [];
	return [...(settingsInternals(manager).legacyWorkflowPaths[scope] ?? [])];
}

/**
 * The string entries of a list setting. Overrides reach the merged settings unvalidated, so a non-array reads as unset
 * rather than being spread into characters or throwing.
 */
export function stringEntries(value: readonly string[] | undefined): string[] {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
