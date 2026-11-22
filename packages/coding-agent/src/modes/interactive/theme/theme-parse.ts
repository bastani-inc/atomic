import { stripBom } from "../../../utils/text.ts";
import type { ThemeJson } from "./theme-schema.ts";
import { THEME_TOKENS, type ThemeTokenDescriptors } from "./theme-tokens.ts";

const THEME_TOKEN_MAP: ThemeTokenDescriptors = THEME_TOKENS;
const TOP_LEVEL_KEYS = new Set(["$schema", "name", "vars", "colors", "workingIndicator", "export"]);
const WORKING_INDICATOR_KEYS = new Set(["dark", "lift", "muted", "accent", "bright", "peak"]);
const EXPORT_KEYS = new Set(["pageBg", "cardBg", "infoBg"]);
const REQUIRED_COLOR_TOKENS = Object.entries(THEME_TOKEN_MAP)
	.filter(([, descriptor]) => descriptor.fallback === undefined)
	.map(([name]) => name);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): boolean {
	return (
		typeof value === "string" || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
	);
}

function validateColorSection(
	sectionName: string,
	value: unknown,
	allowedKeys: ReadonlySet<string>,
	otherErrors: string[],
): void {
	if (!isPlainObject(value)) {
		otherErrors.push(`  - /${sectionName}: must be object`);
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (!allowedKeys.has(key)) {
			otherErrors.push(`  - /${sectionName}: must NOT have additional properties (${key})`);
			continue;
		}
		if (entry !== undefined && !isColorValue(entry)) {
			otherErrors.push(`  - /${sectionName}/${key}: must be a color string or integer between 0 and 255`);
		}
	}
}

export function assertThemeNameIsValid(name: string): void {
	if (name.includes("/")) {
		throw new Error(
			`Invalid theme name "${name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
}

export function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (typeof json === "object" && json !== null && "name" in json && typeof json.name === "string") {
		assertThemeNameIsValid(json.name);
	}
	const missingColors = new Set<string>();
	const otherErrors: string[] = [];

	if (!isPlainObject(json)) {
		otherErrors.push("  - /: must be object");
	} else {
		for (const key of Object.keys(json)) {
			if (!TOP_LEVEL_KEYS.has(key)) {
				otherErrors.push(`  - /: must NOT have additional properties (${key})`);
			}
		}
		if (json.$schema !== undefined && typeof json.$schema !== "string") {
			otherErrors.push("  - /$schema: must be string");
		}
		if (typeof json.name !== "string") {
			otherErrors.push("  - /name: must be string");
		} else if (json.name.length === 0 || json.name.includes("/")) {
			otherErrors.push('  - /name: must match pattern "^[^/]+$"');
		}
		if (json.vars !== undefined) {
			if (!isPlainObject(json.vars)) {
				otherErrors.push("  - /vars: must be object");
			} else {
				for (const [key, entry] of Object.entries(json.vars)) {
					if (!isColorValue(entry)) {
						otherErrors.push(`  - /vars/${key}: must be a color string or integer between 0 and 255`);
					}
				}
			}
		}
		if (!isPlainObject(json.colors)) {
			otherErrors.push("  - /colors: must be object");
		} else {
			for (const token of REQUIRED_COLOR_TOKENS) {
				if (!Object.hasOwn(json.colors, token)) {
					missingColors.add(token);
				}
			}
			for (const [key, entry] of Object.entries(json.colors)) {
				const descriptor = Object.hasOwn(THEME_TOKEN_MAP, key) ? THEME_TOKEN_MAP[key] : undefined;
				if (descriptor === undefined) {
					otherErrors.push(`  - /colors: must NOT have additional properties (${key})`);
					continue;
				}
				if (entry === undefined && descriptor.fallback !== undefined) continue;
				if (!isColorValue(entry)) {
					otherErrors.push(`  - /colors/${key}: must be a color string or integer between 0 and 255`);
				}
			}
		}
		if (json.workingIndicator !== undefined) {
			validateColorSection("workingIndicator", json.workingIndicator, WORKING_INDICATOR_KEYS, otherErrors);
		}
		if (json.export !== undefined) {
			validateColorSection("export", json.export, EXPORT_KEYS, otherErrors);
		}
	}

	if (missingColors.size > 0 || otherErrors.length > 0) {
		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	const themeJson = json as ThemeJson;
	assertThemeNameIsValid(themeJson.name);
	return themeJson;
}

export function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}
