import { readFile } from "node:fs/promises";
import { APP_NAME, getUserConfigPaths } from "@bastani/atomic";
import { findReadableConfigPath } from "./config-paths.ts";
import { createOwnerState } from "./owner-state.js";

export const ALLOW_BROWSER_COOKIES_ENV = `${APP_NAME.toUpperCase()}_ALLOW_BROWSER_COOKIES`;

interface GeminiWebConfig {
	chromeProfile?: string;
	allowBrowserCookies?: boolean;
}

export interface AsyncOwnerState<T> {
	(): Promise<T>;
	reset(): void;
}

export function createAsyncOwnerState<T>(load: () => Promise<T>): AsyncOwnerState<T> {
	const state = createOwnerState<{ generation: number; promise?: Promise<T> }>(() => ({ generation: 0 }));
	const get = (() => {
		const holder = state();
		if (holder.promise) return holder.promise;
		const generation = holder.generation;
		const pending = load().catch((err) => {
			if (holder.generation === generation) holder.promise = undefined;
			throw err;
		});
		holder.promise = pending;
		return pending;
	}) as AsyncOwnerState<T>;
	get.reset = () => {
		const holder = state();
		holder.generation += 1;
		holder.promise = undefined;
	};
	return get;
}

export async function readWebSearchConfigFile<T extends object>(): Promise<T | null> {
	const primaryPath = await findReadableConfigPath();
	const userPaths = getUserConfigPaths("web-search.json");
	const candidates =
		primaryPath && (userPaths.length === 0 || primaryPath !== userPaths[0])
			? [primaryPath]
			: userPaths.length > 0
				? userPaths
				: primaryPath
					? [primaryPath]
					: [];

	for (const configPath of candidates) {
		if (!configPath) continue;
		let rawText: string;
		try {
			rawText = await readFile(configPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		try {
			return JSON.parse(rawText) as T;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to parse ${configPath}: ${message}`);
		}
	}
	return null;
}

export function normalizeChromeProfile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

const loadConfig = createAsyncOwnerState<GeminiWebConfig>(async () => {
	const raw = await readWebSearchConfigFile<{ chromeProfile?: unknown; allowBrowserCookies?: unknown }>();
	if (!raw) return {};

	return {
		chromeProfile: normalizeChromeProfile(raw.chromeProfile),
		allowBrowserCookies: raw.allowBrowserCookies === true,
	};
});

export async function getChromeProfileFromConfig(): Promise<string | undefined> {
	return (await loadConfig()).chromeProfile;
}

export async function isBrowserCookieAccessAllowed(): Promise<boolean> {
	if (process.env[ALLOW_BROWSER_COOKIES_ENV] === "1") {
		return true;
	}
	return (await loadConfig()).allowBrowserCookies === true;
}
