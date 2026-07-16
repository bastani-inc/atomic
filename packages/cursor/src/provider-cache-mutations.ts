import type { CursorCatalogCache } from "./catalog-cache.js";
import type { CursorModelCatalog } from "./model-mapper.js";

const CACHE_SAVE_FAILED = "Cursor model catalog cache persistence failed.";
const CACHE_CLEAR_FAILED = "Cursor model catalog cache clear failed.";

// Preserve fail-closed invalidation across provider/coordinator reconstruction
// when an injected cache rejects both physical clear and marker persistence.
const invalidatedScopesByCache = new WeakMap<CursorCatalogCache, Set<string>>();

function cacheInvalidations(cache: CursorCatalogCache): Set<string> {
	const existing = invalidatedScopesByCache.get(cache);
	if (existing) return existing;
	const created = new Set<string>();
	invalidatedScopesByCache.set(cache, created);
	return created;
}

interface ScopeMutationLane {
	generation: number;
	pendingInvalidations: number;
	invalidated: boolean;
	running: boolean;
	tail: Promise<void>;
}

export interface CursorCacheMutationCoordinatorOptions {
	readonly cache: CursorCatalogCache;
	readonly onError?: (error: Error) => void;
}

export class CursorCacheMutationCoordinator {
	readonly #cache: CursorCatalogCache;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #lanes = new Map<string, ScopeMutationLane>();
	readonly #durableInvalidations: Set<string>;

	constructor(options: CursorCacheMutationCoordinatorOptions) {
		this.#cache = options.cache;
		this.#onError = options.onError;
		this.#durableInvalidations = cacheInvalidations(options.cache);
	}

	load(credentialScope: string): CursorModelCatalog | null {
		if (this.#durableInvalidations.has(credentialScope)) return null;
		const lane = this.#lanes.get(credentialScope);
		if (lane && (lane.pendingInvalidations > 0 || lane.invalidated)) return null;
		return this.#cache.load(credentialScope);
	}

	save(catalog: CursorModelCatalog, credentialScope: string): void {
		const lane = this.#lane(credentialScope);
		const generation = lane.generation;
		void this.#enqueue(credentialScope, lane, async () => {
			if (lane.generation !== generation) return;
			try {
				const result = await this.#cache.save(catalog, credentialScope);
				if (lane.generation === generation) {
					const replacingInvalidation = lane.invalidated || this.#durableInvalidations.has(credentialScope);
					const replacementConfirmed = result === true
						|| (result === undefined && replacingInvalidation && this.#savedCatalogMatches(catalog, credentialScope));
					if (!replacingInvalidation || replacementConfirmed) {
						lane.invalidated = false;
						this.#durableInvalidations.delete(credentialScope);
					} else {
						this.#onError?.(new Error(CACHE_SAVE_FAILED));
					}
				}
			} catch {
				this.#onError?.(new Error(CACHE_SAVE_FAILED));
			}
		});
	}

	clear(credentialScope: string): void {
		const lane = this.#lane(credentialScope);
		lane.generation += 1;
		const generation = lane.generation;
		lane.invalidated = true;
		lane.pendingInvalidations += 1;
		this.#durableInvalidations.add(credentialScope);
		void this.#enqueue(credentialScope, lane, async () => {
			try {
				// Without a physical clear, retain both tombstones until a successful replacement save.
				if (this.#cache.clear === undefined) return;
				await this.#cache.clear(credentialScope);
				if (lane.generation === generation) {
					lane.invalidated = false;
					this.#durableInvalidations.delete(credentialScope);
				}
			} catch {
				this.#onError?.(new Error(CACHE_CLEAR_FAILED));
			} finally {
				lane.pendingInvalidations -= 1;
			}
		});
	}

	async authoritativeEmpty(catalog: CursorModelCatalog, credentialScope: string): Promise<Error | undefined> {
		const lane = this.#lane(credentialScope);
		lane.generation += 1;
		const generation = lane.generation;
		lane.invalidated = true;
		lane.pendingInvalidations += 1;
		this.#durableInvalidations.add(credentialScope);
		let failure: Error | undefined;
		const scopedCatalog = catalog.credentialScope === credentialScope ? catalog : { ...catalog, credentialScope };
		await this.#enqueue(credentialScope, lane, async () => {
			let durable = false;
			try {
				if (this.#cache.clear) {
					try {
						await this.#cache.clear(credentialScope);
					} catch {
						// Marker persistence below is the durable fallback when physical clear fails.
					}
				}
				const result = await this.#cache.save(scopedCatalog, credentialScope);
				durable = result === true
					|| (result === undefined && this.#savedCatalogMatches(scopedCatalog, credentialScope));
				if (!durable) failure = new Error(CACHE_CLEAR_FAILED);
			} catch {
				failure = new Error(CACHE_CLEAR_FAILED);
			} finally {
				if (durable && lane.generation === generation) {
					lane.invalidated = false;
					this.#durableInvalidations.delete(credentialScope);
				}
				lane.pendingInvalidations -= 1;
			}
		});
		return failure;
	}

	async waitForIdle(credentialScope: string): Promise<void> {
		await this.#lanes.get(credentialScope)?.tail;
	}

	#savedCatalogMatches(catalog: CursorModelCatalog, credentialScope: string): boolean {
		try {
			const saved = this.#cache.load(credentialScope);
			return saved !== null
				&& saved.source === catalog.source
				&& saved.fetchedAt === catalog.fetchedAt
				&& saved.credentialScope === credentialScope
				&& saved.models.length === catalog.models.length
				&& saved.models.every((model, index) => {
					const expected = catalog.models[index];
					return expected !== undefined
						&& model.id === expected.id
						&& model.displayName === expected.displayName
						&& model.displayNameShort === expected.displayNameShort
						&& model.displayModelId === expected.displayModelId
						&& model.maxMode === expected.maxMode
						&& model.supportsImages === expected.supportsImages;
				});
		} catch {
			return false;
		}
	}

	#lane(credentialScope: string): ScopeMutationLane {
		const existing = this.#lanes.get(credentialScope);
		if (existing) return existing;
		const created: ScopeMutationLane = {
			generation: 0,
			pendingInvalidations: 0,
			invalidated: false,
			running: false,
			tail: Promise.resolve(),
		};
		this.#lanes.set(credentialScope, created);
		return created;
	}

	#enqueue(credentialScope: string, lane: ScopeMutationLane, operation: () => Promise<void>): Promise<void> {
		const task = lane.running ? lane.tail.then(operation, operation) : operation();
		lane.running = true;
		lane.tail = task.then(() => undefined, () => undefined);
		const tail = lane.tail;
		void tail.then(() => {
			if (lane.tail !== tail) return;
			lane.running = false;
			if (lane.pendingInvalidations === 0 && !lane.invalidated) this.#lanes.delete(credentialScope);
		});
		return tail;
	}
}
