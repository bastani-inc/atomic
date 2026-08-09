import { type CredentialStore, ModelsError } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, validateAuthCheckArgs } from "./auth-command.ts";

export type AuthCheckStatus = "ready" | "not_ready" | "invalid";
export type AuthCheckReason =
	| "provider_not_found"
	| "credentials_not_configured"
	| "credential_expired"
	| "credential_not_available"
	| "invalid_state";

export interface AuthCheckResult {
	status: AuthCheckStatus;
	provider: string;
	reason?: AuthCheckReason;
	authType?: "api_key" | "oauth";
}

async function storedOAuthIsExpired(providerId: string, credentials: CredentialStore | undefined): Promise<boolean> {
	const credential = await credentials?.read(providerId);
	return credential?.type === "oauth" && Date.now() >= credential.expires;
}

export async function checkProviderAuth(
	args: Args,
	modelRuntime: ModelRuntime,
	options: { refresh: boolean; credentials?: CredentialStore } = { refresh: false },
): Promise<AuthCheckResult> {
	const { provider: cliProvider, model: cliModel } = validateAuthCheckArgs(args);
	let provider = cliProvider;
	if (cliModel) {
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new AuthCommandError(resolved.error ?? `Unable to resolve model "${cliModel}"`);
		}
		provider = resolved.model.provider;
	}
	if (!provider) throw new AuthCommandError("Unable to resolve an auth provider");
	if (modelRuntime.getError()) {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
	if (!modelRuntime.getProvider(provider)) {
		return { status: "not_ready", provider, reason: "provider_not_found" };
	}
	try {
		const auth = await modelRuntime.checkAuth(provider);
		if (!auth) return { status: "not_ready", provider, reason: "credentials_not_configured" };
		if (options.refresh) {
			if (!(await modelRuntime.getAuth(provider))) {
				return { status: "not_ready", provider, reason: "credentials_not_configured" };
			}
		} else if (auth.type === "oauth" && (await storedOAuthIsExpired(provider, options.credentials))) {
			// checkAuth reports an OAuth credential's kind without considering its
			// expiry. A no-refresh probe cannot rescue an expired token, so report
			// it as not ready instead of claiming the next request would work.
			return { status: "not_ready", provider, reason: "credential_expired" };
		}
		return { status: "ready", provider, authType: auth.type };
	} catch (error) {
		if (error instanceof ModelsError && error.code === "oauth") {
			return { status: "not_ready", provider, reason: "credential_not_available" };
		}
		return { status: "invalid", provider, reason: "invalid_state" };
	}
}

export async function createAuthCheckModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	// The create-time refresh is intentionally skipped, so the snapshot has not
	// yet learned which stored providers are configured. Publish that metadata
	// without a catalog refresh, provider probe, network call, or auth.json write:
	// resolveCliModel needs it to choose a provider for an unqualified model ID.
	await runtime.reloadCredentials({ refreshAvailability: false });
	return runtime;
}
