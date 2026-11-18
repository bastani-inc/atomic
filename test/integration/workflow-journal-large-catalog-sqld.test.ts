import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * A workflow journal of many runs lists every run's version on every backend of test/helpers/storage-backends.ts: a
 * SQLite file always, sqld and Postgres when their URLs are set (#5480). A server returns them all from one statement.
 */

/** Runs in the catalog: far more arguments than one JavaScript call takes. */
const CATALOG_RUNS = 150_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (closers.length > 0) await closers.pop()!();
});

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`a large workflow catalog on ${name} (#5480)`, () => {
		test("every run of a catalog of 150,000 runs has its version listed (#5480)", async () => {
			const scope = await backend.openScope();
			closers.push(() => scope.close());
			const database = await scope.connect();
			const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
			closers.push(() => journal.close());
			const { runs } = runJournalTables(scope.prefix);
			await database.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CATALOG_RUNS})
					INSERT INTO ${runs}(run_id, name, cwd, created_at, status, header_json)
					SELECT 'run-' || i, 'run', '/project', 1, 'running',
						'{"runId":"run-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}'
					FROM n`,
			);
			const versions = await journal.runVersions();
			assert.equal(versions.size, CATALOG_RUNS);
			assert.deepEqual(versions.get(`run-${CATALOG_RUNS}`), { seq: 0, at: 0 });
		});
	});
}
