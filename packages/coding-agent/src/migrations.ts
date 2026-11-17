/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentConfigPaths, getAgentDir, getBinDir } from "./config.js";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import {
	applyEarlyInputChunk,
	type EarlyInputState,
	keepStartupDialogDraft,
	withEarlyInputHeldForStartupDialog,
} from "./main-early-input.ts";
import { migrateAzureProvider, migrateAzureProviderAsync } from "./migrations-azure.js";
import {
	migrateAuthJsonConfigValues,
	migrateAuthJsonConfigValuesAsync,
	migrateModelsJsonConfigValues,
	migrateModelsJsonConfigValuesAsync,
} from "./migrations-config-values.ts";
import { stripBom } from "./utils/text.ts";

const EXTENSIONS_DOC_URL = "https://docs.bastani.ai/extensions";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

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
			const oauth = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
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
			const settings = JSON.parse(stripBom(content));
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

export async function migrateAuthToAuthJsonAsync(): Promise<string[]> {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	if (await pathExists(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	if (await pathExists(oauthPath)) {
		try {
			const oauth = JSON.parse(stripBom(await readFile(oauthPath, "utf-8")));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			await rename(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	if (await pathExists(settingsPath)) {
		try {
			const content = await readFile(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				await writeFile(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		await mkdir(dirname(authPath), { recursive: true });
		await writeFile(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

function getAgentDirsForConfigMigration(): string[] {
	const dirs = new Set<string>();
	for (const path of [...getAgentConfigPaths("auth.json"), ...getAgentConfigPaths("models.json")]) {
		dirs.add(dirname(path));
	}
	return [...dirs];
}

function logEnvVarConfigMigrations(migrations: Array<{ location: string; from: string; to: string }>): void {
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

function migrateExplicitEnvVarConfigValues(): void {
	const migrations = getAgentDirsForConfigMigration().flatMap((agentDir) => [
		...migrateAuthJsonConfigValues(agentDir),
		...migrateModelsJsonConfigValues(agentDir),
	]);
	logEnvVarConfigMigrations(migrations);
}

async function migrateExplicitEnvVarConfigValuesAsync(): Promise<void> {
	const migrations: Array<{ location: string; from: string; to: string }> = [];
	for (const agentDir of getAgentDirsForConfigMigration()) {
		migrations.push(
			...(await migrateAuthJsonConfigValuesAsync(agentDir)),
			...(await migrateModelsJsonConfigValuesAsync(agentDir)),
		);
	}
	logEnvVarConfigMigrations(migrations);
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
			const firstLine = stripBom(content).split("\n")[0];
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

export async function migrateSessionsFromAgentRootAsync(): Promise<void> {
	const agentDir = getAgentDir();

	let files: string[];
	try {
		files = (await readdir(agentDir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			const content = await readFile(file, "utf8");
			const firstLine = stripBom(content).split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			if (!(await pathExists(correctDir))) {
				await mkdir(correctDir, { recursive: true });
			}

			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (await pathExists(newPath)) continue;

			await rename(file, newPath);
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

async function migrateCommandsToPromptsAsync(baseDir: string, label: string): Promise<boolean> {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if ((await pathExists(commandsDir)) && !(await pathExists(promptsDir))) {
		try {
			await rename(commandsDir, promptsDir);
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
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
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

async function migrateKeybindingsConfigFileAsync(): Promise<void> {
	const configPath = join(getAgentDir(), "keybindings.json");
	try {
		const content = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(stripBom(content)) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore missing or malformed files during migration
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

async function migrateToolsToBinAsync(): Promise<void> {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!(await pathExists(toolsDir))) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (await pathExists(oldPath)) {
			if (!(await pathExists(binDir))) {
				await mkdir(binDir, { recursive: true });
			}
			if (!(await pathExists(newPath))) {
				try {
					await rename(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				try {
					await rm(oldPath, { force: true });
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

function hasCustomTools(entries: string[]): boolean {
	return entries.some((e) => {
		const lower = e.toLowerCase();
		return (
			lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
		);
	});
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
			if (hasCustomTools(entries)) {
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

async function checkDeprecatedExtensionDirsAsync(baseDir: string, label: string): Promise<string[]> {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (await pathExists(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (await pathExists(toolsDir)) {
		try {
			const entries = await readdir(toolsDir);
			if (hasCustomTools(entries)) {
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

async function migrateExtensionSystemAsync(cwd: string, options?: { projectTrusted?: boolean }): Promise<string[]> {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	await migrateCommandsToPromptsAsync(agentDir, "Global");
	if (options?.projectTrusted !== false) {
		await migrateCommandsToPromptsAsync(projectDir, "Project");
	}

	return [
		...(await checkDeprecatedExtensionDirsAsync(agentDir, "Global")),
		...(options?.projectTrusted === false ? [] : await checkDeprecatedExtensionDirsAsync(projectDir, "Project")),
	];
}

type KeypressInput = Pick<NodeJS.ReadStream, "resume" | "pause" | "once"> & { setRawMode?(mode: boolean): unknown };

/**
 * Print deprecation warnings and wait for keypress. The notice takes the terminal from the early-input capture while it
 * waits; what was typed, and the text of the key that closes it, wait in the prompt as a draft.
 */
export async function showDeprecationWarnings(warnings: string[], stdin: KeypressInput = process.stdin): Promise<void> {
	if (warnings.length === 0) return;
	await withEarlyInputHeldForStartupDialog(() => waitForDeprecationKeypress(warnings, stdin));
}

async function waitForDeprecationKeypress(warnings: string[], stdin: KeypressInput): Promise<void> {
	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.once("data", (chunk: Buffer | string) => {
			stdin.setRawMode?.(false);
			stdin.pause();
			const typed: EarlyInputState = { text: "", submissions: [] };
			applyEarlyInputChunk(typed, chunk.toString());
			keepStartupDialogDraft([...typed.submissions, typed.text].filter((part) => part.length > 0).join("\n"));
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
	migrateAzureProvider(cwd, options);
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd, options);
	return { migratedAuthProviders, deprecationWarnings };
}

/**
 * Run all migrations asynchronously without blocking the event loop.
 */
export async function runMigrationsAsync(
	cwd: string,
	options?: { projectTrusted?: boolean },
): Promise<{
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
}> {
	const migratedAuthProviders = await migrateAuthToAuthJsonAsync();
	await migrateExplicitEnvVarConfigValuesAsync();
	await migrateAzureProviderAsync(cwd, options);
	await migrateSessionsFromAgentRootAsync();
	await migrateToolsToBinAsync();
	await migrateKeybindingsConfigFileAsync();
	const deprecationWarnings = await migrateExtensionSystemAsync(cwd, options);
	return { migratedAuthProviders, deprecationWarnings };
}
