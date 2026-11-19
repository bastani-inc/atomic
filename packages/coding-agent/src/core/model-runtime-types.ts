import type { AuthOperationOptions, CredentialStore, ModelsStore } from "@bastani/atomic-ai";

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/**
	 * Model network use. `true`: create() refreshes every model catalog over the network. `false`: the runtime never
	 * fetches a model catalog by itself. Omitted: a configured provider whose model list depends on the account
	 * (GitHub Copilot, OpenRouter) and has never been cached gets its list read once, before models are resolved or
	 * listed, and cached as a normal refresh caches it. Offline mode turns all of it off.
	 */
	allowModelNetwork?: boolean;
	/** Deadline for create()'s network model refresh, and for reading a missing model list. Defaults to 15 seconds. */
	modelRefreshTimeoutMs?: number;
	/** Stops create() waiting for model lists from the network; it then resolves with the cached catalogs. */
	signal?: AbortSignal;
	/** Skip the initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
	/** Base URL of the models.dev catalog (`<url>/api.json`) refreshes read. Default: `ATOMIC_MODEL_CATALOG_URL`, else https://models.dev. */
	catalogBaseUrl?: string;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}
