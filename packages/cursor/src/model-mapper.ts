import { CURSOR_API, CURSOR_API_BASE_URL } from "./config.js";
import { CursorError } from "./errors.js";
import {
	createCursorRouteReferences,
	parseCursorSelectionRecord,
	selectionRecordMatchesReference,
	toCursorSelectionRecord,
	type CursorAuthoritativeRouteRow,
	type CursorRouteReference,
	type CursorSelectionRecord,
} from "./route-reference.js";

export const CURSOR_HOST_CONTEXT_WINDOW = 200_000;
export const CURSOR_HOST_MAX_OUTPUT_TOKENS = 64_000;
export const CURSOR_PROVIDER_REFERENCE_VERSION = 1;

export type CursorUsableModel = CursorAuthoritativeRouteRow;

export interface CursorModelCatalog {
	readonly accountScope: string;
	readonly clientVersion: string;
	readonly fetchedAt: number;
	readonly catalogGeneration: number;
	readonly providerInstanceGeneration?: number;
	readonly credentialGeneration?: number;
	readonly selectionPersistence?: boolean;
	readonly rows: readonly CursorAuthoritativeRouteRow[];
}

export interface CursorProviderReference {
	readonly provider: "cursor";
	readonly schemaVersion: typeof CURSOR_PROVIDER_REFERENCE_VERSION;
	readonly data: Omit<CursorRouteReference, "provider">;
	readonly selection?: CursorSelectionRecord;
	readonly matchesSelection: (value: unknown) => boolean;
}

export interface CursorProviderModelDefinition {
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly reasoning: false;
	readonly input: ["text"];
	readonly cost: { readonly input: 0; readonly output: 0; readonly cacheRead: 0; readonly cacheWrite: 0 };
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly providerReference: CursorProviderReference;
}

const PROVIDER_MODEL_REFERENCE = Symbol.for("@bastani/atomic/provider-model-reference");

export function getCursorRouteReference(model: object): CursorRouteReference {
	const value = (model as { [PROVIDER_MODEL_REFERENCE]?: CursorProviderReference })[PROVIDER_MODEL_REFERENCE];
	const data = value?.provider === "cursor" && value.schemaVersion === CURSOR_PROVIDER_REFERENCE_VERSION ? value.data : undefined;
	if (!data || typeof data.accountScope !== "string" || data.accountScope.length === 0 ||
		typeof data.routeId !== "string" || data.routeId.length === 0 ||
		(data.maxMode !== undefined && typeof data.maxMode !== "boolean") ||
		!Number.isInteger(data.occurrence) || data.occurrence < 1 ||
		!Number.isInteger(data.providerInstanceGeneration) || data.providerInstanceGeneration < 0 ||
		!Number.isInteger(data.credentialGeneration) || data.credentialGeneration < 0 ||
		typeof data.clientVersion !== "string" || data.clientVersion.length === 0 ||
		!Number.isInteger(data.catalogGeneration) || data.catalogGeneration < 1) {
		throw new CursorError("UnsupportedSelection", "Cursor model lacks a valid official exact route reference.", { operation: "selection" });
	}
	return { provider: "cursor", ...data };
}

export function mapCursorCatalogToProviderModels(catalog: CursorModelCatalog): CursorProviderModelDefinition[] {
	assertCatalog(catalog);
	const references = createCursorRouteReferences(catalog.accountScope, catalog.catalogGeneration, catalog.rows, {
		providerInstanceGeneration: catalog.providerInstanceGeneration,
		credentialGeneration: catalog.credentialGeneration,
		clientVersion: catalog.clientVersion,
	});
	return catalog.rows.map((row, index) => {
		const reference = references[index];
		if (!reference) throw protocolError("Cursor catalog occurrence construction failed.");
		return {
			id: row.modelId,
			name: presentationName(row, reference),
			api: CURSOR_API,
			baseUrl: CURSOR_API_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CURSOR_HOST_CONTEXT_WINDOW,
			maxTokens: CURSOR_HOST_MAX_OUTPUT_TOKENS,
			providerReference: {
				provider: "cursor",
				schemaVersion: CURSOR_PROVIDER_REFERENCE_VERSION,
				data: {
					accountScope: reference.accountScope,
					routeId: reference.routeId,
					maxMode: reference.maxMode,
					occurrence: reference.occurrence,
					catalogGeneration: reference.catalogGeneration,
					providerInstanceGeneration: reference.providerInstanceGeneration,
					credentialGeneration: reference.credentialGeneration,
					clientVersion: reference.clientVersion,
				},
				...(catalog.selectionPersistence === false ? {} : { selection: toCursorSelectionRecord(reference) }),
				matchesSelection: (value) => {
					const record = parseCursorSelectionRecord(value);
					return record !== undefined && selectionRecordMatchesReference(record, reference);
				},
			},
		};
	});
}


function assertCatalog(catalog: CursorModelCatalog): void {
	if (typeof catalog.accountScope !== "string" || catalog.accountScope.length === 0) throw protocolError("Cursor catalog account scope is missing.");
	if (typeof catalog.clientVersion !== "string" || catalog.clientVersion.length === 0) throw protocolError("Cursor catalog client version is missing.");
	if (typeof catalog.fetchedAt !== "number" || !Number.isFinite(catalog.fetchedAt) || catalog.fetchedAt < 0) throw protocolError("Cursor catalog fetch timestamp is malformed.");
	if (!Number.isInteger(catalog.catalogGeneration) || catalog.catalogGeneration < 1) throw protocolError("Cursor catalog generation is malformed.");
	if (!Array.isArray(catalog.rows)) throw protocolError("Cursor catalog rows are malformed.");
	for (const row of catalog.rows) assertRow(row);
}

function assertRow(row: CursorAuthoritativeRouteRow): void {
	if (typeof row !== "object" || row === null) throw protocolError("Cursor GetUsableModels contains a malformed row.");
	if (typeof row.modelId !== "string" || row.modelId.length === 0) throw protocolError("Cursor GetUsableModels contains an empty route ID.");
	if (row.maxMode !== undefined && typeof row.maxMode !== "boolean") throw protocolError("Cursor GetUsableModels contains a malformed max_mode state.");
	if (row.displayName !== undefined && typeof row.displayName !== "string") throw protocolError("Cursor GetUsableModels contains a malformed display name.");
}

function presentationName(row: CursorAuthoritativeRouteRow, reference: CursorRouteReference): string {
	const base = row.displayName ?? row.modelId;
	const max = row.maxMode === true ? " (Max)" : row.maxMode === undefined ? "" : " (non-Max)";
	const occurrence = reference.occurrence > 1 ? ` (occurrence ${reference.occurrence})` : "";
	return `${base}${max}${occurrence}`;
}

function protocolError(message: string): CursorError {
	return new CursorError("ProtocolMalformed", message, { operation: "discovery" });
}
