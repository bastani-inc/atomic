import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CursorModelCatalog, CursorParameterizedVariant, CursorUsableModel } from "./model-mapper.js";

export const CURSOR_CATALOG_CACHE_VERSION = 2;
export const CURSOR_CATALOG_CACHE_FILENAME = "cursor-model-catalog.json";
const CACHE_LOCK_RETRY_MS = 10;
const CACHE_LOCK_TIMEOUT_MS = 2_000;
const CACHE_LOCK_STALE_MS = 30_000;
const CACHE_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface CursorCatalogCacheRecord {
	readonly version: typeof CURSOR_CATALOG_CACHE_VERSION;
	readonly fetchedAt: number;
	readonly credentialScope?: string;
	readonly models: readonly CursorUsableModel[];
}

export interface CursorCatalogCache {
	load(credentialScope?: string): CursorModelCatalog | null;
	save(catalog: CursorModelCatalog, credentialScope?: string): void;
}

export class FileCursorCatalogCache implements CursorCatalogCache {
	readonly #path: string;
	constructor(path = getDefaultCursorCatalogCachePath()) { this.#path = path }
	get path(): string { return this.#path }
	load(credentialScope?: string): CursorModelCatalog | null {
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
	#pathFor(credentialScope: string | undefined): string {
		return credentialScope ? `${this.#path}.${credentialScope}` : this.#path;
	}
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
	try {
		action();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

export function getDefaultCursorCatalogCachePath(): string { return join(getDefaultAtomicAgentDir(), CURSOR_CATALOG_CACHE_FILENAME) }

export function deriveCursorCredentialScope(accessToken: string): string | undefined {
	const payload = accessToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isRecord(claims) || typeof claims.sub !== "string" || claims.sub.length === 0) return undefined;
		const digest = createHash("sha256").update(`cursor-account:${claims.sub}`).digest("base64url");
		return `account-${digest}`;
	} catch {
		return undefined;
	}
}

export function parseCursorCatalogCacheRecord(value: unknown, expectedCredentialScope?: string): CursorModelCatalog | null {
	if (!isRecord(value) || (value.version !== 1 && value.version !== CURSOR_CATALOG_CACHE_VERSION)) return null;
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0 || !Array.isArray(value.models)) return null;
	const credentialScope = optionalCredentialScope(value.credentialScope);
	if (credentialScope === null || (expectedCredentialScope !== undefined && credentialScope !== expectedCredentialScope)) return null;
	const legacy = value.version === 1;
	const models = value.models
		.map(parseCachedCursorModel)
		.filter((model): model is CursorUsableModel => model !== null)
		.map((model) => legacy && model.metadataProvenance === undefined ? { ...model, metadataProvenance: "legacy-cache" as const } : model);
	return models.length > 0 ? { source: "live", fetchedAt: value.fetchedAt, ...(credentialScope ? { credentialScope } : {}), models } : null;
}

export function toCursorCatalogCacheRecord(catalog: CursorModelCatalog, credentialScope?: string): CursorCatalogCacheRecord | null {
	if (catalog.source !== "live" || !Number.isFinite(catalog.fetchedAt) || catalog.fetchedAt < 0) return null;
	const models = catalog.models.map(parseCachedCursorModel).filter((model): model is CursorUsableModel => model !== null);
	return models.length > 0 ? { version: CURSOR_CATALOG_CACHE_VERSION, fetchedAt: catalog.fetchedAt, ...(credentialScope ? { credentialScope } : {}), models } : null;
}

function parseCachedCursorModel(value: unknown): CursorUsableModel | null {
	if (!isRecord(value)) return null;
	const id = requiredString(value.id);
	if (!id) return null;
	const model: Record<string, unknown> = { id };
	for (const key of ["name", "displayName", "serverModelName", "requestedModelId"] as const) {
		if (value[key] !== undefined) { const field = optionalString(value[key]); if (field === null) return null; model[key] = field }
	}
	for (const key of ["contextWindow", "maxModeContextWindow", "maxTokens"] as const) {
		if (value[key] !== undefined) { const field = positiveNumber(value[key]); if (field === null) return null; model[key] = field }
	}
	for (const key of ["supportsReasoning", "supportsThinking", "supportsImages", "supportsMaxMode", "supportsNonMaxMode", "requestedMaxMode", "isDefaultVariant"] as const) {
		if (value[key] !== undefined) { if (typeof value[key] !== "boolean") return null; model[key] = value[key] }
	}
	if (value.metadataProvenance !== undefined) {
		if (!isOneOf(value.metadataProvenance, ["available-models-reverse-engineered", "get-usable-models", "legacy-cache", "static-fallback"])) return null;
		model.metadataProvenance = value.metadataProvenance;
	}
	if (value.effort !== undefined) {
		if (!isOneOf(value.effort, ["none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max", "default"])) return null;
		model.effort = value.effort;
	}
	if (value.parameters !== undefined) { const parameters = parseParameters(value.parameters); if (!parameters) return null; model.parameters = parameters }
	if (value.variants !== undefined) { const variants = parseVariants(value.variants); if (!variants) return null; model.variants = variants }
	return model as unknown as CursorUsableModel;
}

function parseParameters(value: unknown): readonly { readonly id: string; readonly value: string }[] | null {
	if (!Array.isArray(value)) return null;
	const parsed = value.map((entry) => isRecord(entry) && requiredString(entry.id) && requiredString(entry.value) ? { id: entry.id as string, value: entry.value as string } : null);
	return parsed.every((entry) => entry !== null) ? parsed : null;
}

function parseVariants(value: unknown): readonly CursorParameterizedVariant[] | null {
	if (!Array.isArray(value)) return null;
	const parsed = value.map((entry): CursorParameterizedVariant | null => {
		if (!isRecord(entry) || typeof entry.isMaxMode !== "boolean") return null;
		const parameters = parseParameters(entry.parameters);
		if (!parameters) return null;
		const variant: Record<string, unknown> = { parameters, isMaxMode: entry.isMaxMode };
		for (const key of ["displayName", "displayNameOutsidePicker", "variantStringRepresentation"] as const) {
			if (entry[key] !== undefined) { const field = optionalString(entry[key]); if (field === null) return null; variant[key] = field }
		}
		for (const key of ["isDefaultMaxConfig", "isDefaultNonMaxConfig"] as const) {
			if (entry[key] !== undefined) { if (typeof entry[key] !== "boolean") return null; variant[key] = entry[key] }
		}
		return variant as unknown as CursorParameterizedVariant;
	});
	return parsed.every((entry) => entry !== null) ? parsed : null;
}

function getDefaultAtomicAgentDir(): string {
	const configured = readEnv("ATOMIC_CODING_AGENT_DIR") ?? readEnv("PI_CODING_AGENT_DIR");
	return configured ? expandTilde(configured) : join(homedir(), ".atomic", "agent");
}
function readEnv(name: string): string | undefined { const value = process.env[name]?.trim(); return value || undefined }
function expandTilde(path: string): string { return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function requiredString(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined }
function optionalString(value: unknown): string | null { return typeof value === "string" ? value : null }
function positiveNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null }
function optionalCredentialScope(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" && /^account-[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
function isOneOf(value: unknown, allowed: readonly string[]): value is string { return typeof value === "string" && allowed.includes(value) }
