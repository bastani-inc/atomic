import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
	CURSOR_API,
	CURSOR_API_BASE_URL,
	CURSOR_LOGIN_NAME,
	CURSOR_PROVIDER_ID,
	CURSOR_PROVIDER_NAME,
	sanitizeDiagnosticText,
} from "./config.js";
import { CursorAuthService } from "./auth.js";
import { deriveCursorCredentialScope, FileCursorCatalogCache, type CursorCatalogCache } from "./catalog-cache.js";
import { CursorExecutionAuthority, type CursorExecutionAuthorityExpiry, type CursorExecutionAuthorityScheduler } from "./execution-authority.js";
import { CursorConversationStateStore } from "./conversation-state.js";
import { CursorModelDiscoveryError, CursorModelDiscoveryService } from "./models.js";
import {
	mapCursorCatalogToProviderModels,
	type CursorModelCatalog,
	type CursorProviderModelDefinition,
} from "./model-mapper.js";
import { CursorStreamAdapter } from "./stream.js";
import { waitForCatalogDiscoveryTasks, waitForCursorLoginCatalog } from "./provider-waits.js";
import { discoverStoredCursorCredential } from "./provider-credential-discovery.js";
import { activateCursorExecutionCredential } from "./provider-execution-credential.js";
import { Http2CursorAgentTransport, type CursorAgentTransport } from "./transport.js";

const DEFAULT_CATALOG_DISCOVERY_DISPOSE_TIMEOUT_MS = 1_000;
export const CURSOR_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

export interface CursorCatalogRefreshStatus {
	readonly state: "idle" | "fresh" | "refreshing" | "failed";
	readonly fetchedAt?: number;
	readonly error?: string;
}

export interface CursorProviderOAuthConfig {
	readonly name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
}

export interface CursorProviderConfig {
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly models: readonly CursorProviderModelDefinition[];
	readonly oauth: CursorProviderOAuthConfig;
	readonly streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}

export type CursorSessionLifecycleEvent = "session_before_switch" | "session_before_fork" | "session_before_tree" | "session_shutdown";
export type CursorProviderEvent = "model_catalog_discover" | "session_start" | CursorSessionLifecycleEvent;

export interface CursorProviderContext {
	readonly mode?: "tui" | "rpc" | "json" | "print";
	readonly ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	readonly sessionManager?: { getSessionId?(): string };
	readonly modelRegistry?: { getApiKeyForProvider?(provider: string): Promise<string | undefined> | string | undefined };
}

export interface CursorProviderHost {
	registerProvider(name: string, config: CursorProviderConfig): void;
	on(event: CursorProviderEvent, handler: (event?: unknown, context?: CursorProviderContext) => Promise<void> | void): void;
}

