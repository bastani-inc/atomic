import { type AnyModel, normalizeProviderId } from "@bastani/pi-ai";
import type { Settings } from "./settings-types.js";

export const LEGACY_AZURE_PROVIDER = "azure-openai-responses";

export function normalizeModelProvider<T extends AnyModel>(model: T): T {
	const provider = normalizeProviderId(model.provider);
	return provider === model.provider ? model : { ...model, provider };
}

export function normalizeModelReference(reference: string): string {
	const slash = reference.indexOf("/");
	return slash < 0 ? reference : `${normalizeProviderId(reference.slice(0, slash))}${reference.slice(slash)}`;
}

export function normalizeProviderKeys<T>(entries: Record<string, T>): Record<string, T> {
	const result = { ...entries };
	for (const [key, value] of Object.entries(entries)) {
		const canonical = normalizeModelReference(normalizeProviderId(key));
		if (canonical === key) continue;
		if (!Object.hasOwn(result, canonical)) result[canonical] = value;
		delete result[key];
	}
	return result;
}

export function normalizeAzureSettings(settings: Settings): Settings {
	return {
		...settings,
		...(settings.defaultProvider && { defaultProvider: normalizeProviderId(settings.defaultProvider) }),
		...(settings.routerModel && { routerModel: normalizeModelReference(settings.routerModel) }),
		...(settings.enabledModels && { enabledModels: settings.enabledModels.map(normalizeModelReference) }),
		...(settings.fallbackModels && { fallbackModels: settings.fallbackModels.map(normalizeModelReference) }),
		...(settings.modelThinkingLevels && { modelThinkingLevels: normalizeProviderKeys(settings.modelThinkingLevels) }),
		...(settings.modelRouting && {
			modelRouting: {
				...settings.modelRouting,
				...(settings.modelRouting.allowedProviders && {
					allowedProviders: settings.modelRouting.allowedProviders.map(normalizeProviderId),
				}),
				...(settings.modelRouting.excludedProviders && {
					excludedProviders: settings.modelRouting.excludedProviders.map(normalizeProviderId),
				}),
			},
		}),
		...(settings.compaction?.modelOverrides && {
			compaction: {
				...settings.compaction,
				modelOverrides: normalizeProviderKeys(settings.compaction.modelOverrides),
			},
		}),
	};
}
