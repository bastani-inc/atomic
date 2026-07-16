import type { ModelRegistry, ProviderConfigInput } from "../src/core/model-registry.ts";
import type { Extension } from "../src/core/extensions/types.ts";
import { trustedCursorProviderSource as source } from "./trusted-cursor-provider-source.ts";

export function registerTrustedCursorProvider(registry: ModelRegistry, config: ProviderConfigInput): void {
	registry.registerProvider("cursor", config, source);
}

export function trustedCursorProviderSource(): Extension {
	return source;
}
