import { CursorError } from "./errors.js";
export const CURSOR_SELECTION_VERSION = 1;

export type CursorMaxModeState = "absent" | "false" | "true";

export interface CursorAuthoritativeRouteRow {
	readonly modelId: string;
	readonly maxMode: boolean | undefined;
	readonly displayName?: string;
}

export interface CursorRouteReference {
	readonly provider: "cursor";
	readonly accountScope: string;
	readonly routeId: string;
	readonly maxMode: boolean | undefined;
	readonly occurrence: number;
	readonly providerInstanceGeneration: number;
	readonly credentialGeneration: number;
	readonly clientVersion: string;
	readonly catalogGeneration: number;
}

export interface CursorSelectionRecord {
	readonly version: typeof CURSOR_SELECTION_VERSION;
	readonly provider: "cursor";
	readonly accountScope: string;
	readonly routeId: string;
	readonly maxMode: CursorMaxModeState;
	readonly occurrence: number;
}

export function createCursorRouteReferences(
	accountScope: string,
	catalogGeneration: number,
	rows: readonly CursorAuthoritativeRouteRow[],
	generation: { readonly providerInstanceGeneration?: number; readonly credentialGeneration?: number; readonly clientVersion?: string } = {},
): CursorRouteReference[] {
	const occurrenceCounts = new Map<string, number>();
	return rows.map((row) => {
		const key = occurrenceKey(row.modelId, row.maxMode);
		const occurrence = (occurrenceCounts.get(key) ?? 0) + 1;
		occurrenceCounts.set(key, occurrence);
		return {
			provider: "cursor",
			accountScope,
			routeId: row.modelId,
			maxMode: row.maxMode,
			occurrence,
			providerInstanceGeneration: generation.providerInstanceGeneration ?? 0,
			credentialGeneration: generation.credentialGeneration ?? 0,
			clientVersion: generation.clientVersion ?? "untracked",
			catalogGeneration,
		};
	});
}

export function assertCursorRouteReference(value: CursorRouteReference): void {
	if (value.provider !== "cursor" || typeof value.accountScope !== "string" || value.accountScope.length === 0 ||
		typeof value.routeId !== "string" || value.routeId.length === 0 ||
		(value.maxMode !== undefined && typeof value.maxMode !== "boolean") ||
		!Number.isInteger(value.occurrence) || value.occurrence < 1 ||
		!Number.isInteger(value.providerInstanceGeneration) || value.providerInstanceGeneration < 0 ||
		!Number.isInteger(value.credentialGeneration) || value.credentialGeneration < 0 ||
		typeof value.clientVersion !== "string" || value.clientVersion.length === 0 ||
		!Number.isInteger(value.catalogGeneration) || value.catalogGeneration < 1) {
		throw new CursorError("UnsupportedSelection", "Cursor route reference is malformed or unsupported.", { operation: "selection" });
	}
}

export function toCursorSelectionRecord(reference: CursorRouteReference): CursorSelectionRecord {
	return {
		version: CURSOR_SELECTION_VERSION,
		provider: "cursor",
		accountScope: reference.accountScope,
		routeId: reference.routeId,
		maxMode: maxModeState(reference.maxMode),
		occurrence: reference.occurrence,
	};
}

export function parseCursorSelectionRecord(value: unknown): CursorSelectionRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== CURSOR_SELECTION_VERSION || value.provider !== "cursor") return undefined;
	if (typeof value.accountScope !== "string" || value.accountScope.length === 0) return undefined;
	if (typeof value.routeId !== "string" || value.routeId.length === 0) return undefined;
	if (!isCursorMaxModeState(value.maxMode)) return undefined;
	if (typeof value.occurrence !== "number" || !Number.isInteger(value.occurrence) || value.occurrence < 1) return undefined;
	return {
		version: CURSOR_SELECTION_VERSION,
		provider: "cursor",
		accountScope: value.accountScope,
		routeId: value.routeId,
		maxMode: value.maxMode,
		occurrence: value.occurrence,
	};
}

export function selectionRecordMatchesReference(record: CursorSelectionRecord, reference: CursorRouteReference): boolean {
	return record.accountScope === reference.accountScope &&
		record.routeId === reference.routeId &&
		record.maxMode === maxModeState(reference.maxMode) &&
		record.occurrence === reference.occurrence;
}

export function maxModeState(value: boolean | undefined): CursorMaxModeState {
	return value === undefined ? "absent" : value ? "true" : "false";
}

export function maxModeFromState(value: CursorMaxModeState): boolean | undefined {
	return value === "absent" ? undefined : value === "true";
}

function occurrenceKey(routeId: string, maxMode: boolean | undefined): string {
	return `${routeId.length}:${routeId}:${maxModeState(maxMode)}`;
}


function isCursorMaxModeState(value: unknown): value is CursorMaxModeState {
	return value === "absent" || value === "false" || value === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
