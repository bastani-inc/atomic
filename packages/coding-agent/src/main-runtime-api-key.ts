import type { ModelRuntime } from "./core/model-runtime.ts";

type CliApiKeyRuntime = Pick<ModelRuntime, "setRuntimeApiKey" | "getAvailable">;

/** Apply a CLI-only runtime key without blocking startup on remote catalog I/O. */
export async function applyCliRuntimeApiKey(
	modelRuntime: CliApiKeyRuntime,
	providerId: string,
	apiKey: string,
): Promise<void> {
	await modelRuntime.setRuntimeApiKey(providerId, apiKey, { allowNetwork: false });
	await modelRuntime.getAvailable();
}
