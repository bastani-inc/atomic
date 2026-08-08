import type { ModelRuntime } from "./core/model-runtime.ts";

type CliApiKeyRuntime = Pick<ModelRuntime, "setRuntimeApiKey" | "refresh" | "getAvailable">;

/** Apply a CLI-only runtime key without blocking startup on remote catalog I/O. */
export async function applyCliRuntimeApiKey(
	modelRuntime: CliApiKeyRuntime,
	providerId: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<void> {
	const authOptions = { signal };
	await modelRuntime.setRuntimeApiKey(providerId, apiKey, authOptions);
	// setRuntimeApiKey applies the credential without touching the catalog, so this
	// caller asks for freshness explicitly for this provider. Keep startup local-only
	// by retaining allowNetwork: false; the same operation signal governs auth and refresh.
	await modelRuntime.refresh({ providers: [providerId], allowNetwork: false, signal });
	await modelRuntime.getAvailable();
}
