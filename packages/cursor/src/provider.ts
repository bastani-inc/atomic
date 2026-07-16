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
import { CursorModelDiscoveryService } from "./models.js";
import {
	mapCursorCatalogToProviderModels,
	type CursorModelCatalog,
	type CursorProviderModelDefinition,
} from "./model-mapper.js";
import { CursorStreamAdapter } from "./stream.js";
import { waitForCatalogDiscoveryTasks, waitForCursorLoginCatalog } from "./provider-waits.js";
import { CursorCacheMutationCoordinator } from "./provider-cache-mutations.js";
import { discoverStoredCursorCredential } from "./provider-credential-discovery.js";
import { activateCursorExecutionCredential } from "./provider-execution-credential.js";
import { Http2CursorAgentTransport, type CursorAgentTransport } from "./transport.js";
import {
	CURSOR_CATALOG_CACHE_TTL_MS,
	DEFAULT_CATALOG_DISCOVERY_DISPOSE_TIMEOUT_MS,
	defaultCursorUuid,
	cursorCatalogFailureDisposition,
	isCatalogFresh,
	type CursorCatalogRefreshStatus,
	type CursorProviderEvent,
	type CursorProviderRuntime,
} from "./provider-runtime.js";
export { CURSOR_CATALOG_CACHE_TTL_MS, type CursorCatalogRefreshStatus, type CursorProviderEvent, type CursorProviderRuntime, type CursorSessionLifecycleEvent } from "./provider-runtime.js";
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
	let catalogApplicationGeneration: number | undefined;
	let resolveCurrentAccessToken = options.resolveCurrentAccessToken;
	let credentialResolverEpoch = 0;
	let oauthOwnerEpoch = 0;
	let authenticatedCredentialScope: string | undefined;
	let catalogRefreshStatus: CursorCatalogRefreshStatus = { state: "idle" };
	const cacheMutations = new CursorCacheMutationCoordinator({
		cache: catalogCache,
		onError: (error) => {
			if (catalogRefreshStatus.state === "fresh" || catalogRefreshStatus.state === "empty") {
				catalogRefreshStatus = { ...catalogRefreshStatus, error: error.message };
			}
			options.onCatalogRefreshError?.(error);
		},
	});
	const catalogDiscoveryInFlightTokens = new Map<string, { readonly generation: number; readonly task: Promise<boolean>; readonly controller: AbortController; readonly ownership: { oauthOwnerEpoch: number | undefined } }>();
	let disposing = false;
	let disposed = false;
	const executionActivationController = new AbortController();
	let disposePromise: Promise<void> | undefined;
	const assertCurrentOAuthOwner = (ownerEpoch: number): void => {
		if (ownerEpoch !== oauthOwnerEpoch || disposing || disposed) {
			throw new Error("Cursor OAuth operation was superseded by a newer login or refresh.");
		}
	};
	const loadCachedLiveCatalog = (credentialScope: string): CursorModelCatalog | null => {
		try {
			const catalog = cacheMutations.load(credentialScope);
			return catalog?.credentialScope === credentialScope && catalog.models.length > 0 ? catalog : null;
		} catch {
			return null;
		}
	};
	const saveLiveCatalog = (catalog: CursorModelCatalog, credentialScope: string | undefined): void => {
		if (credentialScope) cacheMutations.save(catalog, credentialScope);
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
					const ownerEpoch = ++oauthOwnerEpoch;
					const credentials = await authService.login(callbacks);
					assertCurrentOAuthOwner(ownerEpoch);
					if (callbacks.signal?.aborted) throw new Error("Cursor login was cancelled.");
					credentialResolverEpoch += 1;
					const task = scheduleTrackedCatalogDiscovery(credentials.access, true, ownerEpoch);
					const registered = task ? await waitForCursorLoginCatalog(task, callbacks.signal) : false;
					assertCurrentOAuthOwner(ownerEpoch);
					if (callbacks.signal?.aborted && task) cancelOwnedCatalogDiscovery(credentials.access, task, ownerEpoch);
					const credentialScope = deriveCursorCredentialScope(credentials.access);
					const activeCredentialMatches = credentialScope
						? credentialScope === lastCatalogCredentialScope
						: credentials.access === lastCatalogAccessToken;
					const discoveryCompleted = catalogRefreshStatus.state === "fresh" || catalogRefreshStatus.state === "empty";
					if (!registered || callbacks.signal?.aborted || !activeCredentialMatches || !discoveryCompleted) {
						throw new Error(`Cursor authentication succeeded, but authenticated model discovery failed: ${catalogRefreshStatus.error ?? "no live models were returned"}`);
					}
					assertCurrentOAuthOwner(ownerEpoch);
					authenticatedCredentialScope = credentialScope;
					assertCurrentOAuthOwner(ownerEpoch);
					return credentials;
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const ownerEpoch = ++oauthOwnerEpoch;
					const refreshed = await authService.refreshToken(credentials);
					assertCurrentOAuthOwner(ownerEpoch);
					credentialResolverEpoch += 1;
					authenticatedCredentialScope = deriveCursorCredentialScope(refreshed.access);
					assertCurrentOAuthOwner(ownerEpoch);
					scheduleTrackedCatalogDiscovery(refreshed.access, true, ownerEpoch);
					assertCurrentOAuthOwner(ownerEpoch);
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
	const clearScopedCacheBestEffort = (credentialScope: string | undefined): void => { if (credentialScope) cacheMutations.clear(credentialScope) };
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
	const registerLiveCatalog = async (catalog: CursorModelCatalog, generation: number, accessToken: string): Promise<boolean> => {
		if (disposed) return false;
		if (generation !== catalogRefreshGeneration) return true;
		const credentialScope = deriveCursorCredentialScope(accessToken);
		const scopedCatalog = credentialScope ? { ...catalog, credentialScope } : catalog;
		if (disposing) return false;
		if (scopedCatalog.models.length === 0) {
			executionAuthority.revoke();
			const cacheError = credentialScope ? await cacheMutations.authoritativeEmpty(scopedCatalog, credentialScope) : undefined;
			if (disposed || disposing) return false;
			if (generation !== catalogRefreshGeneration) return true;
			lastCatalogFetchedAt = undefined;
			lastCatalogAccessToken = accessToken;
			lastCatalogCredentialScope = credentialScope;
			lastCatalogGeneration = undefined;
			catalogRefreshStatus = { state: "empty", fetchedAt: catalog.fetchedAt };
			catalogApplicationGeneration = generation;
			registerCatalog([]);
			catalogApplicationGeneration = undefined;
			if (cacheError && generation === catalogRefreshGeneration && lastCatalogCredentialScope === credentialScope) {
				catalogRefreshStatus = { state: "failed", error: cacheError.message };
				options.onCatalogRefreshError?.(cacheError);
				return false;
			}
			return true;
		}
		// Discovery success revokes the previous authority before registry refresh.
		executionAuthority.revoke();
		lastCatalogFetchedAt = undefined;
		lastCatalogGeneration = undefined;
		catalogApplicationGeneration = generation;
		const providerModels = mapCursorCatalogToProviderModels(scopedCatalog);
		registerCatalog(providerModels);
		catalogApplicationGeneration = undefined;
		lastCatalogFetchedAt = catalog.fetchedAt;
		lastCatalogAccessToken = accessToken;
		lastCatalogCredentialScope = credentialScope;
		lastCatalogGeneration = generation;
		if (credentialScope) executionAuthority.publish(scopedCatalog, credentialScope, generation, providerModels as readonly Model<Api>[]);
		catalogRefreshStatus = { state: "fresh", fetchedAt: catalog.fetchedAt };
		saveLiveCatalog(scopedCatalog, credentialScope);
		return true;
	};
	const discoverAndRegisterLiveCatalog = async (
		accessToken: string,
		requestId: string,
		signal: AbortSignal | undefined,
		generation: number,
		ownership: { oauthOwnerEpoch: number | undefined },
	): Promise<boolean> => {
		const liveCatalog = await discoveryService.discover(accessToken, requestId, signal);
		if (ownership.oauthOwnerEpoch !== undefined && ownership.oauthOwnerEpoch !== oauthOwnerEpoch) return true;
		return await registerLiveCatalog(liveCatalog, generation, accessToken);
	};
	const registerLiveCatalogBestEffort = async (
		accessToken: string,
		requestId: string,
		signal: AbortSignal | undefined,
		generation: number,
		ownership: { oauthOwnerEpoch: number | undefined },
	): Promise<boolean> => {
		if (generation === catalogRefreshGeneration) catalogRefreshStatus = { state: "refreshing", fetchedAt: lastCatalogFetchedAt };
		try {
			return await discoverAndRegisterLiveCatalog(accessToken, requestId, signal, generation, ownership);
		} catch (cause) {
			if (generation !== catalogRefreshGeneration) return true;
			if (ownership.oauthOwnerEpoch !== undefined && ownership.oauthOwnerEpoch !== oauthOwnerEpoch) return true;
			const rawError = cause instanceof Error ? cause : new Error("Cursor model catalog refresh failed.");
			const error = new Error(sanitizeDiagnosticText(rawError.message, [accessToken]));
			const preserveAuthoritativeEmpty = catalogRefreshStatus.state === "empty";
			const catalogApplicationFailed = catalogApplicationGeneration === generation;
			if (catalogApplicationFailed) catalogApplicationGeneration = undefined;
			const credentialScope = deriveCursorCredentialScope(accessToken);
			const disposition = cursorCatalogFailureDisposition({ credentialScope, lastCredentialScope: lastCatalogCredentialScope,
				accessToken, lastAccessToken: lastCatalogAccessToken, lastFetchedAt: lastCatalogFetchedAt, now: now(),
				ttlMs: catalogCacheTtlMs, catalogApplicationFailed, preserveAuthoritativeEmpty });
			if (disposition.clearRegistry) {
				try { clearActiveCatalog(credentialScope, disposition.clearCache); } catch { executionAuthority.revoke(); }
			} else if (!disposition.retainFreshSnapshot) {
				executionAuthority.revoke();
				if (disposition.clearCache) clearScopedCacheBestEffort(credentialScope);
			}
			catalogRefreshStatus = disposition.retainFreshSnapshot
				? { state: "fresh", fetchedAt: lastCatalogFetchedAt, error: error.message }
				: { state: "failed", error: error.message };
			options.onCatalogRefreshError?.(error);
			return disposition.retainFreshSnapshot;
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
		const providerModels = mapCursorCatalogToProviderModels(cached);
		registerCatalog(providerModels);
		lastCatalogFetchedAt = cached.fetchedAt;
		executionAuthority.publish(cached, credentialScope, catalogRefreshGeneration, providerModels as readonly Model<Api>[]);
		lastCatalogGeneration = catalogRefreshGeneration;
		catalogRefreshStatus = { state: "fresh", fetchedAt: cached.fetchedAt };
	};
	const scheduleTrackedCatalogDiscovery = (accessToken: string, force = false, ownerEpoch?: number): Promise<boolean> | undefined => {
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
		if (existing?.generation === catalogRefreshGeneration) {
			// Transfer only an OAuth-owned producer. Independent stored/execution
			// producers remain ownerless and survive a joining login's cancellation.
			if (ownerEpoch !== undefined && existing.ownership.oauthOwnerEpoch !== undefined) {
				existing.ownership.oauthOwnerEpoch = ownerEpoch;
			}
			return existing.task;
		}
		let requestId: string;
		try {
			requestId = uuid();
		} catch {
			return undefined;
		}
		const generation = ++catalogRefreshGeneration;
		const controller = new AbortController();
		catalogDiscoveryAbortControllers.add(controller);
		const ownership = { oauthOwnerEpoch: ownerEpoch };
		const task = registerLiveCatalogBestEffort(accessToken, requestId, controller.signal, generation, ownership);
		catalogDiscoveryInFlightTokens.set(accessToken, { generation, task, controller, ownership });
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
	const cancelOwnedCatalogDiscovery = (accessToken: string, task: Promise<boolean>, ownerEpoch: number): void => {
		if (ownerEpoch !== oauthOwnerEpoch || disposing || disposed) return;
		const active = catalogDiscoveryInFlightTokens.get(accessToken);
		if (!active || active.task !== task || active.generation !== catalogRefreshGeneration
			|| active.ownership.oauthOwnerEpoch !== ownerEpoch) return;
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
	const disposeRuntime = async (suppressCatalogRefreshError = false): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposing = true;
		oauthOwnerEpoch += 1;
		credentialResolverEpoch += 1;
		executionActivationController.abort(new Error("Cursor provider is disposing."));
		executionAuthority.close();
		if (suppressCatalogRefreshError) { try { registerCatalog([]); } catch { /* registry update landed before teardown refresh failed */ } } else registerCatalog([]);
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
			const finalQuit = (event as { readonly type?: unknown; readonly reason?: unknown } | undefined)?.type === "session_shutdown" && (event as { readonly reason?: unknown }).reason === "quit"; await disposeRuntime(finalQuit);
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
