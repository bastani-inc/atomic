import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "../../core/model-refresh-timeout.ts";
import type { RpcClient } from "../rpc/rpc-client.ts";
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
	private oauthProviders: NonNullable<RpcModelCatalog["oauthProviders"]> = [];
	private refreshGeneration = 0;

	constructor(client: RpcClient) {
		this.client = client;
	}

	apply(catalog: RpcModelCatalog): void {
		this.applyModels(catalog);
		if (catalog.oauthProviders) this.oauthProviders = catalog.oauthProviders;
	}

	applyModels(catalog: Pick<RpcModelCatalog, "models" | "scopedModels">): void {
		this.models = catalog.models;
		this.scopedModels = catalog.scopedModels;
	}

	patch(session: AgentSession): void {
		const runtime = session.modelRuntime;
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
			hasConfiguredAuth: {
				configurable: true,
				value: (provider: string) =>
					runtime.getProviderAuthStatus(provider).configured ||
					this.models.some((model) => model.provider === provider),
			},
			getOAuthProviderMetadata: { configurable: true, value: () => [...this.oauthProviders] },
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
