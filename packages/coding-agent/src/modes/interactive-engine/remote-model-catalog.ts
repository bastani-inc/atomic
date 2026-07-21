import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
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
	private refreshGeneration = 0;

	constructor(client: RpcClient) {
		this.client = client;
	}

	apply(catalog: RpcModelCatalog): void {
		this.models = catalog.models;
		this.scopedModels = catalog.scopedModels;
	}

	patch(session: AgentSession): void {
		const registry = session.modelRegistry;
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
