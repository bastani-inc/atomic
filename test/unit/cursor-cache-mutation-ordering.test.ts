import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorCacheMutationCoordinator } from "../../packages/cursor/src/provider-cache-mutations.js";

const scopeA = `account-${"a".repeat(43)}`;
const scopeB = `account-${"b".repeat(43)}`;

function catalog(id: string, scope: string, fetchedAt: number): CursorModelCatalog {
	return { source: "live", fetchedAt, credentialScope: scope, models: [{ id, maxMode: false }] };
}

class MemoryCache implements CursorCatalogCache {
	readonly records = new Map<string, CursorModelCatalog>();
	readonly loads: string[] = [];
	readonly saves: string[] = [];
	readonly clears: string[] = [];
	onSave?: (value: CursorModelCatalog, scope: string) => Promise<void>;
	onClear?: (scope: string) => Promise<void>;

	load(scope?: string): CursorModelCatalog | null {
		if (!scope) return null;
		this.loads.push(scope);
		return this.records.get(scope) ?? null;
	}
	async save(value: CursorModelCatalog, scope?: string): Promise<void> {
		if (!scope) return;
		this.saves.push(scope);
		await this.onSave?.(value, scope);
		this.records.set(scope, value);
	}
	async clear(scope?: string): Promise<void> {
		if (!scope) return;
		this.clears.push(scope);
		await this.onClear?.(scope);
		this.records.delete(scope);
	}
}

class CacheWithoutClear implements CursorCatalogCache {
	readonly records = new Map<string, CursorModelCatalog>();
	readonly loads: string[] = [];
	readonly saves: string[] = [];

	load(scope?: string): CursorModelCatalog | null {
		if (scope === undefined) return null;
		this.loads.push(scope);
		return this.records.get(scope) ?? null;
	}

	save(value: CursorModelCatalog, scope?: string): void {
		if (scope === undefined) return;
		this.saves.push(scope);
		this.records.set(scope, value);
	}
}

class PromiseOutcomeCache implements CursorCatalogCache {
	readonly records = new Map<string, CursorModelCatalog>();
	outcome = false;
	load(scope?: string): CursorModelCatalog | null { return scope === undefined ? null : this.records.get(scope) ?? null; }
	async save(value: CursorModelCatalog, scope?: string): Promise<boolean> {
		await Promise.resolve();
		if (scope === undefined || !this.outcome) return false;
		this.records.set(scope, value);
		return true;
	}
	clear(): void { throw new Error("clear rejected"); }
}

class UncertainSkippingCache implements CursorCatalogCache {
	readonly records = new Map<string, CursorModelCatalog>();
	load(scope?: string): CursorModelCatalog | null { return scope === undefined ? null : this.records.get(scope) ?? null; }
	save(): void { /* custom cache cannot confirm and does not apply the write */ }
}


