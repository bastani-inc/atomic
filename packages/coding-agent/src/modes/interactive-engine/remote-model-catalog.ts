import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ProviderApiKeyAuth } from "../../core/extensions/provider-types.ts";
import { providerModelsAreExactlyEqual } from "../../core/provider-model-reference.ts";
import type { RpcClient } from "../rpc/rpc-client.ts";
import { fromRpcModel, fromRpcScopedModels, type RpcModel } from "../rpc/rpc-model.ts";
import type { RpcModelCatalog } from "../rpc/rpc-types.ts";

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
	private customAuthProviders = new Map<string, string>();
	private refreshGeneration = 0;

	constructor(client: RpcClient) {
		this.client = client;
	}

	apply(catalog: RpcModelCatalog): void {
		this.applyModels(catalog);
		this.customAuthProviders = new Map(catalog.customAuthProviders.map(({ id, name }) => [id, name]));
	}

	applyModels(catalog: Pick<RpcModelCatalog, "models" | "scopedModels">): void {
		this.models = catalog.models.map(fromRpcModel);
		this.scopedModels = fromRpcScopedModels(catalog.scopedModels);
	}

	resolve(model: RpcModel): Model<Api> {
		const hydrated = fromRpcModel(model);
		return this.models.find((candidate) => providerModelsAreExactlyEqual(candidate, hydrated)) ?? hydrated;
	}

	patch(session: AgentSession): void {
		const registry = session.modelRegistry;
		const localGetCustomAuth = registry.getCustomApiKeyAuth?.bind(registry) ?? (() => undefined);
		const localGetDisplayName = registry.getProviderDisplayName?.bind(registry) ?? ((provider: string) => provider);
		Object.defineProperties(registry, {
			refresh: { configurable: true, value: (options = {}) => this.refresh(options) },
			getAvailable: { configurable: true, value: () => [...this.models] },
			find: {
				configurable: true,
				value: (provider: string, modelId: string) =>
					this.models.find((model) => model.provider === provider && model.id === modelId),
			},
			hasConfiguredAuth: {
				configurable: true,
				value: (model: Model<Api>) => this.models.some(
					(candidate) => candidate.provider === model.provider && candidate.id === model.id,
				),
			},
			getCustomApiKeyAuthProviders: {
				configurable: true,
				value: () => [...this.customAuthProviders].map(([id, name]) => ({ id, name })),
			},
			getProviderDisplayName: {
				configurable: true,
				value: (provider: string) => this.customAuthProviders.get(provider) ?? localGetDisplayName(provider),
			},
			getCustomApiKeyAuth: {
				configurable: true,
				value: (provider: string): ProviderApiKeyAuth | undefined => {
					const name = this.customAuthProviders.get(provider);
					if (!name) return localGetCustomAuth(provider);
					return {
						name,
						login: async ({ signal }) => {
							const result = await this.client.loginProvider(provider, signal);
							if (result.cancelled) throw new Error("Login cancelled");
							this.apply(result);
							return result.credential;
						},
					};
				},
			},
		});
		Object.defineProperty(session, "scopedModels", {
			configurable: true,
			get: () => this.scopedModels,
		});
	}

	private async refresh(options: RemoteModelRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const generation = ++this.refreshGeneration;
		if (options.signal?.aborted) return { aborted: true, errors: new Map() };
		const remoteRefresh = this.client.refreshModels({
			timeoutMs: options.timeoutMs,
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
