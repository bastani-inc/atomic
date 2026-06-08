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
