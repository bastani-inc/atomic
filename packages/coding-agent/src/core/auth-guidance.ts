import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string | undefined): string {
	const providerDisplay =
		provider === undefined || provider.length === 0 || provider === UNKNOWN_PROVIDER
			? "the selected model"
			: provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

/**
 * Message for the case where a provider only appears unauthenticated because the
 * credential store could NOT be loaded — e.g. `auth.json` was temporarily locked
 * by a concurrent process (ELOCKED) or held invalid JSON. This is distinct from
 * genuinely missing credentials: the stored credentials may well exist on disk
 * but could not be read, so an empty in-memory credential set is not
 * authoritative. Phrased to mention "API key"/"auth" so message-based failure
 * classifiers (such as the workflows model-fallback runtime) still treat it as a
 * recoverable/retryable auth failure, while making clear it is a load failure
 * rather than an absent key (issue #1431).
 */
export function formatAuthStorageLoadFailedMessage(provider: string | undefined, error: unknown): string {
	const providerDisplay =
		provider === undefined || provider.length === 0 || provider === UNKNOWN_PROVIDER
			? "the selected model"
			: provider;
	const loginHint =
		provider === undefined || provider.length === 0 || provider === UNKNOWN_PROVIDER
			? ""
			: ` or run '/login ${provider}' to re-authenticate`;
	const detail =
		error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : String(error);
	return (
		`Could not load stored credentials for ${providerDisplay}: the auth credential store ` +
		`could not be read (${detail}). This is not a missing API key — stored credentials may ` +
		`exist but the credential store could not be read (it may be temporarily locked by ` +
		`another process). Retry shortly${loginHint}.\n\n${getProviderLoginHelp()}`
	);
}

function modelLabelForMessage(model: unknown): string {
	if (typeof model === "string" && model.trim().length > 0) return `"${model}"`;
	if (model !== null && typeof model === "object") {
		const id = (model as { id?: unknown }).id;
		if (typeof id === "string" && id.length > 0) return `"${id}"`;
	}
	return "the selected model";
}

/**
 * Message for a model that did not resolve to a real provider — e.g. an
 * unknown/unresolved model id that reached the prompt path as a bare string
 * (its `provider` is `undefined`). Surfaced instead of the misleading
 * "No API key found for undefined", and phrased with "unknown model" so callers
 * that classify failures by message (such as the workflows runtime) treat it as
 * a model-configuration error rather than a missing API key.
 */
export function formatUnresolvedModelMessage(model: unknown): string {
	return (
		`Unknown model: ${modelLabelForMessage(model)} did not resolve to an available provider.\n\n` +
		`${getProviderLoginHelp()}\n\n` +
		"Then use /model to select an available model."
	);
}
