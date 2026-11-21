import { isPowerShellAvailable } from "../utils/shell.ts";
import type { Settings } from "./settings-types.ts";
import { isToolModifier } from "./tool-list-entries.js";
import { defaultToolSelectionFor } from "./tools/index.js";

export { getToolListError, isToolModifier } from "./tool-list-entries.js";

export function applyToolModifiers(base: readonly string[], entries: readonly string[]): string[] {
	const tools = [...base];
	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

export function resolveDefaultToolsWith(entries: string[], inherited: readonly string[]): string[] {
	const plain = entries.filter((entry) => !isToolModifier(entry));
	return applyToolModifiers(plain.length > 0 || entries.length === 0 ? plain : inherited, entries);
}

export function resolveDefaultTools(
	entries: string[],
	inherited: readonly string[] = defaultToolSelectionFor(isPowerShellAvailable()),
): string[] {
	return resolveDefaultToolsWith(entries, inherited);
}

/** Keys that reach an object's prototype; no settings name uses them, so settings code never reads or writes them. */
export function isPrototypeKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		if (isPrototypeKey(key)) continue;
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
	if (overrides.storage !== undefined) merged.storage = overrides.storage;
	if (overrides.sessions?.storage !== undefined) {
		merged.sessions = { ...merged.sessions, storage: overrides.sessions.storage };
	}
	const overrideTools = Array.isArray(overrides.defaultTools)
		? overrides.defaultTools.filter((entry) => typeof entry === "string")
		: undefined;
	if (
		Array.isArray(base.defaultTools) &&
		overrideTools !== undefined &&
		overrideTools.length > 0 &&
		overrideTools.every(isToolModifier)
	) {
		const baseTools = base.defaultTools.filter((entry): entry is string => typeof entry === "string");
		const plain = baseTools.filter((entry) => !isToolModifier(entry));
		merged.defaultTools =
			plain.length > 0 || baseTools.length === 0
				? applyToolModifiers(plain, [...baseTools, ...overrideTools])
				: [...baseTools, ...overrideTools];
	}
	return merged;
}
