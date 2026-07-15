import { normalizeCursorUsableModels, type CursorModelCatalog, type CursorUsableModel } from "./model-mapper.js";
import type { CursorAvailableModel } from "./proto/cursor-available-models-codec.js";
import { CursorTransportError, type CursorAgentTransport, type CursorTransportErrorCode } from "./transport.js";

const DEFAULT_IMAGE_METADATA_GRACE_MS = 250;

export type CursorDiscoveryErrorCode = CursorTransportErrorCode | "NoUsableModels";

export class CursorModelDiscoveryError extends Error {
	constructor(
		readonly code: CursorDiscoveryErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CursorModelDiscoveryError";
	}
}

export interface CursorModelDiscoveryServiceOptions {
	readonly transport: CursorAgentTransport;
	readonly now?: () => number;
	readonly imageMetadataGraceMs?: number;
}

export class CursorModelDiscoveryService {
	readonly #transport: CursorAgentTransport;
	readonly #now: () => number;
	readonly #imageMetadataGraceMs: number;

	constructor(options: CursorModelDiscoveryServiceOptions) {
		this.#transport = options.transport;
		this.#now = options.now ?? Date.now;
		this.#imageMetadataGraceMs = Math.max(0, options.imageMetadataGraceMs ?? DEFAULT_IMAGE_METADATA_GRACE_MS);
	}

	async discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
		const enrichmentController = new AbortController();
		const abortEnrichment = (): void => enrichmentController.abort();
		if (signal?.aborted) abortEnrichment();
		else signal?.addEventListener("abort", abortEnrichment, { once: true });
		const availableTask = this.#loadImageMetadata(accessToken, requestId, enrichmentController.signal, signal);
		void availableTask.catch(() => undefined);
		try {
			const usable = normalizeCursorUsableModels(await this.#transport.getUsableModels(accessToken, requestId, signal));
			if (usable.length === 0) {
				throw new CursorModelDiscoveryError("NoUsableModels", "Cursor account has no usable models. Reselect a model after refreshing the authenticated Cursor catalog.");
			}
			const available = await settleWithin(availableTask, this.#imageMetadataGraceMs);
			return {
				source: "live",
				fetchedAt: this.#now(),
				models: enrichCursorModelsWithImages(usable, available),
			};
		} catch (error) {
			if (error instanceof CursorModelDiscoveryError) throw error;
			if (error instanceof CursorTransportError) throw new CursorModelDiscoveryError(error.code, error.message);
			if (signal?.aborted) throw new CursorModelDiscoveryError("Aborted", "Cursor model discovery was aborted.");
			throw new CursorModelDiscoveryError("ProtocolError", error instanceof Error ? error.message : "Cursor model discovery failed.");
		} finally {
			enrichmentController.abort();
			signal?.removeEventListener("abort", abortEnrichment);
		}
	}

	async #loadImageMetadata(
		accessToken: string,
		requestId: string,
		signal: AbortSignal,
		parentSignal: AbortSignal | undefined,
	): Promise<readonly CursorAvailableModel[]> {
		if (!this.#transport.getAvailableModels) return [];
		try {
			return await this.#transport.getAvailableModels(accessToken, requestId, signal);
		} catch (error) {
			if (parentSignal?.aborted) {
				throw new CursorModelDiscoveryError("Aborted", "Cursor model discovery was aborted.");
			}
			return [];
		}
	}
}

async function settleWithin<T>(task: Promise<T>, graceMs: number): Promise<T | readonly []> {
	if (graceMs <= 0) {
		void task.catch(() => undefined);
		return [];
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<readonly []>((resolve) => { timer = setTimeout(() => resolve([]), graceMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function enrichCursorModelsWithImages(
	usableModels: readonly CursorUsableModel[],
	availableModels: readonly CursorAvailableModel[],
): CursorUsableModel[] {
	const parentsByIdentity = new Map<string, Set<number>>();
	availableModels.forEach((model, parentIndex) => {
		const identities = new Set<string>();
		for (const candidate of [model.id, model.serverModelName, ...model.variantIds]) {
			if (candidate !== undefined && candidate.trim().length > 0) identities.add(candidate);
		}
		for (const identity of identities) {
			const parents = parentsByIdentity.get(identity) ?? new Set<number>();
			parents.add(parentIndex);
			parentsByIdentity.set(identity, parents);
		}
	});
	return normalizeCursorUsableModels(usableModels).map((model) => {
		const parents = parentsByIdentity.get(model.id);
		if (!parents || parents.size !== 1) return withoutImageSupport(model);
		const parentIndex = parents.values().next().value;
		if (parentIndex === undefined || availableModels[parentIndex]?.supportsImages !== true) return withoutImageSupport(model);
		return { ...model, supportsImages: true };
	});
}

function withoutImageSupport(model: CursorUsableModel): CursorUsableModel {
	return {
		id: model.id,
		...(model.displayName ? { displayName: model.displayName } : {}),
		...(model.displayNameShort ? { displayNameShort: model.displayNameShort } : {}),
		...(model.displayModelId ? { displayModelId: model.displayModelId } : {}),
		maxMode: model.maxMode,
	};
}
