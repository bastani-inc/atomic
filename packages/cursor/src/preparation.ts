import { deriveCursorAccountScope, validateCursorHostOAuthCredential, type CursorHostOAuthCredential } from "./account-scope.js";
import type { CursorCatalogCache } from "./catalog-cache.js";
import { CursorError, type CursorOperation } from "./errors.js";
import { mapCursorCatalogToProviderModels, type CursorModelCatalog, type CursorProviderModelDefinition } from "./model-mapper.js";
import type { CursorDiscoveryResult, CursorDiscoveryService } from "./models.js";

export interface CursorPreparationInput {
	readonly hostCredential: CursorHostOAuthCredential | undefined;
	readonly credentialGeneration: number;
	readonly providerInstanceGeneration: number;
	readonly isCurrentGeneration?: () => boolean;
	readonly allowNetwork: boolean;
	readonly force?: boolean;
	readonly signal?: AbortSignal;
}

interface CursorPreparationGeneration {
	readonly providerInstanceGeneration: number;
	readonly accountScope?: string;
	readonly credentialGeneration: number;
	readonly clientVersion: string;
	readonly catalogGeneration: number;
	readonly isCurrentGeneration: () => boolean;
	readonly controller: AbortController;
}

export interface CursorPreparationOptions {
	readonly discovery: CursorDiscoveryService;
	readonly cache: CursorCatalogCache;
	readonly clientVersion: () => string;
	readonly now?: () => number;
	readonly uuid: () => string;
}

export interface CursorRequestLease {
	readonly signal: AbortSignal;
	assertCurrent(operation: CursorOperation): void;
}

export class CursorPreparationController {
	readonly #discovery: CursorDiscoveryService;
	readonly #cache: CursorCatalogCache;
	readonly #clientVersion: () => string;
	readonly #now: () => number;
	readonly #uuid: () => string;
	#nextCatalogGeneration = 0;
	#active?: CursorPreparationGeneration;
	#catalog: CursorModelCatalog | null = null;
	#disposed = false;

	constructor(options: CursorPreparationOptions) {
		this.#discovery = options.discovery;
		this.#cache = options.cache;
		this.#clientVersion = options.clientVersion;
		this.#now = options.now ?? Date.now;
		this.#uuid = options.uuid;
	}

	get catalog(): CursorModelCatalog | null {
		return this.#catalog;
	}


