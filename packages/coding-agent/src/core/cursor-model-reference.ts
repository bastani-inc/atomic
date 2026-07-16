import type { Api, Model } from "@earendil-works/pi-ai/compat";

const CURSOR_PROVIDER = "cursor";
const CURSOR_PREFIX = `${CURSOR_PROVIDER}/`;

const CURSOR_API = "cursor-agent";

interface CursorRoutingIdentity {
	readonly modelId: string;
	readonly maxMode: boolean;
	readonly supportsImages: boolean;
	readonly catalogOccurrence: number;
}

interface CursorModelCompat {
	readonly cursorRouting?: Readonly<Record<string, CursorRoutingIdentity>>;
}

/** True only for a current GetUsable-derived executable Cursor route. */
export function isAuthenticatedCursorRouteModel(model: Pick<Model<Api>, "provider" | "api" | "id" | "compat">): boolean {
	if (model.provider !== CURSOR_PROVIDER || model.api !== CURSOR_API) return false;
	const compat = model.compat as CursorModelCompat | undefined;
	const routing = compat?.cursorRouting?.[model.id];
	return routing?.modelId === model.id
		&& typeof routing.maxMode === "boolean"
		&& typeof routing.supportsImages === "boolean"
		&& Number.isInteger(routing.catalogOccurrence)
		&& routing.catalogOccurrence >= 0;
}

/** Non-Cursor models remain permissive; exact lowercase Cursor must be live. */
export function isSelectableModel(model: Pick<Model<Api>, "provider" | "api" | "id" | "compat">): boolean {
	return model.provider !== CURSOR_PROVIDER || isAuthenticatedCursorRouteModel(model);
}

export function parseExactCursorProviderReference(reference: string): string | undefined {
	return reference.startsWith(CURSOR_PREFIX) ? reference.slice(CURSOR_PREFIX.length) : undefined;
}

export function hasNormalizedCursorProviderQualifier(reference: string): boolean {
	const slashIndex = reference.indexOf("/");
	return slashIndex >= 0 && isNormalizedCursorProviderVariant(reference.slice(0, slashIndex));
}

export function isExactCursorProvider(provider: string | undefined): boolean {
	return provider === CURSOR_PROVIDER;
}

export function isNormalizedCursorProviderVariant(provider: string): boolean {
	return provider !== CURSOR_PROVIDER && provider.trim().toLowerCase() === CURSOR_PROVIDER;
}

/** Preserve reserved Cursor reference bytes while retaining historical trimming for other providers. */
export function trimNonCursorModelReference(reference: string): string {
	return parseExactCursorProviderReference(reference) !== undefined || hasNormalizedCursorProviderQualifier(reference)
		? reference
		: reference.trim();
}

/**
 * Resolve a provider name without ever canonicalizing a case/whitespace variant
 * into the reserved lowercase Cursor identity. Exact spelling wins; ordinary
 * non-Cursor providers retain the historical case-insensitive fallback.
 */
export function resolveProviderIdentity(
	provider: string,
	availableProviders: readonly string[],
): string | undefined {
	const exact = availableProviders.find((candidate) => candidate === provider);
	if (exact !== undefined) return exact;
	if (isExactCursorProvider(provider)) return undefined;
	const lower = provider.toLowerCase();
	return availableProviders.find(
		(candidate) => !isExactCursorProvider(candidate) && candidate.toLowerCase() === lower,
	);
}
