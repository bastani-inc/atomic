/** Match provider IDs and display names exactly, ignoring case and surrounding whitespace in the reference. */
export function findMatchingProviders<T extends { id: string; name: string }>(
	providers: readonly T[],
	providerRef: string,
): T[] {
	const normalized = providerRef.trim().toLowerCase();
	if (!normalized) return [];
	return providers.filter(
		(provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
	);
}

/** The provider a reference names, the sorted IDs of the providers it could mean, or none. */
export type ProviderReferenceResolution<T> =
	| { type: "match"; provider: T }
	| { type: "ambiguous"; providerIds: string[] }
	| { type: "none" };

/**
 * Resolve a reference for a command that acts on one provider; `providers` have distinct IDs. A reference equal to a
 * provider ID selects that provider. Otherwise it must match exactly one provider as {@link findMatchingProviders}
 * does, so a display name that several providers share is ambiguous instead of selecting whichever comes first.
 */
export function resolveProviderReference<T extends { id: string; name: string }>(
	providers: readonly T[],
	providerRef: string,
): ProviderReferenceResolution<T> {
	const trimmed = providerRef.trim();
	if (!trimmed) return { type: "none" };
	const exact = providers.find((provider) => provider.id === trimmed);
	if (exact) return { type: "match", provider: exact };
	const matches = findMatchingProviders(providers, trimmed);
	if (matches.length > 1) return { type: "ambiguous", providerIds: matches.map((provider) => provider.id).sort() };
	return matches[0] ? { type: "match", provider: matches[0] } : { type: "none" };
}
