import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURSOR_CATALOG_CACHE_TTL_MS,
	CURSOR_CATALOG_CACHE_VERSION,
	FileCursorCatalogCache,
	parseCursorCatalogCacheRecord,
	toCursorCatalogCacheRecord,
} from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";

const fetchedAt = 1_000;
const baseQuery = { accountScope: "cursor-account-v1:scope", clientVersion: "client-v1", catalogGeneration: 9 };
function catalog(rows: CursorModelCatalog["rows"] = []): CursorModelCatalog {
	return { ...baseQuery, fetchedAt, rows };
}

describe("Cursor scoped catalog cache", () => {
	test("uses an exact account/client/schema match immediately before but not at/after TTL", () => {
		const record = toCursorCatalogCacheRecord(catalog([{ modelId: " A ", maxMode: undefined }, { modelId: "A", maxMode: false }]));
		assert.equal(record.version, CURSOR_CATALOG_CACHE_VERSION);
		assert.equal(record.ttlMs, CURSOR_CATALOG_CACHE_TTL_MS);
		const before = parseCursorCatalogCacheRecord(record, { ...baseQuery, now: fetchedAt + CURSOR_CATALOG_CACHE_TTL_MS - 1 });
		assert.deepEqual(before?.rows, [{ modelId: " A ", maxMode: undefined }, { modelId: "A", maxMode: false }]);
		assert.equal(parseCursorCatalogCacheRecord(record, { ...baseQuery, now: fetchedAt + CURSOR_CATALOG_CACHE_TTL_MS }), null);
		assert.equal(parseCursorCatalogCacheRecord(record, { ...baseQuery, now: fetchedAt + CURSOR_CATALOG_CACHE_TTL_MS + 1 }), null);
	});

	test("keeps successful empty catalogs authoritative", () => {
		const record = toCursorCatalogCacheRecord(catalog([]));
		const loaded = parseCursorCatalogCacheRecord(record, { ...baseQuery, now: fetchedAt });
		assert.ok(loaded);
		assert.deepEqual(loaded.rows, []);
	});

	test("preserves literal secret-looking route IDs as authoritative catalog text", () => {
		const literal = ["sk", "abcdefghijklmnopqrst"].join("-");
		const record = toCursorCatalogCacheRecord(catalog([{ modelId: literal, displayName: "Bearer literal display", maxMode: false }]));
		const loaded = parseCursorCatalogCacheRecord(record, { ...baseQuery, now: fetchedAt });
		assert.deepEqual(loaded?.rows, [{ modelId: literal, displayName: "Bearer literal display", maxMode: false }]);
	});

	test("ignores exact mismatches, unsupported versions, corrupt records, and any malformed row", () => {
		const record = toCursorCatalogCacheRecord(catalog([{ modelId: "valid", maxMode: true }]));
		const query = { ...baseQuery, now: fetchedAt };
		assert.equal(parseCursorCatalogCacheRecord({ ...record, version: 1 }, query), null);
		assert.equal(parseCursorCatalogCacheRecord({ ...record, accountScope: "other" }, query), null);
		assert.equal(parseCursorCatalogCacheRecord({ ...record, clientVersion: "other" }, query), null);
		assert.equal(parseCursorCatalogCacheRecord({ ...record, rows: [...record.rows, { modelId: "", maxMode: "false" }] }, query), null);
		assert.equal(parseCursorCatalogCacheRecord({ ...record, rows: [{ modelId: "ok", maxMode: "invalid" }] }, query), null);
		for (const forbidden of [
			"accessToken", "refresh_token", "cookie", "authorization", "rawAccountId", "prompt", "requestId", "privateResponse",
			"credential", "access", "refresh", "secret", "apiKey", "password",
		]) {
			assert.equal(parseCursorCatalogCacheRecord({ ...record, [forbidden]: "secret" }, query), null);
		}
		assert.equal(parseCursorCatalogCacheRecord({ ...record, metadata: "Bearer raw-secret-value" }, query), null);
		assert.equal(parseCursorCatalogCacheRecord({ ...record, note: { nested: "bearer nested-secret" } }, query), null);
	});

	test("atomically replaces the file without persisting secrets or partial temp files", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-v2-cache-"));
		try {
			const path = join(dir, "catalog.json");
			const cache = new FileCursorCatalogCache(path, () => fetchedAt);
			cache.save(catalog([{ modelId: "route", maxMode: true }]));
			cache.save(catalog([]));
			const raw = readFileSync(path, "utf8");
			assert.doesNotMatch(raw, /token|authorization|cookie|requestId|prompt/iu);
			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".tmp")), false);
			assert.deepEqual(cache.load({ ...baseQuery, now: fetchedAt })?.rows, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rename failure preserves the prior complete target and cleans the temporary file", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-v2-cache-failure-"));
		try {
			const path = join(dir, "catalog.json");
			new FileCursorCatalogCache(path, () => fetchedAt).save(catalog([{ modelId: "old", maxMode: false }]));
			const oldTarget = readFileSync(path, "utf8");
			const failing = new FileCursorCatalogCache(path, () => fetchedAt, () => { throw new Error("injected rename failure"); });
			assert.throws(() => failing.save(catalog([{ modelId: "new", maxMode: true }])), /injected rename failure/u);
			assert.equal(readFileSync(path, "utf8"), oldTarget);
			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".tmp")), false);
			assert.deepEqual(failing.load({ ...baseQuery, now: fetchedAt })?.rows.map((row) => row.modelId), ["old"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
