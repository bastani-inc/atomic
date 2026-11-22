import type { Compile as TypeBoxCompile } from "@bastani/atomic-ai/utils/typebox/compile";
import type { Type as TypeBoxType } from "@bastani/atomic-ai/utils/typebox/index";
import { createModuleRequire } from "../../../utils/module-require.js";
import { stripBom } from "../../../utils/text.ts";
import type { ThemeJson, validateThemeJson } from "./theme-schema.ts";
import { createThemeJsonSchema } from "./theme-schema-factory.ts";
import { THEME_TOKENS, type ThemeTokenDescriptors } from "./theme-tokens.ts";

type ThemeValidator = typeof validateThemeJson;

const THEME_TOKEN_MAP: ThemeTokenDescriptors = THEME_TOKENS;
const TOP_LEVEL_KEYS = new Set(["$schema", "name", "vars", "colors", "workingIndicator", "export"]);
const WORKING_INDICATOR_KEYS = new Set(["dark", "lift", "muted", "accent", "bright", "peak"]);
const EXPORT_KEYS = new Set(["pageBg", "cardBg", "infoBg"]);
const REQUIRED_COLOR_TOKENS = Object.entries(THEME_TOKEN_MAP)
	.filter(([, descriptor]) => descriptor.fallback === undefined)
	.map(([name]) => name);

const TYPEBOX_THEME_DEPS_SYMBOL = Symbol.for("atomic.typeboxThemeDeps.v1");

let cachedValidator: ThemeValidator | undefined;

function getThemeValidator(): ThemeValidator {
	if (cachedValidator !== undefined) return cachedValidator;
	const bundledDeps = (globalThis as Record<symbol, unknown>)[TYPEBOX_THEME_DEPS_SYMBOL] as
		| { Type: typeof TypeBoxType; Compile: typeof TypeBoxCompile }
		| undefined;
	if (bundledDeps !== undefined) {
		cachedValidator = bundledDeps.Compile(createThemeJsonSchema(bundledDeps.Type));
		return cachedValidator;
	}
	const req = createModuleRequire(import.meta.url);
	const { Type } = req("@bastani/atomic-ai/utils/typebox/index") as { Type: typeof TypeBoxType };
	const { Compile } = req("@bastani/atomic-ai/utils/typebox/compile") as { Compile: typeof TypeBoxCompile };
	cachedValidator = Compile(createThemeJsonSchema(Type));
	return cachedValidator;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	// Reject objects with non-enumerable own properties so the TypeBox slow path handles them identically.
	return Object.keys(value).length === Object.getOwnPropertyNames(value).length;
}

function isColorValue(value: unknown): boolean {
	return (
		typeof value === "string" || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
	);
}

function isValidOptionalColorSection(value: unknown, allowedKeys: ReadonlySet<string>): boolean {
	if (!isPlainJsonObject(value)) return false;
	for (const [key, entry] of Object.entries(value)) {
		if (!allowedKeys.has(key) || !isColorValue(entry)) return false;
	}
	return true;
}

/**
 * Sound accept-only fast path for plain JSON theme objects (matching `ThemeJsonSchema` without loading TypeBox).
 * Returns `false` for any invalid theme or non-plain-object edge case so the real `Compile(ThemeJsonSchema)`
 * produces byte-identical accept/reject decisions and error messages.
 */
function isValidThemeJsonFast(json: unknown): json is ThemeJson {
	if (!isPlainJsonObject(json)) return false;
	for (const key of Object.keys(json)) {
		if (!TOP_LEVEL_KEYS.has(key)) return false;
	}
	if (Object.hasOwn(json, "$schema") && typeof json.$schema !== "string") return false;
	if (!Object.hasOwn(json, "name") || typeof json.name !== "string") return false;
	if (json.name.length === 0 || json.name.includes("/")) return false;
	if (Object.hasOwn(json, "vars")) {
		if (!isPlainJsonObject(json.vars)) return false;
		for (const entry of Object.values(json.vars)) {
			if (!isColorValue(entry)) return false;
		}
	}
	if (!Object.hasOwn(json, "colors") || !isPlainJsonObject(json.colors)) return false;
	for (const token of REQUIRED_COLOR_TOKENS) {
		if (!Object.hasOwn(json.colors, token)) return false;
	}
	for (const [key, entry] of Object.entries(json.colors)) {
		if (!Object.hasOwn(THEME_TOKEN_MAP, key) || !isColorValue(entry)) return false;
	}
	if (
		Object.hasOwn(json, "workingIndicator") &&
		!isValidOptionalColorSection(json.workingIndicator, WORKING_INDICATOR_KEYS)
	) {
		return false;
	}
	if (Object.hasOwn(json, "export") && !isValidOptionalColorSection(json.export, EXPORT_KEYS)) {
		return false;
	}
	return true;
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
	if (isValidThemeJsonFast(json)) {
		assertThemeNameIsValid(json.name);
		return json;
	}
	const validator = getThemeValidator();
	if (!validator.Check(json)) {
		const errors = Array.from(validator.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

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
