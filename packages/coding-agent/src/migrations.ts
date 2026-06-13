/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentConfigPaths, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { isLegacyEnvVarNameConfigValue } from "./core/resolve-config-value.ts";
import { stripJsonComments } from "./utils/json.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

interface ConfigValueMigration {
	location: string;
	from: string;
	to: string;
}

function migrateLegacyEnvVarString(value: string): string | undefined {
	return isLegacyEnvVarNameConfigValue(value) && process.env[value] !== undefined ? `$${value}` : undefined;
}

function migrateStringProperty(
	record: Record<string, unknown>,
	key: string,
	location: string,
	migrations: ConfigValueMigration[],
): boolean {
	const value = record[key];
	if (typeof value !== "string") return false;
	const migrated = migrateLegacyEnvVarString(value);
	if (migrated === undefined) return false;
	record[key] = migrated;
	migrations.push({ location, from: value, to: migrated });
	return true;
}

function migrateHeadersConfig(headers: unknown, location: string, migrations: ConfigValueMigration[]): boolean {
	if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return false;
	const headerRecord = headers as Record<string, unknown>;
	let migrated = false;
	for (const [key, value] of Object.entries(headerRecord)) {
		if (typeof value !== "string") continue;
		const migratedValue = migrateLegacyEnvVarString(value);
		if (migratedValue === undefined) continue;
		headerRecord[key] = migratedValue;
		migrations.push({ location: `${location}[${JSON.stringify(key)}]`, from: value, to: migratedValue });
		migrated = true;
	}
	return migrated;
}

function migrateAuthJsonConfigValues(agentDir: string): ConfigValueMigration[] {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return [];

	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const authData = parsed as Record<string, unknown>;

		const migrations: ConfigValueMigration[] = [];
		for (const [provider, credential] of Object.entries(authData)) {
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) continue;
			const credentialRecord = credential as Record<string, unknown>;
			if (credentialRecord.type !== "api_key") continue;
			migrateStringProperty(credentialRecord, "key", `auth.json[${JSON.stringify(provider)}].key`, migrations);
		}

		if (migrations.length === 0) return [];
		writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
		chmodSync(authPath, 0o600);
		return migrations;
	} catch {
		return [];
	}
}

interface JsonRewriteContext {
	type: "object" | "array";
	path: string[];
	pendingKey?: string;
}

function isProviderConfigPath(parentPath: string[]): boolean {
	return parentPath.length === 2 && parentPath[0] === "providers";
}

function isMigratableHeadersPath(parentPath: string[]): boolean {
	if (parentPath[0] !== "providers") return false;
	// providers.<provider>.headers
	if (parentPath.length === 3 && parentPath[2] === "headers") return true;
	// providers.<provider>.models[].headers
	if (parentPath.length === 4 && parentPath[2] === "models" && parentPath[3] === "headers") return true;
	// providers.<provider>.modelOverrides.<modelId>.headers
	if (parentPath.length === 5 && parentPath[2] === "modelOverrides" && parentPath[4] === "headers") return true;
	return false;
}

function migrationReplacementForKey(key: string, value: string, parentPath: string[], migrations: ConfigValueMigration[]): string | undefined {
	if (key !== "apiKey" && !isMigratableHeadersPath(parentPath)) return undefined;
	if (key === "apiKey" && !isProviderConfigPath(parentPath)) return undefined;

	for (const migration of migrations) {
		if (migration.from !== value) continue;
		if (key === "apiKey" && migration.location.endsWith(".apiKey")) return migration.to;
		if (isMigratableHeadersPath(parentPath) && migration.location.includes(".headers[") && migration.location.endsWith(`[${JSON.stringify(key)}]`)) {
			return migration.to;
		}
	}
	return undefined;
}

function skipJsoncTrivia(content: string, index: number): number {
	let current = index;
	while (current < content.length) {
		const char = content[current];
		const next = content[current + 1];
		if (char !== undefined && /\s/.test(char)) {
			current++;
			continue;
		}
		if (char === "/" && next === "/") {
			current += 2;
			while (current < content.length && content[current] !== "\n") current++;
			continue;
		}
		if (char === "/" && next === "*") {
			current += 2;
			while (current < content.length && !(content[current] === "*" && content[current + 1] === "/")) current++;
			current = Math.min(content.length, current + 2);
			continue;
		}
		break;
	}
	return current;
}

