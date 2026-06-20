import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { deepMergeSettings } from "./settings-merge.ts";
import type { Settings, SettingsScope, SettingsStorage } from "./settings-types.ts";

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	private globalReadPaths: string[];
	private projectReadPaths: string[];

	constructor(cwd: string, agentDir: string, options?: { globalReadPaths?: string[]; projectReadPaths?: string[] }) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
		this.globalReadPaths = (options?.globalReadPaths ?? [this.globalSettingsPath]).map((path) => normalizePath(path));
		this.projectReadPaths = (options?.projectReadPaths ?? [this.projectSettingsPath]).map((path) => normalizePath(path));
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	private readMergedSettings(readPaths: string[]): string | undefined {
		let merged: Settings = {};
		let found = false;
		for (let i = readPaths.length - 1; i >= 0; i--) {
			const readPath = readPaths[i]!;
			if (!existsSync(readPath)) continue;
			const parsed = JSON.parse(readFileSync(readPath, "utf-8")) as Settings;
			merged = deepMergeSettings(merged, parsed);
			found = true;
		}
		return found ? JSON.stringify(merged, null, 2) : undefined;
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if the primary file exists or we need to write.
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = this.readMergedSettings(readPaths);
			const next = fn(current);

			if (next !== undefined) {
				// Only create directory when we actually need to write.
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					if (!existsSync(path)) writeFileSync(path, "{}", "utf-8");
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}
