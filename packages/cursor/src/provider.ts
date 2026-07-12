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
} from "./config.js";
import { CursorAuthService } from "./auth.js";
import { FileCursorCatalogCache, type CursorCatalogCache } from "./catalog-cache.js";
import { CursorConversationStateStore } from "./conversation-state.js";
import { CursorModelDiscoveryService } from "./models.js";
import {
	createEstimatedCursorCatalog,
	mapCursorCatalogToProviderModels,
	type CursorModelCatalog,
	type CursorProviderModelDefinition,
} from "./model-mapper.js";
import { CursorStreamAdapter } from "./stream.js";
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
export type CursorProviderEvent = "session_start" | CursorSessionLifecycleEvent;

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
	readonly now?: () => number;
	readonly onCatalogRefreshError?: (error: Error) => void;
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

function defaultCursorUuid(): string {
	return nodeRandomUUID();
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
	});
	const catalogDiscoveryTasks = new Set<Promise<boolean>>();
	const catalogDiscoveryAbortControllers = new Set<AbortController>();
	let lastCatalogFetchedAt: number | undefined;
	let catalogRefreshStatus: CursorCatalogRefreshStatus = { state: "idle" };
	const catalogDiscoveryInFlightTokens = new Map<string, Promise<boolean>>();
	let firstUseRediscoveryTask: Promise<boolean> | undefined;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	const loadCachedLiveCatalog = (): CursorModelCatalog | null => {
		try {
			return catalogCache.load();
		} catch {
			return null;
		}
	};

	const saveLiveCatalog = (catalog: CursorModelCatalog): Error | undefined => {
		try {
			catalogCache.save(catalog);
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
					await registerLiveCatalogBestEffort(credentials.access, uuid(), callbacks.signal);
					return credentials;
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const refreshed = await authService.refreshToken(credentials);
					scheduleTrackedCatalogDiscovery(refreshed.access, true);
					return refreshed;
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			},
			streamSimple(model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream {
				scheduleFirstUseRediscovery(streamOptions?.apiKey);
				return streamAdapter.streamSimple(model, context, streamOptions);
			},
		});
	};

	const registerLiveCatalog = (catalog: CursorModelCatalog): boolean => {
		if (disposed) return false;
		registerCatalog(mapCursorCatalogToProviderModels(catalog));
		lastCatalogFetchedAt = catalog.fetchedAt;
		const persistenceError = saveLiveCatalog(catalog);
		catalogRefreshStatus = {
			state: "fresh",
			fetchedAt: catalog.fetchedAt,
			...(persistenceError ? { error: persistenceError.message } : {}),
		};
		if (persistenceError) options.onCatalogRefreshError?.(persistenceError);
		return true;
	};

	const discoverAndRegisterLiveCatalog = async (accessToken: string, requestId: string, signal: AbortSignal | undefined): Promise<boolean> => {
		const liveCatalog = await discoveryService.discover(accessToken, requestId, signal);
		return registerLiveCatalog(liveCatalog);
	};

	const registerLiveCatalogBestEffort = async (accessToken: string, requestId: string, signal: AbortSignal | undefined): Promise<boolean> => {
		catalogRefreshStatus = { state: "refreshing", fetchedAt: lastCatalogFetchedAt };
		try {
			return await discoverAndRegisterLiveCatalog(accessToken, requestId, signal);
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error("Cursor model catalog refresh failed.");
			catalogRefreshStatus = { state: "failed", fetchedAt: lastCatalogFetchedAt, error: error.message };
			options.onCatalogRefreshError?.(error);
			return false;
		}
	};

	const scheduleTrackedCatalogDiscovery = (accessToken: string, force = false): Promise<boolean> | undefined => {
		if (disposed || accessToken.trim().length === 0) return undefined;
		if (!force && lastCatalogFetchedAt !== undefined && now() - lastCatalogFetchedAt < catalogCacheTtlMs) return undefined;
		const existing = catalogDiscoveryInFlightTokens.get(accessToken);
		if (existing) return existing;
		let requestId: string;
		try {
			requestId = uuid();
		} catch {
			return undefined;
		}
		const controller = new AbortController();
		catalogDiscoveryAbortControllers.add(controller);
		const task = registerLiveCatalogBestEffort(accessToken, requestId, controller.signal);
		catalogDiscoveryInFlightTokens.set(accessToken, task);
		catalogDiscoveryTasks.add(task);
		task.then(
			() => {
				catalogDiscoveryInFlightTokens.delete(accessToken);
				catalogDiscoveryTasks.delete(task);
				catalogDiscoveryAbortControllers.delete(controller);
			},
			() => {
				catalogDiscoveryInFlightTokens.delete(accessToken);
				catalogDiscoveryTasks.delete(task);
				catalogDiscoveryAbortControllers.delete(controller);
			},
		);
		return task;
	};

	const scheduleFirstUseRediscovery = (accessToken: string | undefined): void => {
		if (!accessToken || firstUseRediscoveryTask || disposed) return;
		const task = scheduleTrackedCatalogDiscovery(accessToken);
		if (!task) return;
		firstUseRediscoveryTask = task;
		task.then(
			() => { if (firstUseRediscoveryTask === task) firstUseRediscoveryTask = undefined; },
			() => { if (firstUseRediscoveryTask === task) firstUseRediscoveryTask = undefined; },
		);
	};

	const discoverCatalogFromStoredCredentials = async (_event?: unknown, context?: CursorProviderContext): Promise<void> => {
		if (disposed) return;
		let accessToken: string | undefined;
		try { accessToken = await context?.modelRegistry?.getApiKeyForProvider?.(CURSOR_PROVIDER_ID) } catch { return }
		if (!accessToken) return;
		const task = scheduleTrackedCatalogDiscovery(accessToken);
		if (!task) return;
		if (context?.mode !== "print") {
			void task.then((success) => {
				if (!success || catalogRefreshStatus.error) {
					context?.ui?.notify(`Cursor model refresh warning: ${catalogRefreshStatus.error ?? "retained the previous catalog"}`, "warning");
				}
			});
			return;
		}
		if (await task) return;
		const message = catalogRefreshStatus.error ?? "Cursor model catalog refresh failed; retained the previous catalog.";
		throw new Error(message);
	};

	const cleanupCurrentSession = async (_event?: unknown, context?: CursorProviderContext): Promise<void> => {
		const sessionId = context?.sessionManager?.getSessionId?.();
		if (sessionId) await streamAdapter.cleanupSession(sessionId);
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposePromise = (async () => {
			await waitForCatalogDiscoveryTasks(catalogDiscoveryTasks, catalogDiscoveryDisposeTimeoutMs);
			disposed = true;
			for (const controller of catalogDiscoveryAbortControllers) {
				controller.abort();
			}
			await streamAdapter.dispose();
		})();
		return disposePromise;
	};

	const startupCatalog = loadCachedLiveCatalog() ?? createEstimatedCursorCatalog();
	if (startupCatalog.source === "live") {
		lastCatalogFetchedAt = startupCatalog.fetchedAt;
		catalogRefreshStatus = { state: now() - startupCatalog.fetchedAt < catalogCacheTtlMs ? "fresh" : "idle", fetchedAt: startupCatalog.fetchedAt };
	}
	registerCatalog(mapCursorCatalogToProviderModels(startupCatalog));

	const cleanupCurrentSessionAndDispose = async (event?: unknown, context?: CursorProviderContext): Promise<void> => {
		try {
			await cleanupCurrentSession(event, context);
		} finally {
			await disposeRuntime();
		}
	};

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

async function waitForCatalogDiscoveryTasks(tasks: ReadonlySet<Promise<boolean>>, timeoutMs: number): Promise<void> {
	const pending = [...tasks];
	if (pending.length === 0 || timeoutMs <= 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(pending).then(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export default function cursorProviderExtension(pi: CursorProviderHost): void {
	registerCursorProvider(pi);
}
