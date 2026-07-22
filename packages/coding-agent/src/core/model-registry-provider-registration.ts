import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import {
	mergeProviderConfig,
	migrateLegacyRegisterProviderConfigValues,
	unregisterProviderRuntime,
	validateProviderConfig,
} from "./model-registry-dynamic.ts";
import type { ProviderConfigInput } from "./model-registry-types.ts";
import type { RequiredProviderPreparationState } from "./provider-preparation-state.ts";

export interface ModelProviderRegistrationHost {
	readonly registeredProviders: Map<string, ProviderConfigInput>;
	readonly nativeProviders: Map<string, Provider>;
	readonly providerInstanceGenerations: Map<string, number>;
	readonly requiredPreparation: RequiredProviderPreparationState;
	readonly providerModels: MutableModels;
	readonly defaultProviders: Map<string, Provider>;
	providerRegistrationSource(providerName: string): string;
	rebuildProviderModels(): void;
	applyProviderConfig(providerName: string, config: ProviderConfigInput, registerRuntime: boolean): void;
}

function invalidateProvider(host: ModelProviderRegistrationHost, providerName: string): void {
	host.providerInstanceGenerations.set(providerName, (host.providerInstanceGenerations.get(providerName) ?? 0) + 1);
	host.requiredPreparation.invalidate(providerName);
}

export function registerModelProvider(
	host: ModelProviderRegistrationHost,
	providerOrName: Provider | string,
	config?: ProviderConfigInput,
): void {
	if (typeof providerOrName !== "string") {
		if (!providerOrName.id.trim()) throw new Error("Provider id must not be empty.");
		const providerName = providerOrName.id;
		const hadLegacy = host.registeredProviders.delete(providerName);
		invalidateProvider(host, providerName);
		if (hadLegacy) unregisterProviderRuntime(host.providerRegistrationSource(providerName));
		host.nativeProviders.set(providerName, providerOrName);
		host.providerModels.setProvider(providerOrName);
		host.rebuildProviderModels();
		return;
	}
	if (!config) throw new Error("Provider config is required");
	const migratedConfig = migrateLegacyRegisterProviderConfigValues(providerOrName, config);
	validateProviderConfig(providerOrName, migratedConfig);
	const mergedConfig = mergeProviderConfig(host.registeredProviders.get(providerOrName), migratedConfig);
	const hadNative = host.nativeProviders.delete(providerOrName);
	if (hadNative) {
		const fallback = host.defaultProviders.get(providerOrName);
		if (fallback) host.providerModels.setProvider(fallback);
		else host.providerModels.deleteProvider(providerOrName);
	}
	invalidateProvider(host, providerOrName);
	host.registeredProviders.set(providerOrName, mergedConfig);
	unregisterProviderRuntime(host.providerRegistrationSource(providerOrName));
	host.rebuildProviderModels();
	host.applyProviderConfig(providerOrName, mergedConfig, true);
}

export function unregisterModelProvider(host: ModelProviderRegistrationHost, providerName: string): void {
	const hadLegacy = host.registeredProviders.delete(providerName);
	const hadNative = host.nativeProviders.delete(providerName);
	if (!hadLegacy && !hadNative) return;
	invalidateProvider(host, providerName);
	unregisterProviderRuntime(host.providerRegistrationSource(providerName));
	const fallback = host.defaultProviders.get(providerName);
	if (fallback) host.providerModels.setProvider(fallback);
	else host.providerModels.deleteProvider(providerName);
	host.rebuildProviderModels();
}