describe("Cursor per-scope cache mutation ordering", () => {
	test("a delayed invalidation blocks loads and finishes before a newer same-scope save", async () => {
		const cache = new MemoryCache();
		cache.records.set(scopeA, catalog("revoked", scopeA, 1));
		const clearGate = Promise.withResolvers<void>();
		const clearStarted = Promise.withResolvers<void>();
		cache.onClear = async (scope) => {
			if (scope === scopeA) {
				clearStarted.resolve();
				await clearGate.promise;
			}
		};
		const mutations = new CursorCacheMutationCoordinator({ cache });

		mutations.clear(scopeA);
		await clearStarted.promise;
		assert.equal(mutations.load(scopeA), null);
		assert.deepEqual(cache.loads, []);
		mutations.save(catalog("replacement", scopeA, 2), scopeA);
		clearGate.resolve();
		await mutations.waitForIdle(scopeA);

		assert.equal(cache.records.get(scopeA)?.models[0]?.id, "replacement");
		assert.deepEqual(cache.clears, [scopeA]);
		assert.deepEqual(cache.saves, [scopeA]);
	});

	test("a newer clear waits for an already-started save and remains the final state", async () => {
		const cache = new MemoryCache();
		const saveGate = Promise.withResolvers<void>();
		const saveStarted = Promise.withResolvers<void>();
		cache.onSave = async (_value, scope) => {
			if (scope === scopeA) {
				saveStarted.resolve();
				await saveGate.promise;
			}
		};
		const mutations = new CursorCacheMutationCoordinator({ cache });

		mutations.save(catalog("must-not-survive", scopeA, 2), scopeA);
		await saveStarted.promise;
		mutations.clear(scopeA);
		saveGate.resolve();
		await mutations.waitForIdle(scopeA);

		assert.equal(cache.records.has(scopeA), false);
		assert.deepEqual(cache.saves, [scopeA]);
		assert.deepEqual(cache.clears, [scopeA]);
	});

	test("a later invalidation suppresses an earlier save queued behind a delayed clear", async () => {
		const cache = new MemoryCache();
		const firstClearGate = Promise.withResolvers<void>();
		const firstClearStarted = Promise.withResolvers<void>();
		let clearCalls = 0;
		cache.onClear = async (scope) => {
			if (scope !== scopeA) return;
			clearCalls += 1;
			if (clearCalls === 1) {
				firstClearStarted.resolve();
				await firstClearGate.promise;
			}
		};
		const mutations = new CursorCacheMutationCoordinator({ cache });

		mutations.clear(scopeA);
		await firstClearStarted.promise;
		mutations.save(catalog("superseded-save", scopeA, 2), scopeA);
		mutations.clear(scopeA);
		firstClearGate.resolve();
		await mutations.waitForIdle(scopeA);

		assert.deepEqual(cache.saves, []);
		assert.deepEqual(cache.clears, [scopeA, scopeA]);
		assert.equal(cache.records.has(scopeA), false);
	});

	test("a pending scope-A invalidation does not block scope-B load or save", async () => {
		const cache = new MemoryCache();
		cache.records.set(scopeB, catalog("scope-b-old", scopeB, 1));
		const clearGate = Promise.withResolvers<void>();
		const clearStarted = Promise.withResolvers<void>();
		cache.onClear = async (scope) => {
			if (scope === scopeA) {
				clearStarted.resolve();
				await clearGate.promise;
			}
		};
		const mutations = new CursorCacheMutationCoordinator({ cache });

		mutations.clear(scopeA);
		await clearStarted.promise;
		assert.equal(mutations.load(scopeB)?.models[0]?.id, "scope-b-old");
		mutations.save(catalog("scope-b-new", scopeB, 2), scopeB);
		await mutations.waitForIdle(scopeB);
		assert.equal(cache.records.get(scopeB)?.models[0]?.id, "scope-b-new");
		clearGate.resolve();
		await mutations.waitForIdle(scopeA);
	});

	test("cache failures surface fixed diagnostics without injected scope details", async () => {
		const cache = new MemoryCache();
		cache.onSave = async () => { throw new Error(`save leaked ${scopeA}`); };
		cache.onClear = async () => { throw new Error(`clear leaked ${scopeA}`); };
		const errors: Error[] = [];
		cache.records.set(scopeA, catalog("revoked", scopeA, 0));
		const mutations = new CursorCacheMutationCoordinator({ cache, onError: (error) => errors.push(error) });

		mutations.save(catalog("live", scopeA, 1), scopeA);
		await mutations.waitForIdle(scopeA);
		mutations.clear(scopeA);
		await mutations.waitForIdle(scopeA);
		assert.equal(mutations.load(scopeA), null, "a failed invalidation must not expose its revoked record");
		assert.deepEqual(cache.loads, []);

		assert.deepEqual(errors.map((error) => error.message), [
			"Cursor model catalog cache persistence failed.",
			"Cursor model catalog cache clear failed.",
		]);
		assert.equal(errors.some((error) => error.message.includes(scopeA)), false);

		cache.onSave = undefined;
		mutations.save(catalog("recovered", scopeA, 2), scopeA);
		await mutations.waitForIdle(scopeA);
		assert.equal(mutations.load(scopeA)?.models[0]?.id, "recovered");
	});
	test("a cache without clear keeps revoked data hidden until a newer save replaces it", async () => {
		const cache = new CacheWithoutClear();
		cache.records.set(scopeA, catalog("revoked", scopeA, 1));
		const mutations = new CursorCacheMutationCoordinator({ cache });

		mutations.clear(scopeA);
		await mutations.waitForIdle(scopeA);

		assert.equal(cache.records.get(scopeA)?.models[0]?.id, "revoked", "the injected cache has no physical clear");
		assert.equal(mutations.load(scopeA), null, "the invalidation tombstone must hide the revoked record");
		assert.deepEqual(cache.loads, []);

		mutations.save(catalog("replacement", scopeA, 2), scopeA);
		await mutations.waitForIdle(scopeA);

		assert.equal(mutations.load(scopeA)?.models[0]?.id, "replacement");
		assert.deepEqual(cache.loads, [scopeA, scopeA], "a legacy void save is verified before releasing the tombstone");
		assert.deepEqual(cache.saves, [scopeA]);
	});

	test("authoritative empty supersedes an older save and a later nonempty save may repopulate", async () => {
		const cache = new MemoryCache();
		const oldSaveGate = Promise.withResolvers<void>();
		const oldSaveStarted = Promise.withResolvers<void>();
		let firstSave = true;
		cache.onSave = async (_value, scope) => {
			if (scope === scopeA && firstSave) {
				firstSave = false;
				oldSaveStarted.resolve();
				await oldSaveGate.promise;
			}
		};
		const mutations = new CursorCacheMutationCoordinator({ cache });
		mutations.save(catalog("older-queued", scopeA, 1), scopeA);
		await oldSaveStarted.promise;
		const empty = { source: "live", fetchedAt: 2, credentialScope: scopeA, models: [] } as const;
		const invalidated = mutations.authoritativeEmpty(empty, scopeA);
		assert.equal(mutations.load(scopeA), null);
		mutations.save(catalog("later-current", scopeA, 3), scopeA);
		oldSaveGate.resolve();
		await invalidated;
		await mutations.waitForIdle(scopeA);
		assert.equal(cache.records.get(scopeA)?.models[0]?.id, "later-current");
		assert.deepEqual(cache.clears, [scopeA]);
		assert.deepEqual(cache.saves, [scopeA, scopeA, scopeA], "the empty marker is saved between ordered positive writes");
	});

	test("equal-timestamp same-scope saves are linearized in invocation order", async () => {
		const cache = new MemoryCache();
		const saveGate = Promise.withResolvers<void>();
		const firstSaveStarted = Promise.withResolvers<void>();
		let sawFirst = false;
		cache.onSave = async (_value, scope) => {
			if (scope === scopeA && !sawFirst) {
				sawFirst = true;
				firstSaveStarted.resolve();
				await saveGate.promise;
			}
		};
		const mutations = new CursorCacheMutationCoordinator({ cache });

		// Two accepted same-scope catalogs share a millisecond timestamp; the later
		// invocation must still be the final record (fetchedAt equality does not
		// change lane ordering).
		mutations.save(catalog("first", scopeA, 100), scopeA);
		await firstSaveStarted.promise;
		mutations.save(catalog("equal-later", scopeA, 100), scopeA);
		saveGate.resolve();
		await mutations.waitForIdle(scopeA);

		assert.equal(cache.records.get(scopeA)?.models[0]?.id, "equal-later");
		assert.deepEqual(cache.saves, [scopeA, scopeA]);
	});


	test("Promise save outcomes retain or release a tombstone only when explicitly applied", async () => {
		const cache = new PromiseOutcomeCache();
		cache.records.set(scopeA, catalog("revoked", scopeA, 10_000));
		const mutations = new CursorCacheMutationCoordinator({ cache });
		mutations.clear(scopeA);
		await mutations.waitForIdle(scopeA);

		mutations.save(catalog("skipped", scopeA, 200), scopeA);
		await mutations.waitForIdle(scopeA);
		assert.equal(mutations.load(scopeA), null, "Promise false must retain the tombstone");

		cache.outcome = true;
		mutations.save(catalog("applied", scopeA, 10_000), scopeA);
		await mutations.waitForIdle(scopeA);
		assert.equal(mutations.load(scopeA)?.models[0]?.id, "applied", "Promise true may release the tombstone");
	});

	test("an uncertain custom void save cannot expose a retained stale row", async () => {
		const cache = new UncertainSkippingCache();
		cache.records.set(scopeA, catalog("revoked", scopeA, 10_000));
		const mutations = new CursorCacheMutationCoordinator({ cache });
		mutations.clear(scopeA);
		await mutations.waitForIdle(scopeA);
		mutations.save(catalog("uncertain", scopeA, 200), scopeA);
		await mutations.waitForIdle(scopeA);

		assert.equal(mutations.load(scopeA), null);
	});
});
