import { existsSync, readFileSync } from "node:fs";
import { getAgentConfigPaths, getProjectConfigPaths } from "./config.js";
import { FileAuthStorageBackend } from "./core/auth-storage-backends.js";
import { normalizeAzureSettings, normalizeProviderKeys } from "./core/azure-provider-compat.js";
import type { Settings } from "./core/settings-types.js";
import { parseJsonFileContent, stripJsonComments } from "./utils/json.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

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
					const parsed = parseJsonFileContent(
						filename === "models.json" ? stripJsonComments(content) : content,
					) as JsonObject;
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { result: undefined };
					let next = parsed;
					if (filename === "auth.json") next = normalizeProviderKeys(parsed);
					else if (filename === "settings.json") next = normalizeAzureSettings(parsed as Settings) as JsonObject;
					else if (parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)) {
						next = { ...parsed, providers: normalizeProviderKeys(parsed.providers) };
					}
					return {
						result: undefined,
						...(JSON.stringify(parsed) !== JSON.stringify(next) && {
							next: `${JSON.stringify(next, null, 2)}\n`,
						}),
					};
				});
			} catch {}
		}
	}
}
