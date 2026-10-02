import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { type AuthSelectorProvider, formatAuthSelectorProviderType } from "./components/oauth-selector.ts";

export type LoginProviderOption = {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
	subscription?: boolean;
};

export type LoginProviderResolution =
	| { kind: "direct"; option: AuthSelectorProvider }
	| { kind: "choose_method"; options: AuthSelectorProvider[] }
	| { kind: "search"; initialSearch: string };

const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

export function mergeLoginProviderOptions(providerOptions: readonly AuthSelectorProvider[]): LoginProviderOption[] {
	const byId = new Map<string, LoginProviderOption>();
	for (const provider of providerOptions) {
		const existing = byId.get(provider.id);
		if (existing) {
			if (!existing.authTypes.includes(provider.authType)) {
				existing.authTypes.push(provider.authType);
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			continue;
		}
		byId.set(provider.id, {
			id: provider.id,
			name: provider.name,
			authTypes: [provider.authType],
			...(provider.subscription === undefined ? {} : { subscription: provider.subscription }),
		});
	}
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveLoginProviderReference(
	providerOptions: readonly AuthSelectorProvider[],
	providerRef: string,
): LoginProviderResolution {
	const normalizedRef = providerRef.trim().toLowerCase();
	const matches = providerOptions.filter(
		(provider) => provider.id.toLowerCase() === normalizedRef || provider.name.toLowerCase() === normalizedRef,
	);
	if (matches.length === 1) return { kind: "direct", option: matches[0]! };
	if (matches.length > 1 && new Set(matches.map((match) => match.id)).size === 1) {
		return { kind: "choose_method", options: matches };
	}
	return { kind: "search", initialSearch: providerRef };
}

function authTypeLabel(authType: AuthSelectorProvider["authType"], subscription?: boolean): string {
	const label = formatAuthSelectorProviderType(authType, subscription);
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function searchText(provider: LoginProviderOption): string {
	return `${provider.id} ${provider.name} ${provider.authTypes.map((authType) => authTypeLabel(authType, provider.subscription)).join(" ")}`;
}

function formatDescription(provider: LoginProviderOption): string {
	const authTypes = provider.authTypes.map((authType) => authTypeLabel(authType, provider.subscription)).join("/");
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

export function getLoginProviderCompletions(
	providerOptions: readonly AuthSelectorProvider[],
	prefix: string,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(mergeLoginProviderOptions(providerOptions), prefix, searchText);
	if (filtered.length === 0) return null;
	return filtered.map((provider) => ({
		value: provider.id,
		label: provider.id,
		description: formatDescription(provider),
	}));
}
