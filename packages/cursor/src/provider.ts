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
import { CursorConversationStateStore } from "./conversation-state.js";
import { ensureDefaultCursorModel, CursorModelDiscoveryError, CursorModelDiscoveryService } from "./models.js";
import { createEstimatedCursorCatalog, mapCursorCatalogToProviderModels, type CursorProviderModelDefinition } from "./model-mapper.js";
import { CursorStreamAdapter } from "./stream.js";
import { Http2CursorAgentTransport, type CursorAgentTransport } from "./transport.js";

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
	readonly uuid?: () => string;
}

export interface CursorProviderRuntime {
	readonly transport: CursorAgentTransport;
	readonly authService: CursorAuthService;
	readonly discoveryService: CursorModelDiscoveryService;
	readonly streamAdapter: CursorStreamAdapter;
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
	const streamAdapter = options.streamAdapter ?? new CursorStreamAdapter({
		transport,
		conversationState: new CursorConversationStateStore(),
		uuid,
	});

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
					await registerLiveCatalogOrFallback(refreshed.access, uuid(), undefined, false);
					return refreshed;
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			},
			streamSimple: streamAdapter.streamSimple,
		});
	};

	const registerLiveCatalogOrFallback = async (
		accessToken: string,
		requestId: string,
		signal: AbortSignal | undefined,
		throwOnEmptyCatalog: boolean,
	): Promise<void> => {
		try {
			const liveCatalog = ensureDefaultCursorModel(await discoveryService.discover(accessToken, requestId, signal));
			registerCatalog(mapCursorCatalogToProviderModels(liveCatalog));
		} catch (error) {
			if (!(error instanceof CursorModelDiscoveryError)) {
				throw error;
			}
			if (!isEstimatedCatalogFallbackAllowed(error, throwOnEmptyCatalog)) {
				throw error;
			}
			registerCatalog(mapCursorCatalogToProviderModels(createEstimatedCursorCatalog()));
		}
	};

	registerCatalog(mapCursorCatalogToProviderModels(createEstimatedCursorCatalog()));

	pi.on("session_shutdown", async () => {
		await streamAdapter.dispose();
	});

	return {
		transport,
		authService,
		discoveryService,
		streamAdapter,
		async dispose(): Promise<void> {
			await streamAdapter.dispose();
		},
	};
}

function isEstimatedCatalogFallbackAllowed(error: CursorModelDiscoveryError, throwOnEmptyCatalog: boolean): boolean {
	if (error.code === "NetworkError") return true;
	if (error.code === "ProtocolError") return true;
	if (error.code === "NoUsableModels") return !throwOnEmptyCatalog;
	return false;
}

export default function cursorProviderExtension(pi: CursorProviderHost): void {
	registerCursorProvider(pi);
}
