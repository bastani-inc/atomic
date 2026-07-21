import type { Api } from "@earendil-works/pi-ai/compat";
import type { ProviderConfigInput } from "./model-registry-types.ts";

const REMOTE_CATALOG_PROVIDERS = new Set(["github-copilot", "openrouter", "vercel-ai-gateway"]);
const OPENAI_COMPATIBLE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);

export function canRestoreUnknownProviderModel(input: {
	readonly provider: string;
	readonly customOpenAICompatibleProviders: ReadonlySet<string>;
	readonly builtInProviders: ReadonlySet<string>;
	readonly config: ProviderConfigInput | undefined;
}): boolean {
	if (REMOTE_CATALOG_PROVIDERS.has(input.provider)) return true;
	if (input.customOpenAICompatibleProviders.has(input.provider)) return true;
	if (input.builtInProviders.has(input.provider)) return false;
	return input.config?.models?.some((model) => {
		const api = model.api ?? input.config?.api;
		return api !== undefined && OPENAI_COMPATIBLE_APIS.has(api);
	}) === true;
}
