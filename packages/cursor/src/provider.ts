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
import { validateCursorHostOAuthCredential } from "./account-scope.js";
import { CursorAuthService } from "./auth.js";
import { FileCursorCatalogCache, type CursorCatalogCache } from "./catalog-cache.js";
import {
	CURSOR_API,
	CURSOR_API_BASE_URL,
	CURSOR_CLIENT_VERSION,
	CURSOR_LOGIN_NAME,
	CURSOR_PROVIDER_ID,
	CURSOR_PROVIDER_NAME,
} from "./config.js";
import { CursorConversationStateStore } from "./conversation-state.js";
import type { CursorProviderModelDefinition } from "./model-mapper.js";
import { CursorModelDiscoveryService, type CursorDiscoveryService } from "./models.js";
import { CursorPreparationController } from "./preparation.js";
import { CursorStreamAdapter } from "./stream.js";
import { Http2CursorAgentTransport, type CursorAgentTransport } from "./transport.js";

export interface CursorProviderOAuthConfig {
	readonly name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
}

interface CursorRefreshContext {
	readonly hostCredential?: { readonly type: "api_key"; readonly key: string } | ({ readonly type: "oauth" } & OAuthCredentials);
	readonly credentialGeneration: number;
	readonly providerInstanceGeneration: number;
	readonly isCurrentGeneration?: () => boolean;
	readonly allowNetwork: boolean;
	readonly force?: boolean;
	readonly signal?: AbortSignal;
}

export interface CursorProviderConfig {
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly models: readonly CursorProviderModelDefinition[];
	readonly requiresPreparation: true;
	readonly requiresExactSelectionPersistence: true;
	readonly requiresHostOAuth: true;
	readonly validateHostOAuth: (credential: OAuthCredentials) => void;
	readonly refreshModels: (context: CursorRefreshContext) => Promise<readonly CursorProviderModelDefinition[]>;
	readonly oauth: CursorProviderOAuthConfig;
	readonly streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}

export type CursorSessionLifecycleEvent = "session_before_switch" | "session_before_fork" | "session_before_tree" | "session_shutdown";

export interface CursorProviderContext {
	readonly sessionManager?: { getSessionId?(): string };
}

export interface CursorProviderHost {
	registerProvider(name: string, config: CursorProviderConfig): void;
	on(event: CursorSessionLifecycleEvent, handler: (event?: object, context?: CursorProviderContext) => Promise<void> | void): void;
}

export interface CursorProviderRegistrationOptions {
	readonly transport?: CursorAgentTransport;
	readonly authService?: CursorAuthService;
	readonly discoveryService?: CursorDiscoveryService;
	readonly streamAdapter?: CursorStreamAdapter;
	readonly catalogCache?: CursorCatalogCache;
	readonly uuid?: () => string;
	readonly now?: () => number;
	readonly clientVersion?: () => string;
}

export interface CursorProviderRuntime {
	readonly transport: CursorAgentTransport;
	readonly authService: CursorAuthService;
	readonly discoveryService: CursorDiscoveryService;
	readonly streamAdapter: CursorStreamAdapter;
	readonly catalogCache: CursorCatalogCache;
	readonly preparation: CursorPreparationController;
	dispose(): Promise<void>;
}

export function registerCursorProvider(pi: CursorProviderHost, options: CursorProviderRegistrationOptions = {}): CursorProviderRuntime {
	const transport = options.transport ?? new Http2CursorAgentTransport();
	const uuid = options.uuid ?? nodeRandomUUID;
	const authService = options.authService ?? new CursorAuthService({ uuid, now: options.now });
	const discoveryService = options.discoveryService ?? new CursorModelDiscoveryService({ transport, now: options.now });
	const catalogCache = options.catalogCache ?? new FileCursorCatalogCache(undefined, options.now);
	const preparation = new CursorPreparationController({
		discovery: discoveryService,
		cache: catalogCache,
		clientVersion: options.clientVersion ?? (() => CURSOR_CLIENT_VERSION),
		now: options.now,
		uuid,
	});
	const streamAdapter = options.streamAdapter ?? new CursorStreamAdapter({
		transport,
		conversationState: new CursorConversationStateStore(),
		uuid,
		routeAuthority: preparation,
	});
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	pi.registerProvider(CURSOR_PROVIDER_ID, {
		name: CURSOR_PROVIDER_NAME,
		baseUrl: CURSOR_API_BASE_URL,
		api: CURSOR_API,
		models: [],
		requiresPreparation: true,
		requiresExactSelectionPersistence: true,
		requiresHostOAuth: true,
		validateHostOAuth: (credential) => validateCursorHostOAuthCredential({ type: "oauth", ...credential }, Number.NEGATIVE_INFINITY),
		refreshModels: async (context) => preparation.prepare({
			hostCredential: context.hostCredential?.type === "oauth" ? context.hostCredential : undefined,
			credentialGeneration: context.credentialGeneration,
			providerInstanceGeneration: context.providerInstanceGeneration,
			isCurrentGeneration: context.isCurrentGeneration,
			allowNetwork: context.allowNetwork,
			force: context.force,
			signal: context.signal,
		}),
		oauth: {
			name: CURSOR_LOGIN_NAME,
			login: (callbacks) => authService.login(callbacks),
			refreshToken: (credentials) => authService.refreshToken(credentials),
			getApiKey: (credentials) => credentials.access,
		},
		streamSimple: (model, context, streamOptions) => streamAdapter.streamSimple(model, context, streamOptions),
	});

	const cleanupCurrentSession = async (_event?: object, context?: CursorProviderContext): Promise<void> => {
		const sessionId = context?.sessionManager?.getSessionId?.();
		if (sessionId) await streamAdapter.cleanupSession(sessionId);
	};
	const dispose = async (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposed = true;
		preparation.dispose();
		disposePromise = streamAdapter.dispose();
		return disposePromise;
	};
	const cleanupAndDispose = async (event?: object, context?: CursorProviderContext): Promise<void> => {
		try {
			await cleanupCurrentSession(event, context);
		} finally {
			await dispose();
		}
	};
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"] as const) pi.on(event, cleanupCurrentSession);
	pi.on("session_shutdown", cleanupAndDispose);

	return {
		transport,
		authService,
		discoveryService,
		streamAdapter,
		catalogCache,
		preparation,
		dispose: async () => {
			if (!disposed) await dispose();
			else if (disposePromise) await disposePromise;
		},
	};
}

export default function cursorProviderExtension(pi: CursorProviderHost): void {
	registerCursorProvider(pi);
}