export interface CursorProviderRegistrationOptions {
	readonly transport?: CursorAgentTransport;
	readonly authService?: CursorAuthService;
	readonly discoveryService?: CursorModelDiscoveryService;
	readonly streamAdapter?: CursorStreamAdapter;
	readonly catalogCache?: CursorCatalogCache;
	readonly catalogDiscoveryDisposeTimeoutMs?: number;
	readonly catalogCacheTtlMs?: number;
	readonly executionAuthorityScheduler?: CursorExecutionAuthorityScheduler;
	readonly resolveCurrentAccessToken?: () => Promise<string | undefined> | string | undefined;
	readonly streamDisposeGraceMs?: number;
	readonly now?: () => number;
	readonly onCatalogRefreshError?: (error: Error) => void;
	readonly onCatalogDiagnostic?: (message: string) => void;
	readonly uuid?: () => string;
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

function defaultCursorUuid(): string { return nodeRandomUUID(); }

function isCatalogFresh(fetchedAt: number | undefined, now: number, ttlMs: number): boolean {
	if (fetchedAt === undefined) return false;
	const age = now - fetchedAt;
	return age >= 0 && age < ttlMs;
}


export function registerCursorProvider(pi: CursorProviderHost, options: CursorProviderRegistrationOptions = {}): CursorProviderRuntime {
	const transport = options.transport ?? new Http2CursorAgentTransport();
	const uuid = options.uuid ?? defaultCursorUuid;
	const authService = options.authService ?? new CursorAuthService({ uuid });
	const discoveryService = options.discoveryService ?? new CursorModelDiscoveryService({ transport });
	const catalogCache = options.catalogCache ?? new FileCursorCatalogCache();
	const catalogDiscoveryDisposeTimeoutMs = options.catalogDiscoveryDisposeTimeoutMs ?? DEFAULT_CATALOG_DISCOVERY_DISPOSE_TIMEOUT_MS;
	const catalogCacheTtlMs = options.catalogCacheTtlMs ?? CURSOR_CATALOG_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	const streamAdapter = options.streamAdapter ?? new CursorStreamAdapter({
		transport,
		conversationState: new CursorConversationStateStore(),
		uuid,
		disposeGraceMs: options.streamDisposeGraceMs,
	});
	const catalogDiscoveryTasks = new Set<Promise<boolean>>();
	const catalogDiscoveryAbortControllers = new Set<AbortController>();
	let lastCatalogFetchedAt: number | undefined;
	let lastCatalogAccessToken: string | undefined;
	let lastCatalogCredentialScope: string | undefined;
	let catalogRefreshGeneration = 0;
	let lastCatalogGeneration: number | undefined;
	let resolveCurrentAccessToken = options.resolveCurrentAccessToken;
	let credentialResolverEpoch = 0;
	let authenticatedCredentialScope: string | undefined;
	let catalogRefreshStatus: CursorCatalogRefreshStatus = { state: "idle" };
	const catalogDiscoveryInFlightTokens = new Map<string, { readonly generation: number; readonly task: Promise<boolean>; readonly controller: AbortController }>();
	let disposing = false;
	let disposed = false;
	const executionActivationController = new AbortController();
	let disposePromise: Promise<void> | undefined;

	const loadCachedLiveCatalog = (credentialScope: string): CursorModelCatalog | null => {
		try {
			const catalog = catalogCache.load(credentialScope);
			return catalog?.credentialScope === credentialScope ? catalog : null;
		} catch {
			return null;
		}
	};

	const saveLiveCatalog = (catalog: CursorModelCatalog, credentialScope: string | undefined): Error | undefined => {
		try {
			catalogCache.save(catalog, credentialScope);
			return undefined;
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			return new Error(`Cursor model catalog cache persistence failed: ${detail}`);
		}
	};

	const registerCatalog = (catalogModels: readonly CursorProviderModelDefinition[]): void => {
		pi.registerProvider(CURSOR_PROVIDER_ID, {
			name: CURSOR_PROVIDER_NAME,
			baseUrl: CURSOR_API_BASE_URL,
			api: CURSOR_API,
			models: catalogModels,
			oauth: {
				name: CURSOR_LOGIN_NAME,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					const credentials = await authService.login(callbacks);
					credentialResolverEpoch += 1;
					const preexistingTask = catalogDiscoveryInFlightTokens.get(credentials.access)?.task;
					const task = scheduleTrackedCatalogDiscovery(credentials.access, true);
					const ownsTask = task !== undefined && task !== preexistingTask;
					const registered = task ? await waitForCursorLoginCatalog(task, callbacks.signal) : false;
					if (callbacks.signal?.aborted && ownsTask && task) cancelOwnedCatalogDiscovery(credentials.access, task);
					const credentialScope = deriveCursorCredentialScope(credentials.access);
					const activeCredentialMatches = credentialScope
						? credentialScope === lastCatalogCredentialScope
						: credentials.access === lastCatalogAccessToken;
					if (!registered || callbacks.signal?.aborted || !activeCredentialMatches || catalogRefreshStatus.state !== "fresh") {
						throw new Error(`Cursor authentication succeeded, but authenticated model discovery failed: ${catalogRefreshStatus.error ?? "no live models were returned"}`);
					}
					authenticatedCredentialScope = credentialScope;
					return credentials;
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const refreshed = await authService.refreshToken(credentials);
					credentialResolverEpoch += 1;
					authenticatedCredentialScope = deriveCursorCredentialScope(refreshed.access);
					scheduleTrackedCatalogDiscovery(refreshed.access, true);
					return refreshed;
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			},
			streamSimple(model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream {
				return streamAdapter.streamSimple(model, context, streamOptions);
			},
		});
	};
	let handleAuthorityExpiry: (expiry: CursorExecutionAuthorityExpiry) => void = () => undefined;
	const executionAuthority = new CursorExecutionAuthority({
		now,
		ttlMs: catalogCacheTtlMs,
		scheduler: options.executionAuthorityScheduler,
		onExpire: (expiry) => handleAuthorityExpiry(expiry),
	});
	const clearScopedCacheBestEffort = (credentialScope: string | undefined): void => {
		try {
			const pending = catalogCache.clear?.(credentialScope);
			if (pending) void pending.catch((cause) => {
				const error = cause instanceof Error ? cause : new Error("Cursor catalog cache clear failed.");
				options.onCatalogRefreshError?.(error);
			});
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error("Cursor catalog cache clear failed.");
			options.onCatalogRefreshError?.(error);
		}
	};
	const clearActiveCatalog = (credentialScope: string | undefined, clearCache: boolean): void => {
		executionAuthority.revoke();
		registerCatalog([]);
		lastCatalogFetchedAt = undefined;
		lastCatalogGeneration = undefined;
		if (clearCache) clearScopedCacheBestEffort(credentialScope);
	};
	handleAuthorityExpiry = (expiry): void => {
		if (expiry.credentialScope !== lastCatalogCredentialScope || expiry.generation !== lastCatalogGeneration) return;
		clearActiveCatalog(expiry.credentialScope, true);
		catalogRefreshStatus = { state: "failed", error: "Cursor model catalog expired; refresh and reselect a model." };
	};
	const registerLiveCatalog = (catalog: CursorModelCatalog, generation: number, accessToken: string): boolean => {
		if (disposed) return false;
		if (generation !== catalogRefreshGeneration) return true;
		const credentialScope = deriveCursorCredentialScope(accessToken);
		const scopedCatalog = credentialScope ? { ...catalog, credentialScope } : catalog;
		if (disposing) return false;
		registerCatalog(mapCursorCatalogToProviderModels(scopedCatalog));
		lastCatalogFetchedAt = catalog.fetchedAt;
		lastCatalogAccessToken = accessToken;
		lastCatalogCredentialScope = credentialScope;
		lastCatalogGeneration = generation;
		if (credentialScope) executionAuthority.publish(scopedCatalog, credentialScope, generation);
		else executionAuthority.revoke();
		const persistenceError = saveLiveCatalog(scopedCatalog, credentialScope);
		catalogRefreshStatus = {
			state: "fresh",
			fetchedAt: catalog.fetchedAt,
			...(persistenceError ? { error: persistenceError.message } : {}),
		};
		if (persistenceError) options.onCatalogRefreshError?.(persistenceError);
		return true;
	};
	const discoverAndRegisterLiveCatalog = async (
		accessToken: string,
		requestId: string,
		signal: AbortSignal | undefined,
		generation: number,
	): Promise<boolean> => {
		const liveCatalog = await discoveryService.discover(accessToken, requestId, signal);
		return registerLiveCatalog(liveCatalog, generation, accessToken);
	};
	const registerLiveCatalogBestEffort = async (
		accessToken: string,
		requestId: string,
		signal: AbortSignal | undefined,
		generation: number,
	): Promise<boolean> => {
		if (generation === catalogRefreshGeneration) catalogRefreshStatus = { state: "refreshing", fetchedAt: lastCatalogFetchedAt };
		try {
			return await discoverAndRegisterLiveCatalog(accessToken, requestId, signal, generation);
		} catch (cause) {
			if (generation !== catalogRefreshGeneration) return true;
			const rawError = cause instanceof Error ? cause : new Error("Cursor model catalog refresh failed.");
			const error = new Error(sanitizeDiagnosticText(rawError.message, [accessToken]));
			const credentialScope = deriveCursorCredentialScope(accessToken);
			if (cause instanceof CursorModelDiscoveryError && cause.code === "NoUsableModels") {
				clearActiveCatalog(credentialScope, true);
				catalogRefreshStatus = { state: "failed", error: error.message };
				options.onCatalogRefreshError?.(error);
				return false;
			}
			const activeCredentialMatches = credentialScope
				? credentialScope === lastCatalogCredentialScope
				: accessToken === lastCatalogAccessToken;
			const canRetainFreshSnapshot = activeCredentialMatches
				&& isCatalogFresh(lastCatalogFetchedAt, now(), catalogCacheTtlMs);
			if (!canRetainFreshSnapshot) clearActiveCatalog(credentialScope, true);
			catalogRefreshStatus = canRetainFreshSnapshot
				? { state: "fresh", fetchedAt: lastCatalogFetchedAt, error: error.message }
				: { state: "failed", error: error.message };
			options.onCatalogRefreshError?.(error);
			return canRetainFreshSnapshot;
		}
	};

	const activateCredentialCache = (accessToken: string): void => {
		const credentialScope = deriveCursorCredentialScope(accessToken);
		const sameCredential = credentialScope
			? credentialScope === lastCatalogCredentialScope
			: accessToken === lastCatalogAccessToken;
		if (sameCredential) return;
		catalogRefreshGeneration += 1;
		clearActiveCatalog(lastCatalogCredentialScope, false);
		lastCatalogAccessToken = accessToken;
		lastCatalogCredentialScope = credentialScope;
		catalogRefreshStatus = { state: "idle" };
		if (!credentialScope) return;
		const cached = loadCachedLiveCatalog(credentialScope);
		if (!cached || !isCatalogFresh(cached.fetchedAt, now(), catalogCacheTtlMs)) return;
		registerCatalog(mapCursorCatalogToProviderModels(cached));
		lastCatalogFetchedAt = cached.fetchedAt;
		executionAuthority.publish(cached, credentialScope, catalogRefreshGeneration);
		lastCatalogGeneration = catalogRefreshGeneration;
		catalogRefreshStatus = { state: "fresh", fetchedAt: cached.fetchedAt };
	};

	const scheduleTrackedCatalogDiscovery = (accessToken: string, force = false): Promise<boolean> | undefined => {
		if (disposing || disposed || accessToken.trim().length === 0) return undefined;
		if (!force && accessToken === lastCatalogAccessToken && isCatalogFresh(lastCatalogFetchedAt, now(), catalogCacheTtlMs)) return undefined;
		activateCredentialCache(accessToken);
		const credentialScope = deriveCursorCredentialScope(accessToken);
		const sameCredential = credentialScope ? credentialScope === lastCatalogCredentialScope : accessToken === lastCatalogAccessToken;
		const hasFreshSnapshot = sameCredential && isCatalogFresh(lastCatalogFetchedAt, now(), catalogCacheTtlMs);
		if (!force && hasFreshSnapshot) return undefined;
		if (!hasFreshSnapshot) {
			clearActiveCatalog(credentialScope, false);
			catalogRefreshStatus = { state: "idle" };
		}
		const existing = catalogDiscoveryInFlightTokens.get(accessToken);
		if (existing?.generation === catalogRefreshGeneration) return existing.task;
		let requestId: string;
		try {
			requestId = uuid();
		} catch {
			return undefined;
		}
		const generation = ++catalogRefreshGeneration;
		const controller = new AbortController();
		catalogDiscoveryAbortControllers.add(controller);
		const task = registerLiveCatalogBestEffort(accessToken, requestId, controller.signal, generation);
		catalogDiscoveryInFlightTokens.set(accessToken, { generation, task, controller });
		catalogDiscoveryTasks.add(task);
		task.then(
			() => {
				if (catalogDiscoveryInFlightTokens.get(accessToken)?.task === task) catalogDiscoveryInFlightTokens.delete(accessToken);
				catalogDiscoveryTasks.delete(task);
				catalogDiscoveryAbortControllers.delete(controller);
			},
			() => {
				if (catalogDiscoveryInFlightTokens.get(accessToken)?.task === task) catalogDiscoveryInFlightTokens.delete(accessToken);
				catalogDiscoveryTasks.delete(task);
				catalogDiscoveryAbortControllers.delete(controller);
			},
		);
		return task;
	};

	const cancelOwnedCatalogDiscovery = (accessToken: string, task: Promise<boolean>): void => {
		const active = catalogDiscoveryInFlightTokens.get(accessToken);
		if (!active || active.task !== task) return;
		catalogRefreshGeneration += 1;
		catalogDiscoveryInFlightTokens.delete(accessToken);
		active.controller.abort();
		clearActiveCatalog(lastCatalogCredentialScope, false);
		catalogRefreshStatus = { state: "failed", error: "Cursor model discovery was cancelled." };
	};


	const reportPrintCatalogWarning = (context: CursorProviderContext | undefined): void => {
		const message = catalogRefreshStatus.error ?? "Cursor model catalog refresh failed; retained the previous catalog.";
		const diagnostic = `Cursor model refresh warning: ${message}`;
		if (options.onCatalogDiagnostic) options.onCatalogDiagnostic(diagnostic);
		else console.error(diagnostic);
		context?.ui?.notify(diagnostic, "warning");
	};

	const invalidateMissingCredential = (message: string): Error => {
		const error = new Error(message);
		credentialResolverEpoch += 1;
		catalogRefreshGeneration += 1;
		for (const controller of catalogDiscoveryAbortControllers) controller.abort();
		const hadCatalogState = lastCatalogFetchedAt !== undefined
			|| lastCatalogCredentialScope !== undefined
			|| lastCatalogAccessToken !== undefined;
		if (hadCatalogState) clearActiveCatalog(lastCatalogCredentialScope, true);
		else executionAuthority.revoke();
		lastCatalogAccessToken = undefined;
		lastCatalogCredentialScope = undefined;
		authenticatedCredentialScope = undefined;
		catalogRefreshStatus = { state: "failed", error: error.message };
		options.onCatalogRefreshError?.(error);
		return error;
	};
	const activateCurrentExecutionCredential = (accessToken: string, credentialScope: string, signal?: AbortSignal) =>
		activateCursorExecutionCredential(accessToken, credentialScope, signal, {
			currentEpoch: () => credentialResolverEpoch,
			inactive: () => disposing || disposed,
			currentResolver: () => resolveCurrentAccessToken,
			authenticatedCredentialScope: () => authenticatedCredentialScope,
			scheduleDiscovery: (token) => scheduleTrackedCatalogDiscovery(token),
			activeCredentialScope: () => lastCatalogCredentialScope,
			invalidateCredential: (message) => { invalidateMissingCredential(message); },
			activationSignal: executionActivationController.signal,
		});
	const authorizeExecution = (model: Model<Api>, accessToken: string, signal?: AbortSignal) =>
		executionAuthority.authorize(model, accessToken, signal, {
			isActive: () => !disposing && !disposed,
			activeCredentialScope: () => lastCatalogCredentialScope,
			now,
			ttlMs: catalogCacheTtlMs,
			discover: (token) => scheduleTrackedCatalogDiscovery(token),
			activateCurrentCredential: activateCurrentExecutionCredential,
		});

	const discoverCatalogFromStoredCredentials = (event?: unknown, context?: CursorProviderContext): Promise<void> => {
		const generation = ++credentialResolverEpoch;
		return discoverStoredCursorCredential(event, context, {
			inactive: () => disposing || disposed || generation !== credentialResolverEpoch,
			useContextResolver: (resolver) => { resolveCurrentAccessToken = resolver; },
			resolveAccessToken: () => resolveCurrentAccessToken?.(), invalidateCredential: invalidateMissingCredential,
			scheduleDiscovery: (accessToken) => scheduleTrackedCatalogDiscovery(accessToken),
			refreshError: () => catalogRefreshStatus.error,
			reportPrintWarning: (providerContext) => reportPrintCatalogWarning(providerContext),
		});
	};

	const cleanupCurrentSession = async (_event?: unknown, context?: CursorProviderContext): Promise<void> => {
		const sessionId = context?.sessionManager?.getSessionId?.();
		if (sessionId) await streamAdapter.cleanupSession(sessionId);
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposing = true;
		credentialResolverEpoch += 1;
		executionActivationController.abort(new Error("Cursor provider is disposing."));
		executionAuthority.close();
		registerCatalog([]);
		lastCatalogFetchedAt = undefined;
		lastCatalogGeneration = undefined;
		catalogRefreshStatus = { state: "idle" };
		disposePromise = (async () => {
			await waitForCatalogDiscoveryTasks(catalogDiscoveryTasks, catalogDiscoveryDisposeTimeoutMs);
			disposed = true;
			catalogRefreshGeneration += 1;
			for (const controller of catalogDiscoveryAbortControllers) controller.abort();
			lastCatalogAccessToken = undefined;
			lastCatalogCredentialScope = undefined;
			authenticatedCredentialScope = undefined;
			await streamAdapter.dispose();
		})();
		return disposePromise;
	};

	streamAdapter.bindExecutionAuthority(authorizeExecution);
	registerCatalog([]);

	const cleanupCurrentSessionAndDispose = async (event?: unknown, context?: CursorProviderContext): Promise<void> => {
		try {
			await cleanupCurrentSession(event, context);
		} finally {
			await disposeRuntime();
		}
	};

	pi.on("model_catalog_discover", discoverCatalogFromStoredCredentials);
	pi.on("session_start", discoverCatalogFromStoredCredentials);
	pi.on("session_before_switch", cleanupCurrentSession);
	pi.on("session_before_fork", cleanupCurrentSession);
	pi.on("session_before_tree", cleanupCurrentSession);
	pi.on("session_shutdown", cleanupCurrentSessionAndDispose);

	return {
		transport,
		authService,
		discoveryService,
		streamAdapter,
		catalogCache,
		getCatalogRefreshStatus: () => catalogRefreshStatus,
		dispose: disposeRuntime,
	};
}


export default function cursorProviderExtension(pi: CursorProviderHost): void {
	registerCursorProvider(pi);
}
