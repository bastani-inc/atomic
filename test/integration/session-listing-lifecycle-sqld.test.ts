import { afterAll, describe, expect, it } from "vitest";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionListQuery,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { openSessionListingCorpus } from "../helpers/session-listing-corpus.js";
import { storageBackends } from "../helpers/storage-backends.js";

const variants: readonly { name: string; query: SessionListQuery; cached?: boolean }[] = [
	{ name: "normal", query: {} },
	{ name: "cached", query: {}, cached: true },
	{ name: "light", query: { withoutSearchText: true } },
	{ name: "project", query: { cwd: "/project" } },
	{ name: "light project", query: { cwd: "/project", withoutSearchText: true } },
];

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`session listing lifetime: ${backend.name}`, () => {
		it("preserves full and light directory matcher scheduling and the row filter (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				let active = 0;
				let peak = 0;
				const store = await SqlSessionStore.open(database, {
					prefix: scope.prefix,
					cwdMatcher: () => async (cwd) => {
						active++;
						peak = Math.max(peak, active);
						try {
							await new Promise<void>((resolve) => setImmediate(resolve));
							return cwd?.startsWith("/project/") ?? false;
						} finally {
							active--;
						}
					},
				});
				try {
					for (let index = 0; index < 129; index++)
						await store.create(
							{
								id: `s-${index}`,
								version: SESSION_FORMAT_VERSION,
								cwd: `/project/${index}`,
								createdAt: "2026-11-18T00:00:00Z",
							},
							[],
						);
					await store.create(
						{
							id: "outside",
							version: SESSION_FORMAT_VERSION,
							cwd: "/elsewhere",
							createdAt: "2026-11-18T00:00:00Z",
						},
						[],
					);
					for (const withoutSearchText of [false, true]) {
						peak = 0;
						const ids: string[] = [];
						for await (const summary of store.list({ cwd: "/project", withoutSearchText })) ids.push(summary.id);
						expect(ids).toEqual(Array.from({ length: 129 }, (_, index) => `s-${index}`));
						if (withoutSearchText) expect(peak).toBeLessThanOrEqual(64);
						else expect(peak).toBe(130); // An ordinary scope resolves the distinct names together.
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("bounds open-marker catalog responses for a session shared by several hosts (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
				try {
					const host = "x".repeat(2_000_000);
					for (let index = 0; index < 6; index++)
						await store.openMarkers.put("selected", { token: `token-${index}`, pid: index + 1, host });
					await store.openMarkers.put("other", { token: "outside", pid: 99, host: "outside" });
					const restore = observeSqlReads(database, {
						after: (rows) => {
							const bytes = rows.reduce(
								(total, row) => total + (typeof row.host === "string" ? Buffer.byteLength(row.host) : 0),
								0,
							);
							if (bytes > 4 * 1024 * 1024 + Buffer.byteLength(host))
								throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
						},
					});
					try {
						const markers = await store.openMarkers.list("selected");
						expect(markers.map(({ token, pid }) => [token, pid])).toEqual(
							Array.from({ length: 6 }, (_, index) => [`token-${index}`, index + 1]),
						);
						expect(markers.every((marker) => marker.host === host && Number.isFinite(marker.ageMs))).toBe(true);
					} finally {
						restore();
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});

		let corpus: ReturnType<typeof openSessionListingCorpus> | undefined;
		afterAll(async () => {
			await (await corpus)?.scope.close();
		});
		for (const variant of variants) {
			for (const stop of ["abort", "close"] as const) {
				it(`${variant.name} listing starts no further read after ${stop} at a page boundary (#5537)`, async () => {
					corpus ??= openSessionListingCorpus(backend);
					const fixture = await corpus;
					const { scope, table } = fixture;
					const database = await scope.connect();
					let restoreRevision = false;
					try {
						expect(await fixture.state(database)).toEqual(fixture.original);
						const store = await SqlSessionStore.open(database, {
							prefix: scope.prefix,
							cwdMatcher: () => (cwd) => cwd?.startsWith("/project") ?? false,
						});
						let closed = false;
						try {
							const collect = async (query: SessionListQuery) => {
								let count = 0;
								for await (const _summary of store.list(query)) count++;
								return count;
							};
							if (variant.cached) {
								expect(await collect(variant.query)).toBe(5_001);
								restoreRevision = true;
								await database.run(`UPDATE ${table} SET revision = 'changed' WHERE id = 'seed'`);
							}
							const controller = new AbortController();
							const reason = new Error("listing cancelled");
							const all = database.all.bind(database);
							let stopped = false;
							let readsAfterStop = 0;
							database.all = async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
								if (stopped) readsAfterStop++;
								const rows = await all<Row>(sql, ...params);
								if (!stopped && rows.some((row) => typeof row.cwd === "string")) {
									stopped = true;
									if (stop === "abort") controller.abort(reason);
									else {
										closed = true;
										await store.close();
									}
								}
								return rows;
							};
							try {
								const listing = collect({ ...variant.query, signal: controller.signal });
								if (stop === "abort") await expect(listing).rejects.toBe(reason);
								else await expect(listing).rejects.toBeInstanceOf(StoreClosedError);
								expect(stopped).toBe(true);
								expect(readsAfterStop).toBe(0);
							} finally {
								database.all = all;
							}
						} finally {
							if (!closed) await store.close();
						}
					} finally {
						try {
							if (restoreRevision) {
								await database.run(
									`UPDATE ${table} SET revision = ? WHERE id = 'seed'`,
									fixture.original.revision,
								);
								expect(await fixture.state(database)).toEqual(fixture.original);
							}
						} finally {
							await database.close();
						}
					}
				});
			}
		}
	});
}