function replaceMigratedJsonStringValues(content: string, migrations: ConfigValueMigration[]): string {
	if (migrations.length === 0) return content;

	let result = "";
	let index = 0;
	let inLineComment = false;
	let inBlockComment = false;
	const stack: JsonRewriteContext[] = [];

	function consumePendingContainerPath(): string[] {
		const parent = stack[stack.length - 1];
		if (!parent) return [];
		if (parent.type === "object" && parent.pendingKey !== undefined) {
			const path = [...parent.path, parent.pendingKey];
			parent.pendingKey = undefined;
			return path;
		}
		return [...parent.path];
	}

	while (index < content.length) {
		const char = content[index]!;
		const next = content[index + 1];

		if (inLineComment) {
			result += char;
			index++;
			if (char === "\n") inLineComment = false;
			continue;
		}

		if (inBlockComment) {
			result += char;
			if (char === "*" && next === "/") {
				result += next;
				index += 2;
				inBlockComment = false;
			} else {
				index++;
			}
			continue;
		}

		if (char === "/" && next === "/") {
			result += char + next;
			index += 2;
			inLineComment = true;
			continue;
		}

		if (char === "/" && next === "*") {
			result += char + next;
			index += 2;
			inBlockComment = true;
			continue;
		}

		if (char === "{") {
			stack.push({ type: "object", path: consumePendingContainerPath() });
			result += char;
			index++;
			continue;
		}

		if (char === "[") {
			stack.push({ type: "array", path: consumePendingContainerPath() });
			result += char;
			index++;
			continue;
		}

		if (char === "}" || char === "]") {
			stack.pop();
			result += char;
			index++;
			continue;
		}

		if (char !== '"') {
			result += char;
			index++;
			continue;
		}

		const stringStart = index;
		index++;
		let escaped = false;
		while (index < content.length) {
			const current = content[index]!;
			index++;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (current === "\\") {
				escaped = true;
				continue;
			}
			if (current === '"') break;
		}

		const rawString = content.slice(stringStart, index);
		const activeContext = stack[stack.length - 1];
		const afterString = skipJsoncTrivia(content, index);
		const isObjectKey = activeContext?.type === "object" && content[afterString] === ":";

		if (isObjectKey) {
			try {
				activeContext.pendingKey = JSON.parse(rawString) as string;
			} catch {
				activeContext.pendingKey = undefined;
			}
			result += rawString;
			continue;
		}

		try {
			const value = JSON.parse(rawString) as unknown;
			const key = activeContext?.type === "object" ? activeContext.pendingKey : undefined;
			if (typeof value === "string" && key !== undefined) {
				const migrated = migrationReplacementForKey(key, value, activeContext.path, migrations);
				result += migrated === undefined ? rawString : JSON.stringify(migrated);
				activeContext.pendingKey = undefined;
			} else {
				result += rawString;
			}
		} catch {
			result += rawString;
		}
	}

	return result;
}

function migrateModelsJsonConfigValues(agentDir: string): ConfigValueMigration[] {
	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) return [];

	try {
		const content = readFileSync(modelsPath, "utf-8");
		const parsed = JSON.parse(stripJsonComments(content)) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const modelsData = parsed as Record<string, unknown>;
		const providers = modelsData.providers;
		if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return [];

		const migrations: ConfigValueMigration[] = [];
		for (const [provider, providerConfig] of Object.entries(providers)) {
			if (typeof providerConfig !== "object" || providerConfig === null || Array.isArray(providerConfig)) continue;
			const providerRecord = providerConfig as Record<string, unknown>;
			const providerLocation = `models.json.providers[${JSON.stringify(provider)}]`;
			migrateStringProperty(providerRecord, "apiKey", `${providerLocation}.apiKey`, migrations);
			migrateHeadersConfig(providerRecord.headers, `${providerLocation}.headers`, migrations);

			if (Array.isArray(providerRecord.models)) {
				for (let index = 0; index < providerRecord.models.length; index++) {
					const modelConfig = providerRecord.models[index];
					if (typeof modelConfig !== "object" || modelConfig === null || Array.isArray(modelConfig)) continue;
					const modelRecord = modelConfig as Record<string, unknown>;
					const modelKey = typeof modelRecord.id === "string" ? JSON.stringify(modelRecord.id) : String(index);
					migrateHeadersConfig(modelRecord.headers, `${providerLocation}.models[${modelKey}].headers`, migrations);
				}
			}

			const modelOverrides = providerRecord.modelOverrides;
			if (typeof modelOverrides === "object" && modelOverrides !== null && !Array.isArray(modelOverrides)) {
				for (const [modelId, modelOverride] of Object.entries(modelOverrides)) {
					if (typeof modelOverride !== "object" || modelOverride === null || Array.isArray(modelOverride))
						continue;
					const modelOverrideRecord = modelOverride as Record<string, unknown>;
					migrateHeadersConfig(
						modelOverrideRecord.headers,
						`${providerLocation}.modelOverrides[${JSON.stringify(modelId)}].headers`,
						migrations,
					);
				}
			}
		}

		if (migrations.length === 0) return [];
		writeFileSync(modelsPath, replaceMigratedJsonStringValues(content, migrations), "utf-8");
		return migrations;
	} catch {
		return [];
	}
}

function getAgentDirsForConfigMigration(): string[] {
	const dirs = new Set<string>();
	for (const path of [...getAgentConfigPaths("auth.json"), ...getAgentConfigPaths("models.json")]) {
		dirs.add(dirname(path));
	}
	return [...dirs];
}

function migrateExplicitEnvVarConfigValues(): void {
	const migrations = getAgentDirsForConfigMigration().flatMap((agentDir) => [
		...migrateAuthJsonConfigValues(agentDir),
		...migrateModelsJsonConfigValues(agentDir),
	]);
	if (migrations.length === 0) return;

	const details = migrations.map((migration) => `  - ${migration.location}: ${migration.from} -> ${migration.to}`);
	console.log(
		chalk.yellow(
			[
				"Warning: Migrated API key/header environment references to explicit $ENV_VAR syntax. Plain strings will be treated as literals.",
				...details,
			].join("\n"),
		),
	);
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string, options?: { projectTrusted?: boolean }): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	if (options?.projectTrusted !== false) {
		migrateCommandsToPrompts(projectDir, "Project");
	}

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...(options?.projectTrusted === false ? [] : checkDeprecatedExtensionDirs(projectDir, "Project")),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(
	cwd: string,
	options?: { projectTrusted?: boolean },
): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateExplicitEnvVarConfigValues();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd, options);
	return { migratedAuthProviders, deprecationWarnings };
}
