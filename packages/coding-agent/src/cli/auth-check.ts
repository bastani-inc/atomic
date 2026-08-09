import { type AuthResult, type CredentialStore, ModelsError } from "@earendil-works/pi-ai";
import { findExactModelReferenceMatch, resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, validateAuthCheckArgs } from "./auth-command.ts";
import { DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS, Secret } from "./credential-print.ts";

export type AuthCheckStatus = "ready" | "not_ready" | "invalid";
export type AuthCheckReason =
	| "provider_not_found"
	| "credentials_not_configured"
	| "credential_expired"
	| "credential_not_available"
	| "invalid_state";

export type AuthCheckResult =
	| { status: "ready"; provider: string; authType: "api_key" | "oauth" }
	| { status: "not_ready"; provider: string; reason: AuthCheckReason }
	| { status: "invalid"; provider?: string; reason: "invalid_state" };

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

/**
 * A credential export must name one target, not accept the CLI resolver's fuzzy
 * cross-provider match. Provider flags are explicit; a model-only export is
 * explicit only when its exact reference resolves uniquely to the provider.
 */
export function hasExplicitCredentialExportTarget(args: Args, modelRuntime: ModelRuntime, provider: string): boolean {
	const { provider: cliProvider, model: cliModel } = validateAuthCheckArgs(args);
	if (cliProvider) return true;
	if (!cliModel) return false;
	const exactModel = findExactModelReferenceMatch(cliModel, [...modelRuntime.getModels()]);
	return exactModel?.provider.toLowerCase() === provider.toLowerCase();
}

function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}

/** Resolve the credential that the checked provider would use, without exposing it to callers. */
export async function getProviderCredential(
	providerId: string,
	modelRuntime: ModelRuntime,
	credentials: CredentialStore,
	options: { refresh: boolean },
): Promise<Secret | undefined> {
	if (!options.refresh) {
		const stored = await credentials.read(providerId);
		if (stored?.type === "oauth") {
			return stored.expires - Date.now() >= DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS
				? new Secret(stored.access)
				: undefined;
		}
	}
	const credential = getAuthCredential(
		await modelRuntime.getAuth(providerId, { minOAuthValidityMs: DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS }),
	);
	return credential === undefined ? undefined : new Secret(credential);
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
