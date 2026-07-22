import type { ModelRegistry } from "./model-registry.ts";
import type { ResourceLoader } from "./resource-loader.ts";

export interface ProviderRegistrationDiagnostic {
	readonly extensionPath: string;
	readonly message: string;
}

/** Register one extension generation, then await its required authoritative providers. */
export async function registerPendingProvidersAndPrepare(
	resourceLoader: ResourceLoader,
	modelRegistry: ModelRegistry,
	allowNetwork: boolean,
): Promise<ProviderRegistrationDiagnostic[]> {
	const extensions = resourceLoader.getExtensions();
	const pending = extensions.runtime.pendingProviderRegistrations;
	const diagnostics: ProviderRegistrationDiagnostic[] = [];
	for (const registration of pending) {
		try {
			if ("provider" in registration) modelRegistry.registerProvider(registration.provider);
			else modelRegistry.registerProvider(registration.name, registration.config);
		} catch (error) {
			diagnostics.push({
				extensionPath: registration.extensionPath,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	extensions.runtime.pendingProviderRegistrations = [];
	await modelRegistry.prepareRequiredProviders({ allowNetwork });
	return diagnostics;
}
