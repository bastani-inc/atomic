import type { AuthOperationOptions, CredentialStore, ModelsStore } from "@bastani/atomic-ai";

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** True refreshes all catalogs on create; false disables automatic reads. By default, only a needed missing list is fetched. */
	allowModelNetwork?: boolean;
	/** Deadline for network catalog refresh on create or the automatic read of a missing model list. */
	modelRefreshTimeoutMs?: number;
	/** Skip the initial catalog and availability refresh. No missing list is inferred until a restore observes one. */
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
