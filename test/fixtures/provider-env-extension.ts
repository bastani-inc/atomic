import type { ExtensionAPI } from "@bastani/atomic";
import { getProviderEnvValue } from "@bastani/atomic-ai/utils/provider-env";

export default function providerEnvExtension(atomic: ExtensionAPI): void {
	atomic.registerFlag("provider-env-process", {
		description: "Read provider environment from the compiled host process",
		type: "string",
		default: getProviderEnvValue("ATOMIC_PROVIDER_ENV_PROBE"),
	});
	atomic.registerFlag("provider-env-scoped", {
		description: "Prefer a scoped provider environment override",
		type: "string",
		default: getProviderEnvValue("ATOMIC_PROVIDER_ENV_PROBE", { ATOMIC_PROVIDER_ENV_PROBE: "scoped-value" }),
	});
}
