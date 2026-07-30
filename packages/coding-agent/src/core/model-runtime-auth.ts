import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelConfig } from "./model-config.ts";
import { mergeHeaders } from "./model-runtime-streaming.ts";
import type { ModelRuntimeAuthOverrides } from "./model-runtime-types.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";
import { resolveConfiguredModelHeaders } from "./provider-composer.ts";

/** Apply models.json and extension headers after pi-ai resolves provider credentials. */
export function mergeConfiguredAuthHeaders(
	resolution: AuthResult,
	model: Model<Api>,
	config: ModelConfig,
	extension: ProviderConfigInput | undefined,
	overrides: ModelRuntimeAuthOverrides,
): AuthResult {
	const configuredHeaders = resolveConfiguredModelHeaders(model, config.getProvider(model.provider), extension, {
		...(resolution.env ?? {}),
		...(overrides.env ?? {}),
	});
	return {
		...resolution,
		auth: {
			...resolution.auth,
			headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
		},
	};
}
