import assert from "node:assert/strict";
import { describe, it, test } from "vitest";
import {
	postgresDialect,
	type StorageDialect,
	type StorageTrigger,
} from "../../packages/coding-agent/src/core/storage/dialect.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { interceptingDatabase } from "../helpers/intercepting-database.js";
import { type PoolStoreScope, registerPoolStoreConformance } from "../helpers/pool-store-conformance.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * The worker pool on PostgreSQL under the longest prefix it accepts (#4793): its own names, and those of the session
 * and snapshot stores it carries, fit Postgres's 63-byte identifiers, either whole or ending in a hash of the whole
 * name, and never truncated into one another.
 */

const postgres = storageBackends.find((backend) => backend.name === "Postgres")!;
const LONG_PREFIX = `${"p".repeat(23)}_`;

async function longPrefixScope(): Promise<PoolStoreScope> {
	const scope = await postgres.openScope();
	return { ...scope, prefix: LONG_PREFIX };
}

const runner = (name: string, body: () => Promise<void>, timeoutMs?: number) =>
	postgres.skipReason === undefined ? it(name, body, timeoutMs) : it.skip(name, body);

registerPoolStoreConformance(
	runner,
	`worker pool on Postgres under a ${LONG_PREFIX.length}-character prefix`,
	longPrefixScope,
);

describe.skipIf(postgres.skipReason !== undefined)("the worker pool's Postgres identifiers (#4793)", () => {
	test("every name a pool creates under a long prefix fits whole or ends in a hash, so none is truncated", async () => {
		const scope = await longPrefixScope();
		try {
			// Every name Atomic gives the server, read from the statements that create them; Postgres names constraints
			// and sequences itself.
			const created: string[] = [];
			const database = interceptingDatabase(await scope.connect(), {
				exec: (sql, next) => {
					for (const match of sql.matchAll(
						/CREATE (?:UNIQUE INDEX|INDEX|TABLE|OR REPLACE FUNCTION|OR REPLACE TRIGGER|TRIGGER)(?: IF NOT EXISTS)? ([A-Za-z0-9_]+)/g,
					))
						created.push(match[1]!);
					return next(sql);
				},
			});
			const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
			try {
				const queue = await openSqlPoolQueue(journal);
				await openSqlPoolUsage(journal);
				await SqlSharedPool.open(journal, queue);
				await SqlFleetStore.open(journal);
				await SqlResourceAdmission.open(journal, { root: "root", holder: "holder" });
				await (await openPoolSessions(sqlPoolStorage(journal)!)).close();
			} finally {
				await journal.close();
			}
			// The snapshot store indexes the pool's tables once they exist, as the next journal to open finds them.
			await (await SqlRunJournal.open(database, { prefix: scope.prefix })).close();
			assert.ok(created.length > 40, "the pool's tables, indexes and triggers were created");
			assert.deepEqual(
				created.filter((name) => Buffer.byteLength(name) > 63),
				[],
			);
			const hashed = created.filter((name) => name.length === 63 && /_[0-9a-f]{8}$/.test(name));
			assert.ok(hashed.length > 0, "names past 63 bytes were shortened with a hash");
			// A shortened name is the one the dialect gives the whole name, which the catalog probe finds it by.
			const trigger = `${LONG_PREFIX}wf_runs_pool_root_snapshot_snapshot_carried_insert`;
			assert.ok(created.includes(postgresDialect.identifier(trigger)));
			assert.ok(created.includes(postgresDialect.identifier(`${trigger}_fn`)));
			const probe = postgresDialect.schemaObjects([trigger]);
			const reader = await scope.connect();
			assert.deepEqual(await reader.all(probe.sql, ...probe.params), [{ name: trigger }]);
		} finally {
			await scope.close();
		}
	});

	test("no two names the pool and the stores it carries ask for map to one Postgres identifier, under any sub-prefix", async () => {
		// Every name the stores hand the dialect to render, probe or drop, whole, as the stores wrote it.
		const asked = new Set<string>();
		const recording: StorageDialect = Object.freeze({
			...postgresDialect,
			renderTrigger: (trigger: StorageTrigger) => {
				asked.add(trigger.name).add(`${trigger.name}_fn`);
				return postgresDialect.renderTrigger(trigger);
			},
			dropTrigger: (name: string, table: string) => {
				asked.add(name);
				return postgresDialect.dropTrigger(name, table);
			},
			schemaObjects: (names: readonly string[]) => {
				for (const name of names) asked.add(name);
				return postgresDialect.schemaObjects(names);
			},
			tableExists: (table: string) => {
				asked.add(table);
				return postgresDialect.tableExists(table);
			},
			columnExists: (table: string, column: string) => {
				asked.add(table);
				return postgresDialect.columnExists(table, column);
			},
		});
		for (const prefix of ["", LONG_PREFIX]) {
			const scope = await postgres.openScope();
			try {
				const opened = await scope.connect();
				const database = interceptingDatabase(opened, {
					exec: (sql, next) => {
						for (const match of sql.matchAll(
							/CREATE (?:UNIQUE INDEX|INDEX|TABLE)(?: IF NOT EXISTS)? ([A-Za-z0-9_]+)/g,
						))
							asked.add(match[1]!);
						return next(sql);
					},
				});
				const withDialect = new Proxy(database, {
					get: (target, key) => (key === "dialect" ? recording : Reflect.get(target, key, target)),
				});
				const journal = await SqlRunJournal.open(withDialect, { prefix });
				try {
					const queue = await openSqlPoolQueue(journal);
					await openSqlPoolUsage(journal);
					await SqlSharedPool.open(journal, queue);
					await SqlFleetStore.open(journal);
					await SqlResourceAdmission.open(journal, { root: "root", holder: "holder" });
					await (await openPoolSessions(sqlPoolStorage(journal)!)).close();
				} finally {
					await journal.close();
				}
				await (await SqlRunJournal.open(withDialect, { prefix })).close();
			} finally {
				await scope.close();
			}
		}
		// The same names under the pool's other session sub-prefix, the one it uses where identifiers are unlimited.
		const names = new Set(asked);
		for (const name of asked) if (name.includes("wf_ps_")) names.add(name.replace("wf_ps_", "wf_runs_pool_"));
		assert.ok(
			[...names].some((name) => name.length > 63),
			"some names were long enough to be hashed",
		);
		const byIdentifier = new Map<string, string>();
		for (const name of names) {
			const identifier = postgresDialect.identifier(name);
			assert.ok(identifier.length <= 63, identifier);
			const earlier = byIdentifier.get(identifier);
			assert.equal(earlier, undefined, `${name} and ${earlier} both become ${identifier}`);
			byIdentifier.set(identifier, name);
		}
	});
});
