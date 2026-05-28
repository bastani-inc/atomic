import { createHash } from "node:crypto";
import type { ExtensionAPI, ProviderConfig } from "@bastani/atomic";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { loginCursor, refreshCursorToken, type CursorCredentials } from "./auth.ts";
import { createCursorBridge, type CursorBridge } from "./cursor-bridge.ts";
import { createCursorDebugLogger } from "./debug.ts";
import { discoverCursorModels, type CursorModel, type DiscoverCursorModelsResult } from "./models.ts";
import { toProviderModels } from "./model-mapping.ts";
import { startCursorProxy, type CursorProxyBridge, type CursorProxyHandle } from "./proxy.ts";

export interface CursorProviderExtensionOptions {
	bridge?: CursorBridge | CursorProxyBridge;
	startProxy?: (
		bridge: CursorProxyBridge,
		accessToken: () => string | undefined,
		proxySecret: () => string,
		models: () => CursorModel[],
	) => Promise<CursorProxyHandle>;
	discoverModels?: (accessToken: string, bridge: CursorBridge | CursorProxyBridge, fallbackModels: CursorModel[]) => Promise<DiscoverCursorModelsResult>;
	login?: (callbacks: OAuthLoginCallbacks) => Promise<CursorCredentials>;
	refresh?: (credentials: OAuthCredentials) => Promise<CursorCredentials>;
	debug?: (event: string, details?: unknown) => void;
}

interface CursorRegisteredModelState {
	tokenFingerprint?: string;
	models: CursorModel[];
}

interface CursorAuthStorage {
	get(provider: string): unknown;
	getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined>;
}

interface CursorHydrationContext {
	modelRegistry?: { authStorage?: CursorAuthStorage };
}

function createAuthOnlyProviderConfig(oauth: ProviderConfig["oauth"]): ProviderConfig {
	return {
		name: "Cursor",
		oauth,
	};
}

function createProviderConfig(baseUrl: string, models: CursorModel[], oauth: ProviderConfig["oauth"]): ProviderConfig {
	return {
		name: "Cursor",
		baseUrl,
		api: "openai-completions",
		authHeader: false,
		models: toProviderModels(models),
		oauth,
	};
}