	acquireRequestLease(reference: import("./route-reference.js").CursorRouteReference): CursorRequestLease {
		const generation = this.#active;
		if (!generation || !this.#catalog || !this.referenceMatchesGeneration(reference, generation)) {
			throw new CursorError("StaleGeneration", "Cursor route selection is not current for request transport.", {
				operation: "request",
				route: reference,
			});
		}
		return {
			signal: generation.controller.signal,
			assertCurrent: (operation) => {
				if (!this.referenceMatchesGeneration(reference, generation)) {
					throw new CursorError("StaleGeneration", "Cursor request belongs to a stale provider generation.", { operation, route: reference });
				}
			},
		};
	}
	async prepare(input: CursorPreparationInput): Promise<CursorProviderModelDefinition[]> {
		if (this.#disposed) throw new CursorError("Disposed", "Cursor provider preparation is disposed.", { operation: "preparation" });
		this.#active?.controller.abort();
		const controller = new AbortController();
		const generation: CursorPreparationGeneration = {
			providerInstanceGeneration: input.providerInstanceGeneration,
			credentialGeneration: input.credentialGeneration,
			isCurrentGeneration: input.isCurrentGeneration ?? (() => true),
			clientVersion: this.#clientVersion(),
			catalogGeneration: ++this.#nextCatalogGeneration,
			controller,
		};
		this.#active = generation;
		this.#catalog = null;
		const removeInputAbort = forwardAbort(input.signal, controller);
		try {
			if (!input.hostCredential) {
				throw new CursorError("AuthenticationMissing", "Cursor host OAuth credentials are required.", { operation: "authentication" });
			}
			validateCursorHostOAuthCredential(input.hostCredential, this.#now());
			const stableAccountScope = deriveCursorAccountScope(input.hostCredential, this.#now());
			const scopedGeneration = { ...generation, accountScope: stableAccountScope ?? `cursor-runtime-v1:${this.#uuid()}` };
			this.#active = scopedGeneration;
			if (!input.force && stableAccountScope !== undefined) {
				const cached = this.loadCache(scopedGeneration);
				if (cached) return this.publish(cached, scopedGeneration);
			}
			if (!input.allowNetwork) {
				throw new CursorError("DiscoveryFailed", "Cursor requires live model discovery because no eligible catalog cache exists.", { operation: "preparation" });
			}
			const discovered = await this.#discovery.discover(input.hostCredential.access, this.#uuid(), controller.signal);
			const catalog = toCatalog(discovered, scopedGeneration, stableAccountScope !== undefined);
			const models = this.publish(catalog, scopedGeneration);
			try {
				if (stableAccountScope !== undefined && this.isCurrent(scopedGeneration)) this.#cache.save(catalog);
			} catch {
				// A successful authoritative discovery remains registered in memory.
			}
			return models;
		} finally {
			removeInputAbort();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#active?.controller.abort();
		this.#active = undefined;
		this.#catalog = null;
	}

	private loadCache(generation: CursorPreparationGeneration & { readonly accountScope: string }): CursorModelCatalog | null {
		try {
			const cached = this.#cache.load({
				accountScope: generation.accountScope,
				clientVersion: generation.clientVersion,
				catalogGeneration: generation.catalogGeneration,
				now: this.#now(),
			});
			return cached ? {
				...cached,
				providerInstanceGeneration: generation.providerInstanceGeneration,
				credentialGeneration: generation.credentialGeneration,
			} : null;
		} catch {
			return null;
		}
	}

	private publish(
		catalog: CursorModelCatalog,
		generation: CursorPreparationGeneration & { readonly accountScope: string },
	): CursorProviderModelDefinition[] {
		if (!this.isCurrent(generation)) {
			throw new CursorError("StaleGeneration", "Cursor catalog result belongs to a stale preparation generation.", {
				operation: "preparation",
			});
		}
		const models = mapCursorCatalogToProviderModels(catalog);
		this.#catalog = catalog;
		return models;
	}

	private isCurrent(generation: CursorPreparationGeneration): boolean {
		const active = this.#active;
		return !this.#disposed && active === generation &&
			active.providerInstanceGeneration === generation.providerInstanceGeneration &&
			active.accountScope === generation.accountScope &&
			active.credentialGeneration === generation.credentialGeneration &&
			active.isCurrentGeneration() &&
			active.clientVersion === generation.clientVersion &&
			active.clientVersion === this.#clientVersion() &&
			active.catalogGeneration === generation.catalogGeneration &&
			!active.controller.signal.aborted;
	}

	private referenceMatchesGeneration(
		reference: import("./route-reference.js").CursorRouteReference,
		generation: CursorPreparationGeneration,
	): boolean {
		if (!this.isCurrent(generation) || generation.accountScope === undefined) return false;
		if (reference.provider !== "cursor" || reference.accountScope !== generation.accountScope ||
			reference.providerInstanceGeneration !== generation.providerInstanceGeneration ||
			reference.credentialGeneration !== generation.credentialGeneration ||
			reference.clientVersion !== generation.clientVersion ||
			reference.catalogGeneration !== generation.catalogGeneration) return false;
		const matchingRows = this.#catalog?.rows.filter((row) => row.modelId === reference.routeId && row.maxMode === reference.maxMode) ?? [];
		return reference.occurrence >= 1 && reference.occurrence <= matchingRows.length;
	}
}

function toCatalog(
	discovery: CursorDiscoveryResult,
	generation: CursorPreparationGeneration & { readonly accountScope: string },
	selectionPersistence: boolean,
): CursorModelCatalog {
	return {
		accountScope: generation.accountScope,
		providerInstanceGeneration: generation.providerInstanceGeneration,
		credentialGeneration: generation.credentialGeneration,
		clientVersion: generation.clientVersion,
		fetchedAt: discovery.fetchedAt,
		catalogGeneration: generation.catalogGeneration,
		selectionPersistence,
		rows: discovery.rows,
	};
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => undefined;
	const abort = (): void => target.abort(source.reason);
	if (source.aborted) abort();
	else source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}
