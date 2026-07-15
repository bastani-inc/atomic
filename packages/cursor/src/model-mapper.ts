import { CURSOR_API, CURSOR_API_BASE_URL } from "./config.js";

export type CursorCatalogSource = "live";

export interface CursorUsableModel {
	readonly id: string;
	readonly displayName?: string;
	readonly displayNameShort?: string;
	readonly displayModelId?: string;
	readonly maxMode: boolean;
	readonly supportsImages?: true;
}

export interface CursorModelCatalog {
	readonly source: CursorCatalogSource;
	readonly fetchedAt: number;
	readonly credentialScope?: string;
	readonly models: readonly CursorUsableModel[];
}

export type CursorModelInput = ["text"] | ["text", "image"];

export interface CursorModelRouting {
	readonly modelId: string;
	readonly maxMode: boolean;
	readonly supportsImages: boolean;
	readonly catalogOccurrence: number;
}

export interface CursorProviderModelDefinition {
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly reasoning: false;
	readonly input: CursorModelInput;
	readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly metadataProvenance: {
		readonly catalog: CursorCatalogSource;
		readonly capabilities: string;
		readonly contextWindow: string;
		readonly maxTokens: string;
	};
	readonly compat: {
		readonly cursorRouting: Readonly<Record<string, CursorModelRouting>>;
		readonly cursorMetadataProvenance: CursorProviderModelDefinition["metadataProvenance"];
	};
}

const ESTIMATED_CONTEXT_WINDOW = 200_000;
const ESTIMATED_MAX_TOKENS = 64_000;

/** Returns a mutable sequence copy without rewriting authoritative GetUsable rows. */
export function normalizeCursorUsableModels(models: readonly CursorUsableModel[]): CursorUsableModel[] {
	return models.slice();
}

export function mapCursorCatalogToProviderModels(catalog: CursorModelCatalog): CursorProviderModelDefinition[] {
	return normalizeCursorUsableModels(catalog.models).map((model, catalogOccurrence) => {
		const metadataProvenance = {
			catalog: "live" as const,
			capabilities: model.supportsImages === true
				? "Cursor GetUsableModels route with same-account AvailableModels image enrichment"
				: "Cursor GetUsableModels route; image capability not unambiguously established",
			contextWindow: "conservative operational fallback; exact limit unknown",
			maxTokens: "conservative operational fallback; exact limit unknown",
		};
		return {
			id: model.id,
			name: model.displayName ?? model.displayNameShort ?? model.displayModelId ?? model.id,
			api: CURSOR_API,
			baseUrl: CURSOR_API_BASE_URL,
			reasoning: false,
			input: model.supportsImages === true ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: ESTIMATED_CONTEXT_WINDOW,
			maxTokens: ESTIMATED_MAX_TOKENS,
			metadataProvenance,
			compat: {
				cursorRouting: {
					[model.id]: {
						modelId: model.id,
						maxMode: model.maxMode,
						supportsImages: model.supportsImages === true,
						catalogOccurrence,
					},
				},
				cursorMetadataProvenance: metadataProvenance,
			},
		};
	});
}
