import type { Settings } from "./settings-types.ts";

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
export function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}
