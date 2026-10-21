import { type ModelsRefreshResult, normalizeProviderId } from "@bastani/pi-ai";
import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentSession } from "../../core/agent-session.js";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "../../core/model-refresh-timeout.ts";
import type { ModelRuntime } from "../../core/model-runtime.js";
import type { AuthStatus } from "../../core/provider-composer.ts";
import type { RpcClient } from "../rpc/rpc-client.ts";
import type { RpcModelCatalog } from "../rpc/rpc-types.ts";

/** The host runtime's own auth answers, captured before the first patch replaces them. */
const localRuntimeAuth = new WeakMap<
	ModelRuntime,
	Pick<ModelRuntime, "getProviderAuthStatus" | "getApiKeyLoginProviderMetadata">
>();

interface RemoteModelRefreshOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	force?: boolean;
	allowNetwork?: boolean;
}

export class RemoteModelCatalog {
	private readonly client: RpcClient;
	private models: Model<Api>[] = [];
	private scopedModels: Array<{ model: Model<Api>; thinkingLevel?: AgentSession["thinkingLevel"] }> = [];
	private oauthProviders: NonNullable<RpcModelCatalog["oauthProviders"]> = [];
	/** Extension providers live only in the engine; the host learns their API-key login and auth status from it. */
	private apiKeyLoginProviders: RpcModelCatalog["customAuthProviders"] = [];
	private readonly providerAuthStatuses = new Map<string, AuthStatus>();
	private refreshGeneration = 0;

	constructor(client: RpcClient) {
		this.client = client;
	}

	apply(catalog: RpcModelCatalog): void {
		this.applyModels(catalog);
		if (catalog.oauthProviders) this.oauthProviders = catalog.oauthProviders;
		if (catalog.customAuthProviders) this.apiKeyLoginProviders = catalog.customAuthProviders;
		if (catalog.providerAuthStatuses) {
			this.providerAuthStatuses.clear();
			for (const { provider, status } of catalog.providerAuthStatuses)
				this.applyProviderAuthStatus(provider, status);
		}
	}

	applyModels(catalog: Pick<RpcModelCatalog, "models" | "scopedModels">): void {
		this.models = catalog.models;
		this.scopedModels = catalog.scopedModels;
	}

	/** Record the engine's authoritative status for one provider, e.g. after a logout. */
	applyProviderAuthStatus(provider: string, status: AuthStatus): void {
		provider = normalizeProviderId(provider);
		// The host reads stored credentials from the shared store itself.
		if (status.source === "stored") this.providerAuthStatuses.delete(provider);
		else this.providerAuthStatuses.set(provider, status);
	}

	/** Whether only the engine can run this provider's API-key login. */
	hasEngineApiKeyLogin(provider: string): boolean {
		provider = normalizeProviderId(provider);
		return this.apiKeyLoginProviders.some((entry) => entry.id === provider);
	}

	patch(session: AgentSession): void {
		const runtime = session.modelRuntime;
		// Every engine (re)initialization patches again; keep wrapping the runtime's own methods.
		let local = localRuntimeAuth.get(runtime);
		if (!local) {
			local = {
				getProviderAuthStatus: runtime.getProviderAuthStatus.bind(runtime),
				getApiKeyLoginProviderMetadata: runtime.getApiKeyLoginProviderMetadata.bind(runtime),
			};
			localRuntimeAuth.set(runtime, local);
		}
		const { getProviderAuthStatus: localAuthStatus, getApiKeyLoginProviderMetadata: localApiKeyLoginProviders } =
			local;
		Object.defineProperties(runtime, {
			refresh: { configurable: true, value: (options = {}) => this.refresh(options) },
			getAvailableSnapshot: { configurable: true, value: () => [...this.models] },
			getModels: {
				configurable: true,
				value: (provider?: string) =>
					provider ? this.models.filter((model) => model.provider === provider) : [...this.models],
			},
			getModel: {
				configurable: true,
				value: (provider: string, modelId: string) =>
					this.models.find((model) => model.provider === provider && model.id === modelId),
			},
			getProviderAuthStatus: {
				configurable: true,
				value: (provider: string): AuthStatus => {
					const local = localAuthStatus(provider);
					if (local.source === "stored" || local.source === "runtime") return local;
					return this.providerAuthStatuses.get(normalizeProviderId(provider)) ?? local;
				},
			},
			hasConfiguredAuth: {
				configurable: true,
				value: (provider: string) =>
					runtime.getProviderAuthStatus(provider).configured ||
					this.models.some((model) => model.provider === provider),
			},
			getOAuthProviderMetadata: { configurable: true, value: () => [...this.oauthProviders] },
			getApiKeyLoginProviderMetadata: {
				configurable: true,
				value: () => {
					const local = localApiKeyLoginProviders();
					const localIds = new Set(local.map((provider) => provider.id));
					return [...local, ...this.apiKeyLoginProviders.filter((provider) => !localIds.has(provider.id))];
				},
			},
		});
		Object.defineProperty(session, "scopedModels", { configurable: true, get: () => this.scopedModels });
	}

	private async refresh(options: RemoteModelRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const generation = ++this.refreshGeneration;
		if (options.signal?.aborted) return { aborted: true, errors: new Map() };
		const remoteRefresh = this.client.refreshModels({
			// AbortSignal cannot cross the RPC boundary. Give the engine the same
			// deadline so an abandoned frontend refresh cannot occupy its command
			// scheduler after the selector has already returned to cached models.
			timeoutMs: options.timeoutMs ?? (options.signal ? INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS : undefined),
			force: options.force,
			allowNetwork: options.allowNetwork,
		});
		const result = await this.waitForRefresh(remoteRefresh, options.signal);
		if (!result || options.signal?.aborted) return { aborted: true, errors: new Map() };
		if (generation === this.refreshGeneration) this.apply(result);
		return {
			aborted: result.aborted,
			errors: new Map(result.errors.map(({ provider, message }) => [provider, new Error(message)])),
		};
	}

	private async waitForRefresh(
		remoteRefresh: ReturnType<RpcClient["refreshModels"]>,
		signal: AbortSignal | undefined,
	): Promise<Awaited<typeof remoteRefresh> | undefined> {
		if (!signal) return remoteRefresh;
		let abort: (() => void) | undefined;
		const aborted = new Promise<undefined>((resolve) => {
			abort = () => resolve(undefined);
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([remoteRefresh, aborted]);
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
		}
	}
}
