import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CursorModelCatalog } from "./model-mapper.js";
import { maxModeFromState, maxModeState, type CursorAuthoritativeRouteRow, type CursorMaxModeState } from "./route-reference.js";

export const CURSOR_CATALOG_CACHE_VERSION = 2;
export const CURSOR_CATALOG_CACHE_FILENAME = "cursor-model-catalog-v2.json";
export const CURSOR_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;

export interface CursorCatalogCacheRow {
	readonly modelId: string;
	readonly maxMode: CursorMaxModeState;
	readonly displayName?: string;
}

export interface CursorCatalogCacheRecord {
	readonly version: typeof CURSOR_CATALOG_CACHE_VERSION;
	readonly accountScope: string;
	readonly clientVersion: string;
	readonly fetchedAt: number;
	readonly ttlMs: typeof CURSOR_CATALOG_CACHE_TTL_MS;
	readonly rows: readonly CursorCatalogCacheRow[];
}

export interface CursorCatalogCacheQuery {
	readonly accountScope: string;
	readonly clientVersion: string;
	readonly catalogGeneration: number;
	readonly now?: number;
}

export interface CursorCatalogCache {
	load(query: CursorCatalogCacheQuery): CursorModelCatalog | null;
	save(catalog: CursorModelCatalog): void;
}

export class FileCursorCatalogCache implements CursorCatalogCache {
	readonly #path: string;
	readonly #now: () => number;
	readonly #rename: typeof renameSync;

	constructor(path = getDefaultCursorCatalogCachePath(), now: () => number = Date.now, rename: typeof renameSync = renameSync) {
		this.#path = path;
		this.#now = now;
		this.#rename = rename;
	}

	get path(): string {
		return this.#path;
	}

	load(query: CursorCatalogCacheQuery): CursorModelCatalog | null {
		if (!existsSync(this.#path)) return null;
		try {
			return parseCursorCatalogCacheRecord(JSON.parse(readFileSync(this.#path, "utf8")), {
				...query,
				now: query.now ?? this.#now(),
			});
		} catch {
			return null;
		}
	}

	save(catalog: CursorModelCatalog): void {
		const record = toCursorCatalogCacheRecord(catalog);
		mkdirSync(dirname(this.#path), { recursive: true });
		const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			this.#rename(temporaryPath, this.#path);
		} catch (error) {
			try {
				rmSync(temporaryPath, { force: true });
			} catch {
				// Preserve the original atomic write failure.
			}
			throw error;
		}
	}
}

export function parseCursorCatalogCacheRecord(
	value: unknown,
	query: CursorCatalogCacheQuery & { readonly now: number },
): CursorModelCatalog | null {
	if (!isRecord(value)) return null;
	if (containsForbiddenCacheField(value)) return null;
	if (value.version !== CURSOR_CATALOG_CACHE_VERSION) return null;
	if (value.accountScope !== query.accountScope || value.clientVersion !== query.clientVersion) return null;
	if (value.ttlMs !== CURSOR_CATALOG_CACHE_TTL_MS) return null;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0) return null;
	if (typeof query.now !== "number" || !Number.isFinite(query.now) || query.now < value.fetchedAt) return null;
	if (query.now - value.fetchedAt >= CURSOR_CATALOG_CACHE_TTL_MS) return null;
	if (!Array.isArray(value.rows)) return null;
	const rows: CursorAuthoritativeRouteRow[] = [];
	for (const row of value.rows) {
		const parsed = parseCacheRow(row);
		if (!parsed) return null;
		rows.push(parsed);
	}
	return {
		accountScope: query.accountScope,
		clientVersion: query.clientVersion,
		fetchedAt: value.fetchedAt,
		catalogGeneration: query.catalogGeneration,
		selectionPersistence: true,
		rows,
	};
}

export function toCursorCatalogCacheRecord(catalog: CursorModelCatalog): CursorCatalogCacheRecord {
	if (catalog.accountScope.length === 0 || catalog.clientVersion.length === 0) throw new Error("Cursor catalog cache identity is missing.");
	if (catalog.selectionPersistence === false) throw new Error("Cursor runtime-only catalog cannot be persisted.");
	if (!Number.isFinite(catalog.fetchedAt) || catalog.fetchedAt < 0) throw new Error("Cursor catalog cache timestamp is malformed.");
	const rows = catalog.rows.map(toCacheRow);
	return {
		version: CURSOR_CATALOG_CACHE_VERSION,
		accountScope: catalog.accountScope,
		clientVersion: catalog.clientVersion,
		fetchedAt: catalog.fetchedAt,
		ttlMs: CURSOR_CATALOG_CACHE_TTL_MS,
		rows,
	};
}

function parseCacheRow(value: unknown): CursorAuthoritativeRouteRow | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.modelId !== "string" || value.modelId.length === 0) return undefined;
	if (value.maxMode !== "absent" && value.maxMode !== "false" && value.maxMode !== "true") return undefined;
	if (value.displayName !== undefined && typeof value.displayName !== "string") return undefined;
	return {
		modelId: value.modelId,
		maxMode: maxModeFromState(value.maxMode),
		...(value.displayName === undefined ? {} : { displayName: value.displayName }),
	};
}

function toCacheRow(row: CursorAuthoritativeRouteRow): CursorCatalogCacheRow {
	if (typeof row.modelId !== "string" || row.modelId.length === 0) throw new Error("Cursor catalog contains an empty route ID.");
	if (row.maxMode !== undefined && typeof row.maxMode !== "boolean") throw new Error("Cursor catalog contains malformed max_mode.");
	if (row.displayName !== undefined && typeof row.displayName !== "string") throw new Error("Cursor catalog contains a malformed display name.");
	return {
		modelId: row.modelId,
		maxMode: maxModeState(row.maxMode),
		...(row.displayName === undefined ? {} : { displayName: row.displayName }),
	};
}

export function getDefaultCursorCatalogCachePath(): string {
	return join(getDefaultAtomicAgentDir(), CURSOR_CATALOG_CACHE_FILENAME);
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

function containsForbiddenCacheField(value: unknown, inspectString = true): boolean {
	if (typeof value === "string") return inspectString && looksSecretBearingCacheValue(value);
	if (Array.isArray(value)) return value.some((nested) => containsForbiddenCacheField(nested, inspectString));
	if (!isRecord(value)) return false;
	for (const [key, nested] of Object.entries(value)) {
		const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
		if (
			normalized.includes("token") || normalized.includes("cookie") || normalized.includes("authorization") ||
			normalized.includes("credential") || normalized.includes("secret") || normalized.includes("password") ||
			normalized === "access" || normalized === "refresh" || normalized === "apikey" ||
			normalized === "rawaccountid" || normalized === "prompt" || normalized === "requestid" || normalized === "privateresponse"
		) return true;
		const literalCatalogText = normalized === "modelid" || normalized === "displayname";
		if (containsForbiddenCacheField(nested, !literalCatalogText)) return true;
	}
	return false;
}

function looksSecretBearingCacheValue(value: string): boolean {
	return /\bbearer\s+\S+/iu.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
		/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(value) || /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
