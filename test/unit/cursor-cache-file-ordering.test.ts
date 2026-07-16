import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCursorCredentialScope, FileCursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";

function jwtForSubject(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

describe("FileCursorCatalogCache timestamp ordering", () => {
	test("an equal-timestamp later same-scope save wins; strictly older cannot overwrite", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-cache-order-"));
		try {
			const cachePath = join(dir, "catalog.json");
			const cache = new FileCursorCatalogCache(cachePath);
			const scope = deriveCursorCredentialScope(jwtForSubject("account-order"));
			assert.ok(scope);

			assert.equal(cache.save({ source: "live", fetchedAt: 77, models: [{ id: "first", maxMode: false }] }, scope), true);
			// Same millisecond timestamp, later invocation replaces (invocation-ordered per scope).
			assert.equal(cache.save({ source: "live", fetchedAt: 77, models: [{ id: "equal-later", maxMode: true }] }, scope), true);
			assert.deepEqual(cache.load(scope), {
				source: "live",
				fetchedAt: 77,
				credentialScope: scope,
				models: [{ id: "equal-later", maxMode: true }],
			});

			// A strictly older save is rejected; a strictly newer save replaces.
			assert.equal(cache.save({ source: "live", fetchedAt: 76, models: [{ id: "strictly-older", maxMode: false }] }, scope), false);
			assert.equal(cache.load(scope)?.models[0]?.id, "equal-later");
			assert.equal(cache.save({ source: "live", fetchedAt: 78, models: [{ id: "strictly-newer", maxMode: false }] }, scope), true);
			assert.equal(cache.load(scope)?.models[0]?.id, "strictly-newer");

			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")), false);
			if (process.platform !== "win32") {
				assert.equal(statSync(`${cachePath}.${scope}`).mode & 0o777, 0o600);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a successful authoritative empty persists an ordering barrier across cache reconstruction", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-cache-empty-"));
		try {
			const cachePath = join(dir, "catalog.json");
			const scope = deriveCursorCredentialScope(jwtForSubject("account-empty"));
			assert.ok(scope);
			const first = new FileCursorCatalogCache(cachePath);
			assert.equal(first.save({ source: "live", fetchedAt: 200, models: [{ id: "must-clear", maxMode: false }] }, scope), true);
			assert.equal(first.save({ source: "live", fetchedAt: 300, models: [] }, scope), true);
			assert.equal(first.load(scope), null);
			first.clear(scope);
			assert.equal(first.load(scope), null, "explicit clear must retain the durable empty ordering marker");
			const reconstructed = new FileCursorCatalogCache(cachePath);
			assert.equal(reconstructed.save({ source: "live", fetchedAt: 100, models: [{ id: "delayed", maxMode: false }] }, scope), false);
			assert.equal(reconstructed.load(scope), null);
			const record: unknown = JSON.parse(readFileSync(`${cachePath}.${scope}`, "utf8"));
			assert.deepEqual(record, { version: 3, fetchedAt: 300, credentialScope: scope, models: [] });
			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an asynchronous successful clear is awaited before empty persistence completes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-cache-async-clear-"));
		try {
			class DeferredClearCache extends FileCursorCatalogCache {
				release: (() => void) | undefined;
				override clear(scope?: string): Promise<void> {
					return new Promise((resolve) => {
						this.release = () => { void super.clear(scope); resolve(); };
					});
				}
			}
			const cachePath = join(dir, "catalog.json");
			const cache = new DeferredClearCache(cachePath);
			const scope = deriveCursorCredentialScope(jwtForSubject("account-async-clear"));
			assert.ok(scope);
			cache.save({ source: "live", fetchedAt: 200, models: [{ id: "until-clear-settles", maxMode: false }] }, scope);
			const pending = cache.save({ source: "live", fetchedAt: 300, models: [] }, scope);
			assert.ok(pending);
			assert.equal(cache.load(scope)?.models[0]?.id, "until-clear-settles");
			assert.ok(cache.release);
			cache.release();
			assert.equal(await pending, true);
			assert.equal(cache.load(scope), null);
			const reconstructed = new FileCursorCatalogCache(cachePath);
			assert.equal(reconstructed.save({ source: "live", fetchedAt: 100, models: [{ id: "delayed", maxMode: false }] }, scope), false);
			assert.equal(reconstructed.load(scope), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a rejecting file clear falls back to a persisted non-runnable marker", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-cache-empty-marker-"));
		try {
			class RejectingClearCache extends FileCursorCatalogCache {
				override clear(): void { throw new Error("clear rejected"); }
			}
			const cachePath = join(dir, "catalog.json");
			const cache = new RejectingClearCache(cachePath);
			const scope = deriveCursorCredentialScope(jwtForSubject("account-empty-marker"));
			assert.ok(scope);
			cache.save({ source: "live", fetchedAt: 10_000, models: [{ id: "must-clear", maxMode: false }] }, scope);
			cache.save({ source: "live", fetchedAt: 2, models: [] }, scope);
			assert.equal(cache.load(scope), null);
			const record = JSON.parse(readFileSync(`${cachePath}.${scope}`, "utf8")) as { readonly models?: readonly object[] };
			assert.deepEqual(record.models, []);
			const delayedWriter = new FileCursorCatalogCache(cachePath);
			assert.equal(delayedWriter.save({ source: "live", fetchedAt: 1, models: [{ id: "delayed", maxMode: false }] }, scope), false);
			assert.equal(delayedWriter.load(scope), null, "an older positive save cannot overwrite the marker");
			assert.equal(delayedWriter.save({ source: "live", fetchedAt: 3, models: [{ id: "newer", maxMode: true }] }, scope), true);
			assert.equal(delayedWriter.load(scope)?.models[0]?.id, "newer", "a newer positive save may replace the marker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
