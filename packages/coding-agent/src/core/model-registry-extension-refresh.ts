import type { Credential, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderConfigInput } from "./model-registry-types.ts";

type ProviderModels = NonNullable<ProviderConfigInput["models"]>;

export interface ExtensionRefreshInput {
	config: ProviderConfigInput;
	credential: Credential | undefined;
	store: RefreshModelsContext["store"];
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
	isCurrent(): boolean;
}

export interface ExtensionRefreshResult {
	models?: ProviderModels;
	error?: Error;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Refresh an extension provider, falling back to its validated persisted catalog
 * when an online refresh fails. The online error remains authoritative.
 */
export async function refreshExtensionProvider(input: ExtensionRefreshInput): Promise<ExtensionRefreshResult> {
	const refresh = (allowNetwork: boolean, force: boolean | undefined) => input.config.refreshModels!({
		credential: input.credential,
		store: input.store,
		allowNetwork,
		force,
		signal: input.signal,
	});
	try {
		return { models: await refresh(input.allowNetwork, input.force) };
	} catch (error) {
		const result: ExtensionRefreshResult = { error: toError(error) };
		if (!input.allowNetwork || !input.isCurrent()) return result;
		try {
			result.models = await refresh(false, false);
		} catch {
			// Preserve the original online error; cache recovery is best-effort.
		}
		return result;
	}
}
