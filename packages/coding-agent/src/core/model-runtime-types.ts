import type { AuthOperationOptions, CredentialStore, ModelsStore } from "@bastani/atomic-ai";

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
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
