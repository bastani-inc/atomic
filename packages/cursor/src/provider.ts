import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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
import { CursorModelDiscoveryError, CursorModelDiscoveryService } from "./models.js";
import {
	createEstimatedCursorCatalog,
	mapCursorCatalogToProviderModels,
	type CursorModelCatalog,
	type CursorProviderModelDefinition,
} from "./model-mapper.js";
import { CursorStreamAdapter } from "./stream.js";
import { Http2CursorAgentTransport, type CursorAgentTransport } from "./transport.js";

const DEFAULT_CATALOG_DISCOVERY_DISPOSE_TIMEOUT_MS = 1_000;

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

export interface CursorProviderHost {
	registerProvider(name: string, config: CursorProviderConfig): void;
	on(event: "session_shutdown", handler: () => Promise<void> | void): void;
}

export interface CursorProviderRegistrationOptions {
	readonly transport?: CursorAgentTransport;
	readonly authService?: CursorAuthService;
	readonly discoveryService?: CursorModelDiscoveryService;
	readonly streamAdapter?: CursorStreamAdapter;
	readonly catalogCache?: CursorCatalogCache;
	readonly catalogDiscoveryDisposeTimeoutMs?: number;
	readonly uuid?: () => string;
}

export interface CursorProviderRuntime {
	readonly transport: CursorAgentTransport;
	readonly authService: CursorAuthService;
	readonly discoveryService: CursorModelDiscoveryService;
	readonly streamAdapter: CursorStreamAdapter;
	readonly catalogCache: CursorCatalogCache;
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
	const streamAdapter = options.streamAdapter ?? new CursorStreamAdapter({
		transport,
		conversationState: new CursorConversationStateStore(),
		uuid,
	});
	const catalogDiscoveryTasks = new Set<Promise<void>>();
	const catalogDiscoveryAbortControllers = new Set<AbortController>();
	let firstUseRediscoveryTask: Promise<void> | undefined;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	const loadCachedLiveCatalog = (): CursorModelCatalog | null => {
		try {
			return catalogCache.load();
		} catch {
			return null;
		}
	};

	const saveLiveCatalog = (catalog: CursorModelCatalog): void => {
		try {
			catalogCache.save(catalog);
		} catch {
			// Cache writes are best-effort and must never make auth/model use fail.
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
					await registerLiveCatalogOrFallback(credentials.access, uuid(), callbacks.signal, true);
					return credentials;
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const refreshed = await authService.refreshToken(credentials);
					scheduleTrackedCatalogDiscovery(refreshed.access);
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

	const registerLiveCatalog = (catalog: CursorModelCatalog): void => {
		if (disposed) return;
		registerCatalog(mapCursorCatalogToProviderModels(catalog));
		saveLiveCatalog(catalog);
	};

	const discoverAndRegisterLiveCatalog = async (accessToken: string, requestId: string, signal: AbortSignal | undefined): Promise<void> => {
		const liveCatalog = await discoveryService.discover(accessToken, requestId, signal);
		registerLiveCatalog(liveCatalog);
	};

	const registerLiveCatalogOrFallback = async (
		accessToken: string,
		requestId: string,
		signal: AbortSignal | undefined,
		throwOnEmptyCatalog: boolean,
	): Promise<void> => {
		try {
			await discoverAndRegisterLiveCatalog(accessToken, requestId, signal);
		} catch (error) {
			if (!(error instanceof CursorModelDiscoveryError)) {
				throw error;
			}
			if (!isEstimatedCatalogFallbackAllowed(error, throwOnEmptyCatalog)) {
				throw error;
			}
			const fallbackCatalog = loadCachedLiveCatalog() ?? createEstimatedCursorCatalog();
			registerCatalog(mapCursorCatalogToProviderModels(fallbackCatalog));
		}
	};

	const registerLiveCatalogBestEffort = async (accessToken: string, requestId: string, signal: AbortSignal | undefined): Promise<void> => {
		try {
			await discoverAndRegisterLiveCatalog(accessToken, requestId, signal);
		} catch {
			// Refresh and first-use discovery are best-effort. Never leak tokens via errors/logs.
		}
	};

	const scheduleTrackedCatalogDiscovery = (accessToken: string): Promise<void> | undefined => {
		if (disposed) return undefined;
		let requestId: string;
		try {
			requestId = uuid();
		} catch {
			return undefined;
		}
		const controller = new AbortController();
		catalogDiscoveryAbortControllers.add(controller);
		const task = registerLiveCatalogBestEffort(accessToken, requestId, controller.signal);
		catalogDiscoveryTasks.add(task);
		task.then(
			() => {
				catalogDiscoveryTasks.delete(task);
				catalogDiscoveryAbortControllers.delete(controller);
			},
			() => {
				catalogDiscoveryTasks.delete(task);
				catalogDiscoveryAbortControllers.delete(controller);
			},
		);
		return task;
	};

	const scheduleFirstUseRediscovery = (accessToken: string | undefined): void => {
		if (!accessToken || firstUseRediscoveryTask || disposed) return;
		firstUseRediscoveryTask = scheduleTrackedCatalogDiscovery(accessToken);
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposePromise = (async () => {
			disposed = true;
			for (const controller of catalogDiscoveryAbortControllers) {
				controller.abort();
			}
			await waitForCatalogDiscoveryTasks(catalogDiscoveryTasks, catalogDiscoveryDisposeTimeoutMs);
			await streamAdapter.dispose();
		})();
		return disposePromise;
	};

	const startupCatalog = loadCachedLiveCatalog() ?? createEstimatedCursorCatalog();
	registerCatalog(mapCursorCatalogToProviderModels(startupCatalog));

	pi.on("session_shutdown", disposeRuntime);

	return {
		transport,
		authService,
		discoveryService,
		streamAdapter,
		catalogCache,
		dispose: disposeRuntime,
	};
}

function isEstimatedCatalogFallbackAllowed(error: CursorModelDiscoveryError, throwOnEmptyCatalog: boolean): boolean {
	if (error.code === "NetworkError") return true;
	if (error.code === "ProtocolError") return true;
	if (error.code === "NoUsableModels") return !throwOnEmptyCatalog;
	return false;
}

async function waitForCatalogDiscoveryTasks(tasks: ReadonlySet<Promise<void>>, timeoutMs: number): Promise<void> {
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
