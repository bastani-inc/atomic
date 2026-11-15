/** Providers Atomic once shipped and has removed, with the reason shown when a setting still names one. */
const REMOVED_PROVIDERS: Readonly<Record<string, string>> = {
	radius: "the Radius gateway was operated by pi.dev, and Atomic does not contact pi's services",
};

/** The error for a setting that names a removed provider, or undefined when `providerId` is not one. */
export function removedProviderMessage(providerId: string, setting: string): string | undefined {
	const reason = REMOVED_PROVIDERS[providerId.toLowerCase()];
	if (!reason) return undefined;
	return `Provider "${providerId}" was removed from Atomic: ${reason}. Remove it from ${setting} and choose another provider with /model or /login.`;
}

/** The provider part of a `provider/model` reference, or undefined without one. */
export function providerOfModelReference(reference: string): string | undefined {
	const slash = reference.indexOf("/");
	return slash > 0 ? reference.slice(0, slash) : undefined;
}
