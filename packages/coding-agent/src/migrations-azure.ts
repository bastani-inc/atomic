import { existsSync, readFileSync } from "node:fs";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentConfigPaths, getProjectConfigPaths } from "./config.js";
import { FileAuthStorageBackend } from "./core/auth-storage-backends.ts";
import { normalizeAzureSettings, normalizeProviderKeys } from "./core/azure-provider-compat.js";
import type { Settings } from "./core/settings-types.ts";
import { parseJsonFileContent, stripJsonComments } from "./utils/json.ts";

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
			} catch {}
		}
	}
}

async function replaceAzureConfigFileAtomic(path: string, filename: string): Promise<void> {
	const initialContent = await readFile(path, "utf-8");
	if (transformAzureConfigContent(filename, initialContent) === undefined) return;
	const resolvedPath = await realpath(path).catch(() => path);
	const release = await lockfile.lock(resolvedPath, { realpath: false, retries: 0 });
	try {
		const currentContent = await readFile(resolvedPath, "utf-8");
		const nextContent = transformAzureConfigContent(filename, currentContent);
		if (nextContent === undefined) return;
		const fileStats = await stat(resolvedPath);
		const mode = fileStats.mode & 0o777;
		const tempPath = join(
			dirname(resolvedPath),
			`.auth.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
		);
		try {
			await writeFile(tempPath, nextContent, { encoding: "utf-8", mode });
			await chmod(tempPath, mode);
			await rename(tempPath, resolvedPath);
		} catch (error) {
			await rm(tempPath, { force: true }).catch(() => {});
			throw error;
		}
	} finally {
		await release().catch(() => {});
	}
}

export async function migrateAzureProviderAsync(cwd: string, options?: { projectTrusted?: boolean }): Promise<void> {
	for (const filename of ["auth.json", "settings.json", "models.json"]) {
		const paths = [
			...getAgentConfigPaths(filename),
			...(options?.projectTrusted === true ? getProjectConfigPaths(cwd, filename) : []),
		];
		for (const path of new Set(paths)) {
			try {
				await replaceAzureConfigFileAtomic(path, filename);
			} catch {}
		}
	}
}
