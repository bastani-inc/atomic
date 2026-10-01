import type { Settings } from "./settings-types.ts";
import { getDefaultToolNames } from "./tools/index.ts";

function isToolModifier(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

export function resolveDefaultTools(entries: string[], inherited: readonly string[] = getDefaultToolNames()): string[] {
	const plain = entries.filter((entry) => !isToolModifier(entry));
	const tools = plain.length > 0 || entries.length === 0 ? plain : [...inherited];
	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

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
	const merged = deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
	const overrideTools = Array.isArray(overrides.defaultTools)
		? overrides.defaultTools.filter((entry) => typeof entry === "string")
		: undefined;
	if (
		Array.isArray(base.defaultTools) &&
		overrideTools !== undefined &&
		overrideTools.length > 0 &&
		overrideTools.every(isToolModifier)
	) {
		merged.defaultTools = resolveDefaultTools(
			overrideTools,
			resolveDefaultTools(base.defaultTools.filter((entry) => typeof entry === "string")),
		);
	}
	return merged;
}
