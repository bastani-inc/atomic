export interface ProviderModelReference<TData extends object = object> {
	readonly provider: string;
	readonly schemaVersion: number;
	readonly data: TData;
	/** Plain, JSON-safe, versioned record persisted by host settings/sessions. */
	readonly selection?: object;
	/** Provider-owned strict parser/matcher for a persisted record. */
	readonly matchesSelection?: (value: unknown) => boolean;
}

export type ProviderModelSelectionErrorCode = "AmbiguousSelection" | "UnsupportedSelection" | "MissingSelection" | "MismatchedSelection" | "AuthenticationMissing" | "PersistenceUnavailable";

export class ProviderModelSelectionError extends Error {
	readonly code: ProviderModelSelectionErrorCode;
	readonly provider: string;
	readonly modelId: string;
	readonly operation: "authentication" | "selection";
	constructor(code: ProviderModelSelectionErrorCode, message: string, provider: string, modelId: string) {
		super(message);
		this.code = code;
		this.provider = provider;
		this.modelId = modelId;
		this.operation = code === "AuthenticationMissing" ? "authentication" : "selection";
		this.name = "ProviderModelSelectionError";
	}
}

export const PROVIDER_MODEL_REFERENCE = Symbol.for("@bastani/atomic/provider-model-reference");

type ReferencedValue = object & { [PROVIDER_MODEL_REFERENCE]?: ProviderModelReference };

export function attachProviderModelReference<T extends object>(value: T, reference: ProviderModelReference | undefined): T {
	if (reference === undefined) return value;
	Object.defineProperty(value, PROVIDER_MODEL_REFERENCE, {
		value: reference,
		enumerable: true,
		configurable: true,
		writable: false,
	});
	return value;
}

export function getProviderModelReference(value: object | null | undefined): ProviderModelReference | undefined {
	return value === null || value === undefined ? undefined : (value as ReferencedValue)[PROVIDER_MODEL_REFERENCE];
}

export function getPersistedProviderSelection(value: object | null | undefined): object | undefined {
	return getProviderModelReference(value)?.selection;
}

export function providerReferenceMatchesSelection(value: object, selection: unknown): boolean {
	const reference = getProviderModelReference(value);
	if (!reference) return false;
	return reference.matchesSelection?.(selection) ?? exactJsonEqual(reference.selection, selection);
}

export function providerModelsAreExactlyEqual(left: object | null | undefined, right: object | null | undefined): boolean {
	if (left === null || left === undefined || right === null || right === undefined) return false;
	const leftReference = getProviderModelReference(left);
	const rightReference = getProviderModelReference(right);
	if (leftReference === undefined && rightReference === undefined) return modelLikeIdentity(left) === modelLikeIdentity(right);
	if (leftReference === undefined || rightReference === undefined) return false;
	if (leftReference.provider !== rightReference.provider || leftReference.schemaVersion !== rightReference.schemaVersion) return false;
	if (leftReference.selection !== undefined || rightReference.selection !== undefined) {
		if (leftReference.selection === undefined || rightReference.selection === undefined) return false;
		const leftMatches = leftReference.matchesSelection?.(rightReference.selection) ?? exactJsonEqual(leftReference.selection, rightReference.selection);
		const rightMatches = rightReference.matchesSelection?.(leftReference.selection) ?? exactJsonEqual(rightReference.selection, leftReference.selection);
		return leftMatches && rightMatches;
	}
	return leftReference.provider === rightReference.provider &&
		leftReference.schemaVersion === rightReference.schemaVersion &&
		exactJsonEqual(leftReference.data, rightReference.data);
}

function modelLikeIdentity(value: object): string | object {
	const candidate = value as { readonly provider?: unknown; readonly id?: unknown };
	return typeof candidate.provider === "string" && typeof candidate.id === "string"
		? `${candidate.provider.length}:${candidate.provider}${candidate.id}`
		: value;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
