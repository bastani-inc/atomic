import type { AnyModel, AuthResult } from "@bastani/atomic-ai";
import type { ModelConfig } from "./model-config.ts";
import { mergeHeaders } from "./model-runtime-streaming.ts";
import type { ModelRuntimeAuthOverrides } from "./model-runtime-types.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";
import { resolveConfiguredModelHeadersAsync } from "./provider-composer.ts";

/** Apply models.json and extension headers after pi-ai resolves provider credentials. */
export async function mergeConfiguredAuthHeaders(
	resolution: AuthResult,
	model: AnyModel,
	config: ModelConfig,
	extension: ProviderConfigInput | undefined,
	overrides: ModelRuntimeAuthOverrides,
): Promise<AuthResult> {
	const configuredHeaders = await resolveConfiguredModelHeadersAsync(
		model,
		config.getProvider(model.provider),
		extension,
		{
			...(resolution.env ?? {}),
			...(overrides.env ?? {}),
		},
	);
	return {
		...resolution,
		auth: {
			...resolution.auth,
			headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
		},
	};
}
