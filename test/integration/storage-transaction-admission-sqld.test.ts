import assert from "node:assert/strict";
import { it } from "vitest";
import { fencedPath } from "../../packages/coding-agent/src/core/storage/fenced-paths.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { storageBackends } from "../helpers/storage-backends.js";

const read = { readOnly: true, retryTransientFailures: true } as const;

for (const backend of storageBackends) {
	it.skipIf(backend.skipReason)(
		`${backend.name}: a serial read sees the value before the next write (#5537)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const table = `${scope.prefix}ordered`;
				await db.exec(`CREATE TABLE ${table}(v INTEGER)`);
				await db.run(`INSERT INTO ${table} VALUES (0)`);
				for (let v = 0; v < 10; v++) {
					const first = db.transaction((tx) => tx.get(`SELECT v FROM ${table}`), {
						...read,
						concurrency: { kind: "serial" },
					});
					const next = db.run(`UPDATE ${table} SET v = ?`, v + 1);
					const [row] = await Promise.all([first, next]);
					assert.equal(row?.v, v);
				}
			} finally {
				await scope.close();
			}
		},
	);
}

it.skipIf(postgresSkipReason)(
	"a serial call waits for a slow read on a one-connection Postgres pool (#5537)",
	async () => {
		await withPostgresDatabase(async ({ open }) => {
			const db = await open({ maxConnections: 1, statementTimeoutMs: 30_000 });
			const acquired = Promise.withResolvers<void>();
			const slow = db.transaction(async (tx) => {
				await tx.get("SELECT 1");
				acquired.resolve();
				// Longer than the pool checkout deadline, but shorter than the query deadline.
				return tx.get("SELECT 11 AS v FROM pg_sleep(13)");
			}, read);
			await Promise.race([acquired.promise, slow]);
			const next = db.transaction((tx) => tx.get("SELECT 22 AS v"));
			assert.deepEqual(await Promise.all([slow, next]), [{ v: 11 }, { v: 22 }]);
		});
	},
	40_000,
);

it.skipIf(postgresSkipReason)(
	"a fenced Postgres read finishes on a free connection while the serial transaction is open (#5537)",
	async () => {
		await withPostgresDatabase(async ({ open }) => {
			const db = await open({ maxConnections: 2 });
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let released = false;
			const incumbent = db.transaction(async (tx) => {
				await tx.get("SELECT 1");
				held.resolve();
				await release.promise;
				released = true;
			});
			await Promise.race([held.promise, incumbent]);
			// End the incumbent even if the second transaction is incorrectly queued behind it.
			const deadline = setTimeout(release.resolve, 5000);
			try {
				const row = await db.transaction((tx) => tx.get("SELECT 2 AS v"), {
					...read,
					concurrency: { kind: "fenced", audit: fencedPath("pool-claim") },
				});
				assert.deepEqual(row, { v: 2 });
				assert.equal(released, false);
			} finally {
				clearTimeout(deadline);
				release.resolve();
				await incumbent;
			}
		});
	},
	20_000,
);
