import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getAgentConfigPaths, getProjectConfigPaths } from "./config.js";
import { FileAuthStorageBackend } from "./core/auth-storage-backends.ts";
import { normalizeAzureSettings, normalizeProviderKeys } from "./core/azure-provider-compat.js";
import { failureDebugFields, reportDebug, reportDebugAsync } from "./core/debug.ts";
import type { Settings } from "./core/settings-types.ts";
import { parseJsonFileContent, stripJsonComments } from "./utils/json.ts";
import { pathExists as exists } from "./utils/path-exists.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function transformAzureConfigContent(filename: string, content: string): string | undefined {
	const parsed = parseJsonFileContent(filename === "models.json" ? stripJsonComments(content) : content) as JsonObject;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	let next = parsed;
	if (filename === "auth.json") next = normalizeProviderKeys(parsed);
	else if (filename === "settings.json") next = normalizeAzureSettings(parsed as Settings) as JsonObject;
	else if (parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)) {
		next = { ...parsed, providers: normalizeProviderKeys(parsed.providers) };
	}
	return JSON.stringify(parsed) !== JSON.stringify(next) ? `${JSON.stringify(next, null, 2)}\n` : undefined;
}

export function migrateAzureProvider(cwd: string, options?: { projectTrusted?: boolean }): void {
	for (const filename of ["auth.json", "settings.json", "models.json"]) {
		const paths = [
			...getAgentConfigPaths(filename),
			...(options?.projectTrusted === true ? getProjectConfigPaths(cwd, filename) : []),
		];
		for (const path of new Set(paths)) {
			if (!existsSync(path)) continue;
			try {
				new FileAuthStorageBackend(path, []).withLock(() => {
					const content = readFileSync(path, "utf-8");
					const next = transformAzureConfigContent(filename, content);
					return {
						result: undefined,
						...(next !== undefined && { next }),
					};
				});
			} catch (error) {
				reportMigrationFailure(path, error);
			}
		}
	}
}

function reportMigrationFailure(path: string, error: unknown): void {
	reportDebug("storage", "azure-migration-skipped", { path, ...failureDebugFields(error) });
}

export async function migrateAzureProviderAsync(cwd: string, options?: { projectTrusted?: boolean }): Promise<void> {
	for (const filename of ["auth.json", "settings.json", "models.json"]) {
		const paths = [
			...getAgentConfigPaths(filename),
			...(options?.projectTrusted === true ? getProjectConfigPaths(cwd, filename) : []),
		];
		for (const path of new Set(paths)) {
			if (!(await exists(path))) continue;
			try {
				if (transformAzureConfigContent(filename, await readFile(path, "utf-8")) === undefined) continue;
				await new FileAuthStorageBackend(path, []).withLockAsync(
					async () => {
						const next = transformAzureConfigContent(filename, await readFile(path, "utf-8"));
						return {
							result: undefined,
							...(next !== undefined && { next }),
						};
					},
					{ synchronousWait: true },
				);
			} catch (error) {
				await reportDebugAsync("storage", "azure-migration-skipped", { path, ...failureDebugFields(error) });
			}
		}
	}
}
