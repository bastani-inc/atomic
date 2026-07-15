import { randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CursorModelCatalog, CursorUsableModel } from "./model-mapper.js";

export const CURSOR_CATALOG_CACHE_VERSION = 3;
export const CURSOR_CATALOG_CACHE_FILENAME = "cursor-model-catalog.json";
const CACHE_LOCK_RETRY_MS = 10;
const CACHE_LOCK_TIMEOUT_MS = 2_000;
const CACHE_LOCK_STALE_MS = 30_000;
const CACHE_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const CACHE_RECORD_KEYS = new Set(["version", "fetchedAt", "credentialScope", "models"]);
const CACHE_MODEL_KEYS = new Set(["id", "displayName", "displayNameShort", "displayModelId", "maxMode", "supportsImages"]);

export interface CursorCatalogCacheRecord {
	readonly version: typeof CURSOR_CATALOG_CACHE_VERSION;
	readonly fetchedAt: number;
	readonly credentialScope: string;
	readonly models: readonly CursorUsableModel[];
}

export interface CursorCatalogCache {
	load(credentialScope?: string): CursorModelCatalog | null;
	save(catalog: CursorModelCatalog, credentialScope?: string): void;
	clear?(credentialScope?: string): void | Promise<void>;
}

export class FileCursorCatalogCache implements CursorCatalogCache {
	readonly #path: string;
	constructor(path = getDefaultCursorCatalogCachePath()) { this.#path = path }
	get path(): string { return this.#path }
	load(credentialScope?: string): CursorModelCatalog | null {
		if (!credentialScope) return null;
		const path = this.#pathFor(credentialScope);
		if (!existsSync(path)) return null;
		try { return parseCursorCatalogCacheRecord(JSON.parse(readFileSync(path, "utf8")), credentialScope) } catch { return null }
	}
	save(catalog: CursorModelCatalog, credentialScope?: string): void {
		if (!credentialScope) return;
		const record = toCursorCatalogCacheRecord(catalog, credentialScope);
		if (!record) return;
		const path = this.#pathFor(credentialScope);
		mkdirSync(dirname(path), { recursive: true });
		const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			withCacheFileLock(path, () => {
				const current = this.load(credentialScope);
				if (current && current.fetchedAt >= catalog.fetchedAt) return;
				renameSync(tmpPath, path);
			});
		} catch (error) {
			try { rmSync(tmpPath, { force: true }) } catch { /* preserve original error */ }
			throw error;
		} finally {
			try { rmSync(tmpPath, { force: true }) } catch { /* best-effort cleanup */ }
		}
	}
	clear(credentialScope?: string): void {
		if (!credentialScope) return;
		rmSync(this.#pathFor(credentialScope), { force: true });
	}
	#pathFor(credentialScope: string): string { return `${this.#path}.${credentialScope}` }
}

function withCacheFileLock(path: string, action: () => void): void {
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			break;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > CACHE_LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch (statError) {
				if (hasErrorCode(statError, "ENOENT")) continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the Cursor model catalog cache lock.");
			Atomics.wait(CACHE_LOCK_SLEEP, 0, 0, CACHE_LOCK_RETRY_MS);
		}
	}
	try { action() } finally { rmSync(lockPath, { recursive: true, force: true }) }
}

function hasErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

export function getDefaultCursorCatalogCachePath(): string { return join(getDefaultAtomicAgentDir(), CURSOR_CATALOG_CACHE_FILENAME) }

export function deriveCursorCredentialScope(accessToken: string): string | undefined {
	const payload = accessToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isRecord(claims) || typeof claims.sub !== "string" || claims.sub.length === 0) return undefined;
		const digest = scryptSync(claims.sub, "atomic-cursor-catalog-scope-v2", 32).toString("base64url");
		return `account-${digest}`;
	} catch {
		return undefined;
	}
}

export function parseCursorCatalogCacheRecord(value: unknown, expectedCredentialScope?: string): CursorModelCatalog | null {
	if (!isRecord(value) || value.version !== CURSOR_CATALOG_CACHE_VERSION || hasUnexpectedKeys(value, CACHE_RECORD_KEYS)) return null;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0 || !Array.isArray(value.models)) return null;
	const credentialScope = parseCredentialScope(value.credentialScope);
	if (!credentialScope || (expectedCredentialScope !== undefined && credentialScope !== expectedCredentialScope)) return null;
	const models: CursorUsableModel[] = [];
	for (const entry of value.models) {
		const model = parseCachedCursorModel(entry);
		if (!model) return null;
		models.push(model);
	}
	return models.length > 0 ? { source: "live", fetchedAt: value.fetchedAt, credentialScope, models } : null;
}

export function toCursorCatalogCacheRecord(catalog: CursorModelCatalog, credentialScope?: string): CursorCatalogCacheRecord | null {
	if (catalog.source !== "live" || !credentialScope || !parseCredentialScope(credentialScope)) return null;
	if (catalog.credentialScope && catalog.credentialScope !== credentialScope) return null;
	if (!Number.isFinite(catalog.fetchedAt) || catalog.fetchedAt < 0) return null;
	const models = catalog.models.map(toCachedCursorModel);
	return models.length > 0 ? { version: CURSOR_CATALOG_CACHE_VERSION, fetchedAt: catalog.fetchedAt, credentialScope, models } : null;
}

function toCachedCursorModel(model: CursorUsableModel): CursorUsableModel {
	return {
		id: model.id,
		...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
		...(model.displayNameShort !== undefined ? { displayNameShort: model.displayNameShort } : {}),
		...(model.displayModelId !== undefined ? { displayModelId: model.displayModelId } : {}),
		maxMode: model.maxMode,
		...(model.supportsImages === true ? { supportsImages: true } : {}),
	};
}

function parseCachedCursorModel(value: unknown): CursorUsableModel | null {
	if (!isRecord(value) || hasUnexpectedKeys(value, CACHE_MODEL_KEYS)) return null;
	const id = exactString(value.id);
	if (id === undefined || typeof value.maxMode !== "boolean") return null;
	const displayName = optionalString(value.displayName);
	const displayNameShort = optionalString(value.displayNameShort);
	const displayModelId = optionalString(value.displayModelId);
	if (displayName === null || displayNameShort === null || displayModelId === null) return null;
	if (value.supportsImages !== undefined && value.supportsImages !== true) return null;
	return {
		id,
		...(displayName !== undefined ? { displayName } : {}),
		...(displayNameShort !== undefined ? { displayNameShort } : {}),
		...(displayModelId !== undefined ? { displayModelId } : {}),
		maxMode: value.maxMode,
		...(value.supportsImages === true ? { supportsImages: true } : {}),
	};
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).some((key) => !allowed.has(key));
}
function getDefaultAtomicAgentDir(): string {
	const configured = readEnv("ATOMIC_CODING_AGENT_DIR") ?? readEnv("PI_CODING_AGENT_DIR");
	return configured ? expandTilde(configured) : join(homedir(), ".atomic", "agent");
}
function readEnv(name: string): string | undefined { const value = process.env[name]?.trim(); return value || undefined }
function expandTilde(path: string): string { return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function exactString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined }
function optionalString(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : null;
}
function parseCredentialScope(value: unknown): string | undefined {
	return typeof value === "string" && /^account-[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}
