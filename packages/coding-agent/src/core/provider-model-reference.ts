export interface ProviderModelReference<TData extends object = object> {
	readonly provider: string;
	readonly schemaVersion: number;
	readonly data: TData;
	/** Plain, JSON-safe identity used only for current-catalog transport round trips. */
	readonly transportSelection?: object;
	/** Plain, JSON-safe, versioned record persisted by host settings/sessions. */
	readonly selection?: object;
	/** Provider-owned strict parser/matcher for a persisted record. */
	readonly matchesSelection?: (value: unknown) => boolean;
	/** Provider-owned strict parser/matcher for a transport selection. */
	readonly matchesTransportSelection?: (value: unknown) => boolean;
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

export function getProviderTransportSelection(value: object | null | undefined): object | undefined {
	const reference = getProviderModelReference(value);
	return reference?.transportSelection ?? reference?.selection;
}

export function providerReferenceMatchesSelection(value: object, selection: unknown): boolean {
	const reference = getProviderModelReference(value);
	if (!reference) return false;
	return reference.matchesSelection?.(selection) ?? exactJsonEqual(reference.selection, selection);
}

export function providerReferenceMatchesTransportSelection(value: object, selection: unknown): boolean {
	const reference = getProviderModelReference(value);
	if (!reference) return false;
	return reference.matchesTransportSelection?.(selection) ??
		reference.matchesSelection?.(selection) ??
		exactJsonEqual(reference.transportSelection ?? reference.selection, selection);
}

export function providerModelsAreExactlyEqual(left: object | null | undefined, right: object | null | undefined): boolean {
	if (left === null || left === undefined || right === null || right === undefined) return false;
	const leftReference = getProviderModelReference(left);
	const rightReference = getProviderModelReference(right);
	if (leftReference === undefined && rightReference === undefined) return modelLikeIdentity(left) === modelLikeIdentity(right);
	if (leftReference === undefined || rightReference === undefined) return false;
	if (leftReference.provider !== rightReference.provider || leftReference.schemaVersion !== rightReference.schemaVersion) return false;
	const leftTransport = leftReference.transportSelection;
	const rightTransport = rightReference.transportSelection;
	if (leftTransport !== undefined && rightTransport !== undefined) {
		const leftMatches = leftReference.matchesTransportSelection?.(rightTransport) ??
			leftReference.matchesSelection?.(rightTransport) ?? exactJsonEqual(leftTransport, rightTransport);
		const rightMatches = rightReference.matchesTransportSelection?.(leftTransport) ??
			rightReference.matchesSelection?.(leftTransport) ?? exactJsonEqual(rightTransport, leftTransport);
		if (leftMatches && rightMatches) return true;
	}
	const leftPersisted = leftReference.selection;
	const rightPersisted = rightReference.selection;
	if (leftPersisted !== undefined && rightPersisted !== undefined) {
		const leftMatches = leftReference.matchesSelection?.(rightPersisted) ?? exactJsonEqual(leftPersisted, rightPersisted);
		const rightMatches = rightReference.matchesSelection?.(leftPersisted) ?? exactJsonEqual(rightPersisted, leftPersisted);
		if (leftMatches && rightMatches) return true;
	}
	if (leftTransport !== undefined || rightTransport !== undefined || leftPersisted !== undefined || rightPersisted !== undefined) {
		return false;
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
