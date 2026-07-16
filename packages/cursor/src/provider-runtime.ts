import { randomUUID } from "node:crypto";
import type { CursorAuthService } from "./auth.js";
import type { CursorCatalogCache } from "./catalog-cache.js";
import type { CursorModelDiscoveryService } from "./models.js";
import type { CursorStreamAdapter } from "./stream.js";
import type { CursorAgentTransport } from "./transport.js";

export const DEFAULT_CATALOG_DISCOVERY_DISPOSE_TIMEOUT_MS = 1_000;
export const CURSOR_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

export interface CursorCatalogRefreshStatus {
	readonly state: "idle" | "fresh" | "empty" | "refreshing" | "failed";
	readonly fetchedAt?: number;
	readonly error?: string;
}

export interface CursorProviderRuntime {
	readonly transport: CursorAgentTransport;
	readonly authService: CursorAuthService;
	readonly discoveryService: CursorModelDiscoveryService;
	readonly streamAdapter: CursorStreamAdapter;
	readonly catalogCache: CursorCatalogCache;
	getCatalogRefreshStatus(): CursorCatalogRefreshStatus;
	dispose(): Promise<void>;
}

export type CursorSessionLifecycleEvent = "session_before_switch" | "session_before_fork" | "session_before_tree" | "session_shutdown";
export type CursorProviderEvent = "model_catalog_discover" | "session_start" | CursorSessionLifecycleEvent;

export function defaultCursorUuid(): string { return randomUUID(); }

export function isCatalogFresh(fetchedAt: number | undefined, now: number, ttlMs: number): boolean {
	if (fetchedAt === undefined) return false;
	const age = now - fetchedAt;
	return age >= 0 && age < ttlMs;
}

export interface CursorCatalogFailureDispositionInput {
	readonly credentialScope: string | undefined;
	readonly lastCredentialScope: string | undefined;
	readonly accessToken: string;
	readonly lastAccessToken: string | undefined;
	readonly lastFetchedAt: number | undefined;
	readonly now: number;
	readonly ttlMs: number;
	readonly catalogApplicationFailed: boolean;
	readonly preserveAuthoritativeEmpty: boolean;
}

export function cursorCatalogFailureDisposition(input: CursorCatalogFailureDispositionInput): {
	readonly retainFreshSnapshot: boolean;
	readonly clearRegistry: boolean;
	readonly clearCache: boolean;
} {
	const activeCredentialMatches = input.credentialScope
		? input.credentialScope === input.lastCredentialScope
		: input.accessToken === input.lastAccessToken;
	const retainFreshSnapshot = activeCredentialMatches && isCatalogFresh(input.lastFetchedAt, input.now, input.ttlMs);
	return {
		retainFreshSnapshot,
		clearRegistry: !retainFreshSnapshot && !input.catalogApplicationFailed,
		clearCache: !retainFreshSnapshot && !input.preserveAuthoritativeEmpty,
	};
}
