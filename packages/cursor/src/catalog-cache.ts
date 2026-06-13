import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CursorModelCatalog, CursorUsableModel } from "./model-mapper.js";

export const CURSOR_CATALOG_CACHE_VERSION = 1;
export const CURSOR_CATALOG_CACHE_FILENAME = "cursor-model-catalog.json";

export interface CursorCatalogCacheRecord {
	readonly version: typeof CURSOR_CATALOG_CACHE_VERSION;
	readonly fetchedAt: number;
	readonly models: readonly CursorUsableModel[];
}

export interface CursorCatalogCache {
	load(): CursorModelCatalog | null;
	save(catalog: CursorModelCatalog): void;
}

export class FileCursorCatalogCache implements CursorCatalogCache {
	readonly #path: string;

	constructor(path = getDefaultCursorCatalogCachePath()) {
		this.#path = path;
	}

	get path(): string {
		return this.#path;
	}

	load(): CursorModelCatalog | null {
		if (!existsSync(this.#path)) return null;
		try {
			return parseCursorCatalogCacheRecord(JSON.parse(readFileSync(this.#path, "utf8")));
		} catch {
			return null;
		}
	}

	save(catalog: CursorModelCatalog): void {
		const record = toCursorCatalogCacheRecord(catalog);
		if (!record) return;
		mkdirSync(dirname(this.#path), { recursive: true });
		const tmpPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(tmpPath, this.#path);
		} catch (error) {
			try {
				rmSync(tmpPath, { force: true });
			} catch {
				// Ignore cleanup errors; preserve the original write/rename failure.
			}
			throw error;
		}
	}
}

export function getDefaultCursorCatalogCachePath(): string {
	return join(getDefaultAtomicAgentDir(), CURSOR_CATALOG_CACHE_FILENAME);
}

export function parseCursorCatalogCacheRecord(value: unknown): CursorModelCatalog | null {
	if (!isRecord(value)) return null;
	if (value.version !== CURSOR_CATALOG_CACHE_VERSION) return null;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0) return null;
	if (!Array.isArray(value.models)) return null;
	const models = value.models.map(parseCachedCursorModel).filter((model): model is CursorUsableModel => model !== null);
	if (models.length === 0) return null;
	return { source: "live", fetchedAt: value.fetchedAt, models };
}

export function toCursorCatalogCacheRecord(catalog: CursorModelCatalog): CursorCatalogCacheRecord | null {
	if (catalog.source !== "live") return null;
	if (typeof catalog.fetchedAt !== "number" || !Number.isFinite(catalog.fetchedAt) || catalog.fetchedAt < 0) return null;
	const models = catalog.models.map(parseCachedCursorModel).filter((model): model is CursorUsableModel => model !== null);
	if (models.length === 0) return null;
	return { version: CURSOR_CATALOG_CACHE_VERSION, fetchedAt: catalog.fetchedAt, models };
}

function parseCachedCursorModel(value: unknown): CursorUsableModel | null {
	if (!isRecord(value)) return null;
	const id = readRequiredString(value, "id");
	if (!id) return null;
	const name = readOptionalString(value, "name");
	const displayName = readOptionalString(value, "displayName");
	const contextWindow = readOptionalPositiveNumber(value, "contextWindow");
	const maxTokens = readOptionalPositiveNumber(value, "maxTokens");
	const supportsReasoning = readOptionalBoolean(value, "supportsReasoning");
	const supportsThinking = readOptionalBoolean(value, "supportsThinking");
	if (
		name === false ||
		displayName === false ||
		contextWindow === false ||
		maxTokens === false ||
		supportsReasoning === false ||
		supportsThinking === false
	) {
		return null;
	}
	return {
		id,
		...(name !== undefined ? { name } : {}),
		...(displayName !== undefined ? { displayName } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
		...(supportsThinking !== undefined ? { supportsThinking } : {}),
	};
}

function getDefaultAtomicAgentDir(): string {
	const configured = readEnv("ATOMIC_CODING_AGENT_DIR") ?? readEnv("PI_CODING_AGENT_DIR");
	if (configured) return expandTilde(configured);
	return join(homedir(), ".atomic", "agent");
}

function readEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined | false {
	const field = value[key];
	if (field === undefined) return undefined;
	return typeof field === "string" ? field : false;
}

function readOptionalPositiveNumber(value: Record<string, unknown>, key: string): number | undefined | false {
	const field = value[key];
	if (field === undefined) return undefined;
	return typeof field === "number" && Number.isFinite(field) && field > 0 ? field : false;
}

function readOptionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined | false {
	const field = value[key];
	if (field === undefined) return undefined;
	return typeof field === "boolean" ? field : false;
}