function asObjectPayload(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasModelDiscoveryBridge(bridge: CursorBridge | CursorProxyBridge): bridge is CursorBridge {
	return "getUsableModels" in bridge && typeof bridge.getUsableModels === "function";
}

function hasSessionStateBridge(bridge: CursorBridge | CursorProxyBridge): bridge is CursorBridge & { clearSession(sessionId: string): void } {
	return "clearSession" in bridge && typeof bridge.clearSession === "function";
}

function isCursorOAuthCredential(value: unknown): value is CursorCredentials & { type?: string } {
	const record = asObjectPayload(value);
	return record?.type === "oauth" && typeof record.access === "string" && typeof record.refresh === "string" && typeof record.expires === "number";
}

function tokenFingerprint(accessToken: string): string {
	return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function defaultStartProxy(
	bridge: CursorProxyBridge,
	accessToken: () => string | undefined,
	proxySecret: () => string,
	models: () => CursorModel[],
): Promise<CursorProxyHandle> {
	return startCursorProxy({ bridge, accessToken, proxySecret, models });
}

function defaultDiscoverModels(
	accessToken: string,
	bridge: CursorBridge | CursorProxyBridge,
	fallbackModels: CursorModel[],
): Promise<DiscoverCursorModelsResult> {
	return discoverCursorModels(accessToken, {
		bridge: hasModelDiscoveryBridge(bridge) ? bridge : undefined,
		fallbackModels,
	});
}

export function createCursorProviderExtension(options: CursorProviderExtensionOptions = {}) {
	return async function registerCursorProvider(pi: ExtensionAPI): Promise<void> {
		const debug = options.debug ?? createCursorDebugLogger();
		let currentAccessToken: string | undefined;
		let registeredModelState: CursorRegisteredModelState = { models: [] };
		const proxySecret = crypto.randomUUID();
		const bridge = options.bridge ?? createCursorBridge({ debug });
		let hydrationInFlight: Promise<void> | undefined;
		let lastHydratedTokenFingerprint: string | undefined;
		const startProxy = options.startProxy ?? defaultStartProxy;
		const proxy = await startProxy(
			bridge,
			() => currentAccessToken,
			() => proxySecret,
			() => registeredModelState.models,
		);

		const oauth: NonNullable<ProviderConfig["oauth"]> = {
			name: "Cursor",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				return applyCredentials(await (options.login ?? loginCursor)(callbacks));
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return applyCredentials(await (options.refresh ?? refreshCursorToken)(credentials));
			},
			getApiKey(credentials: OAuthCredentials): string {
				currentAccessToken = credentials.access;
				return proxySecret;
			},
		};

		const registerAuthOnlyProvider = () => {
			pi.registerProvider("cursor", createAuthOnlyProviderConfig(oauth));
			debug("registered-auth-only");
		};

		const registerProviderWithModels = (models: CursorModel[], fingerprint: string) => {
			registeredModelState = { tokenFingerprint: fingerprint, models };
			pi.registerProvider("cursor", createProviderConfig(proxy.baseUrl, models, oauth));
			debug("registered", { baseUrl: proxy.baseUrl, tokenFingerprint: fingerprint, modelCount: models.length, models: models.map((model) => model.id) });
		};

		const clearRegisteredModels = (fingerprint: string, warning?: string) => {
			registeredModelState = { models: [] };
			pi.unregisterProvider("cursor");
			registerAuthOnlyProvider();
			debug("registered-models-cleared", { tokenFingerprint: fingerprint, warning });
		};

		const refreshDiscoveredModels = async (accessToken: string) => {
			const fingerprint = tokenFingerprint(accessToken);
			const previousState = registeredModelState;
			const sameToken = previousState.tokenFingerprint === fingerprint;
			const fallbackModels = sameToken ? previousState.models : [];
			const discover = options.discoverModels ?? defaultDiscoverModels;
			const result = await discover(accessToken, bridge, fallbackModels);
			if (result.warning) debug("model-discovery-warning", { warning: result.warning, source: result.source, tokenFingerprint: fingerprint, fallbackModelCount: fallbackModels.length });
			if (result.models.length > 0) {
				registerProviderWithModels(result.models, fingerprint);
				return;
			}
			if (sameToken && previousState.models.length > 0) {
				debug("registered-models-retained", { tokenFingerprint: fingerprint, warning: result.warning });
				return;
			}
			clearRegisteredModels(fingerprint, result.warning);
		};

		const isTokenFingerprintAlreadyApplied = (fingerprint: string): boolean => {
			return fingerprint === lastHydratedTokenFingerprint && registeredModelState.tokenFingerprint === fingerprint;
		};

		const applyCredentials = async (credentials: CursorCredentials): Promise<CursorCredentials> => {
			currentAccessToken = credentials.access;
			await refreshDiscoveredModels(credentials.access);
			lastHydratedTokenFingerprint = tokenFingerprint(credentials.access);
			return credentials;
		};

		const applyCredentialsIfNeeded = async (credentials: CursorCredentials): Promise<CursorCredentials> => {
			const fingerprint = tokenFingerprint(credentials.access);
			if (isTokenFingerprintAlreadyApplied(fingerprint)) {
				debug("startup-hydration-skip", { reason: "already-applied", tokenFingerprint: fingerprint });
				return credentials;
			}
			return applyCredentials(credentials);
		};

		const applyAccessTokenIfNeeded = async (accessToken: string): Promise<void> => {
			const fingerprint = tokenFingerprint(accessToken);
			if (isTokenFingerprintAlreadyApplied(fingerprint)) {
				debug("startup-hydration-skip", { reason: "already-applied", tokenFingerprint: fingerprint });
				return;
			}
			await refreshDiscoveredModels(accessToken);
			lastHydratedTokenFingerprint = fingerprint;
		};

		const hydrateStoredCredentials = async (ctx: unknown): Promise<void> => {
			if (hydrationInFlight) {
				debug("startup-hydration-skip", { reason: "in-flight" });
				return hydrationInFlight;
			}
			const authStorage = (ctx as CursorHydrationContext).modelRegistry?.authStorage;
			if (!authStorage) {
				debug("startup-hydration-skip", { reason: "missing-credentials" });
				return;
			}
			const credentials = authStorage.get("cursor");
			if (!isCursorOAuthCredential(credentials)) {
				debug("startup-hydration-skip", { reason: "missing-credentials" });
				return;
			}
			const fingerprint = tokenFingerprint(credentials.access);
			const expired = Date.now() >= credentials.expires;
			if (!expired && fingerprint === lastHydratedTokenFingerprint) {
				debug("startup-hydration-skip", { reason: "already-hydrated", tokenFingerprint: fingerprint });
				return;
			}
			hydrationInFlight = (async () => {
				debug("startup-hydration-start", { expired, tokenFingerprint: fingerprint });
				try {
					if (expired) {
						await authStorage.getApiKey("cursor", { includeFallback: false });
						const refreshedCredentials = authStorage.get("cursor");
						if (isCursorOAuthCredential(refreshedCredentials) && Date.now() < refreshedCredentials.expires) {
							await applyCredentialsIfNeeded(refreshedCredentials);
						} else if (currentAccessToken) {
							await applyAccessTokenIfNeeded(currentAccessToken);
						}
					} else {
						await applyCredentialsIfNeeded(credentials);
					}
					debug("startup-hydration-complete", { tokenFingerprint: registeredModelState.tokenFingerprint ?? (currentAccessToken ? tokenFingerprint(currentAccessToken) : fingerprint), modelCount: registeredModelState.models.length });
				} catch (error) {
					debug("startup-hydration-warning", { warning: error instanceof Error ? error.message : String(error), tokenFingerprint: fingerprint });
				}
			})();
			try {
				await hydrationInFlight;
			} finally {
				hydrationInFlight = undefined;
			}
		};

		registerAuthOnlyProvider();

		pi.on("session_start", (_event, ctx) => hydrateStoredCredentials(ctx));

		pi.on("before_provider_request", (event, ctx) => {
			if (event.provider !== "cursor") return undefined;
			const payload = asObjectPayload(event.payload);
			if (!payload || payload.pi_session_id) return undefined;
			return { ...payload, pi_session_id: ctx.sessionManager.getSessionId() };
		});

		const logSessionBoundary = () => debug("session-state-cleared");
		pi.on("session_before_switch", logSessionBoundary);
		pi.on("session_before_fork", logSessionBoundary);
		pi.on("session_before_tree", () => debug("session-tree-boundary-pending"));
		pi.on("session_tree", (_event, ctx) => {
			if (!hasSessionStateBridge(bridge)) return;
			bridge.clearSession(ctx.sessionManager.getSessionId());
			debug("session-state-cleared", { reason: "tree" });
		});
		pi.on("session_shutdown", () => {
			logSessionBoundary();
			proxy.close();
			if ("close" in bridge && typeof bridge.close === "function") void bridge.close();
		});
	};
}

export default createCursorProviderExtension();
