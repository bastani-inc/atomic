import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { CursorCatalogCache, CursorCatalogCacheQuery } from "../../packages/cursor/src/catalog-cache.js";
import { CursorError } from "../../packages/cursor/src/errors.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import type { CursorDiscoveryResult, CursorDiscoveryService } from "../../packages/cursor/src/models.js";
import { CursorPreparationController } from "../../packages/cursor/src/preparation.js";

const now = 1_000;
function jwt(subject: string): string {
	const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "https://authentication.cursor.sh", sub: subject })}.signature`;
}
function credential(subject = "auth0|account") {
	const token = jwt(subject);
	return { type: "oauth" as const, access: token, refresh: token, expires: now + 10_000 };
}
const input = { hostCredential: credential(), credentialGeneration: 1, providerInstanceGeneration: 1, allowNetwork: true };

class MemoryCache implements CursorCatalogCache {
	catalog: CursorModelCatalog | null = null;
	saves: CursorModelCatalog[] = [];
	throwOnSave = false;
	loadQueries: CursorCatalogCacheQuery[] = [];
	load(query: CursorCatalogCacheQuery): CursorModelCatalog | null {
		this.loadQueries.push(query);
		return this.catalog && this.catalog.accountScope === query.accountScope && this.catalog.clientVersion === query.clientVersion
			? { ...this.catalog, catalogGeneration: query.catalogGeneration }
			: null;
	}
	save(catalog: CursorModelCatalog): void {
		if (this.throwOnSave) throw new Error("disk full");
		this.saves.push(catalog);
		this.catalog = catalog;
	}
}

function controller(options: { cache?: MemoryCache; discover?: CursorDiscoveryService["discover"]; clientVersion?: () => string } = {}) {
	let request = 0;
	return new CursorPreparationController({
		cache: options.cache ?? new MemoryCache(),
		discovery: { discover: options.discover ?? (async () => ({ fetchedAt: now, rows: [{ modelId: "live", maxMode: false }] })) } satisfies CursorDiscoveryService,
		clientVersion: options.clientVersion ?? (() => "client-v1"),
		now: () => now,
		uuid: () => `request-${++request}`,
	});
}

describe("Cursor tracked preparation", () => {
	test("uses an eligible cached authoritative empty without network", async () => {
		const cache = new MemoryCache();
		const scopeController = controller({ cache });
		await scopeController.prepare(input);
		assert.ok(scopeController.catalog);
		cache.catalog = { ...scopeController.catalog!, rows: [], fetchedAt: now };
		let discoveries = 0;
		const cachedController = controller({ cache, discover: async () => { discoveries += 1; return { fetchedAt: now, rows: [] }; } });
		assert.deepEqual(await cachedController.prepare(input), []);
		assert.equal(discoveries, 0);
		assert.deepEqual(cachedController.catalog?.rows, []);
	});

	test("awaits live discovery, publishes empty atomically, and ignores cache write failure", async () => {
		const cache = new MemoryCache();
		cache.throwOnSave = true;
		const prepared = controller({ cache, discover: async () => ({ fetchedAt: now, rows: [] }) });
		assert.deepEqual(await prepared.prepare(input), []);
		assert.deepEqual(prepared.catalog?.rows, []);
	});

	test("fails explicitly without eligible cache, network, or host OAuth", async () => {
		await assert.rejects(controller().prepare({ ...input, allowNetwork: false }), (error: Error) => error instanceof CursorError && error.code === "DiscoveryFailed");
		await assert.rejects(controller().prepare({ ...input, hostCredential: undefined }), (error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
	});

	test("forwards a host timeout through the sole live discovery and publishes nothing", async () => {
		const cache = new MemoryCache();
		const host = new AbortController();
		let discoveries = 0;
		let discoveryStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
		const prepared = controller({ cache, discover: (_accessToken, _requestId, signal) => new Promise((_resolve, reject) => {
			assert.ok(signal);
			discoveries += 1;
			discoveryStarted?.();
			signal.addEventListener("abort", () => reject(new Error("synthetic discovery cancelled")), { once: true });
		}) });
		const preparing = prepared.prepare({ ...input, signal: host.signal });
		await started;
		host.abort();
		await assert.rejects(preparing, /synthetic discovery cancelled/u);
		assert.equal(discoveries, 1);
		assert.equal(prepared.catalog, null);
		assert.equal(cache.saves.length, 0);
	});

	test("uses opaque host OAuth only for live runtime models and bypasses cache/persistence", async () => {
		const cache = new MemoryCache();
		const prepared = controller({ cache });
		const models = await prepared.prepare({
			...input,
			hostCredential: { type: "oauth", access: "opaque-access", refresh: "opaque-refresh", expires: now + 10_000 },
		});
		assert.equal(models[0]?.id, "live");
		assert.equal(models[0]?.providerReference.selection, undefined);
		assert.equal(cache.loadQueries.length, 0);
		assert.equal(cache.saves.length, 0);
	});

	test("validates the whole discovered catalog before publishing or saving", async () => {
		const cache = new MemoryCache();
		const prepared = controller({ cache, discover: async () => ({
			fetchedAt: now,
			rows: [{ modelId: "valid", maxMode: false }, { modelId: "", maxMode: true }],
		}) });
		await assert.rejects(() => prepared.prepare(input), CursorError);
		assert.equal(prepared.catalog, null);
		assert.equal(cache.saves.length, 0);
	});

	test("fences slow N after N+1 even when discovery ignores abort", async () => {
		const resolvers: Array<(result: CursorDiscoveryResult) => void> = [];
		const prepared = controller({ discover: () => new Promise((resolve) => resolvers.push(resolve)) });
		const stale = prepared.prepare(input);
		const fresh = prepared.prepare({ ...input, credentialGeneration: 2 });
		resolvers[1]?.({ fetchedAt: now, rows: [{ modelId: "fresh", maxMode: true }] });
		assert.deepEqual((await fresh).map((model) => model.id), ["fresh"]);
		resolvers[0]?.({ fetchedAt: now, rows: [{ modelId: "stale", maxMode: false }] });
		await assert.rejects(stale, (error: Error) => error instanceof CursorError && error.code === "StaleGeneration");
		assert.deepEqual(prepared.catalog?.rows.map((row) => row.modelId), ["fresh"]);
	});

	test("fences host credential mutation without requiring a replacement prepare call", async () => {
		let resolveDiscovery: ((result: CursorDiscoveryResult) => void) | undefined;
		let hostCurrent = true;
		const prepared = controller({ discover: () => new Promise((resolve) => { resolveDiscovery = resolve; }) });
		const stale = prepared.prepare({ ...input, isCurrentGeneration: () => hostCurrent });
		hostCurrent = false;
		resolveDiscovery?.({ fetchedAt: now, rows: [{ modelId: "stale", maxMode: false }] });
		await assert.rejects(stale, (error: Error) => error instanceof CursorError && error.code === "StaleGeneration");
		assert.equal(prepared.catalog, null);
	});

	test("fences account, provider, client changes and disposal", async () => {
		for (const mutation of ["account", "provider", "client", "dispose"] as const) {
			const resolvers: Array<(result: CursorDiscoveryResult) => void> = [];
			let version = "client-v1";
			const prepared = controller({
				clientVersion: () => version,
				discover: () => new Promise((resolve) => { resolvers.push(resolve); }),
			});
			const stale = prepared.prepare(input);
			if (mutation === "account") void prepared.prepare({ ...input, hostCredential: credential("auth0|other"), credentialGeneration: 2 }).catch(() => undefined);
			if (mutation === "provider") void prepared.prepare({ ...input, providerInstanceGeneration: 2 }).catch(() => undefined);
			if (mutation === "client") version = "client-v2";
			if (mutation === "dispose") prepared.dispose();
			resolvers[0]?.({ fetchedAt: now, rows: [{ modelId: "stale", maxMode: false }] });
			await assert.rejects(stale, CursorError);
			assert.equal(prepared.catalog, null);
		}
	});

	test("request leases own the full generation vector and fence replacement/disposal", async () => {
		const prepared = controller();
		const [selected] = await prepared.prepare(input);
		assert.ok(selected);
		const reference = { provider: "cursor" as const, ...selected.providerReference.data };
		const lease = prepared.acquireRequestLease(reference);
		assert.doesNotThrow(() => lease.assertCurrent("request"));
		await prepared.prepare({ ...input, credentialGeneration: 2, force: true });
		assert.equal(lease.signal.aborted, true);
		assert.throws(() => lease.assertCurrent("stream"), (error: Error) => error instanceof CursorError && error.code === "StaleGeneration");
		assert.throws(() => prepared.acquireRequestLease(reference), (error: Error) => error instanceof CursorError && error.code === "StaleGeneration");
		const fresh = prepared.catalog;
		assert.ok(fresh);
		const [freshModel] = (await prepared.prepare({ ...input, credentialGeneration: 3, force: true }));
		assert.ok(freshModel);
		const freshLease = prepared.acquireRequestLease({ provider: "cursor", ...freshModel.providerReference.data });
		prepared.dispose();
		assert.equal(freshLease.signal.aborted, true);
	});
});
