import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const load = (path) => jiti.import(fileURLToPath(new URL(path, import.meta.url)));
const { resumeAgain } = await load("./resume-again.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { SqlRunJournal } = await load("../../packages/workflows/src/durable/journal/sql-run-journal.ts");
const { createExtensionRuntime } = await load("../../packages/workflows/src/extension/runtime.ts");
const { createJobTracker } = await load("../../packages/workflows/src/runs/background/job-tracker.ts");
const { createStore } = await load("../../packages/workflows/src/shared/store.ts");
const [id, log, outcome, prefix] = process.argv.slice(2);
const { kind, target } = JSON.parse(process.env.TEST_RESUME_JOURNAL);
const database = kind === "sqlite"
	? await (await load("../../packages/coding-agent/src/core/storage/node-sqlite.ts")).openNodeSqliteDatabase(target)
	: kind === "libsql"
		? await (await import("../../packages/storage-libsql/libsql.js")).openLibsqlDatabase({ url: target })
		: await (await import("../../packages/storage-postgres/postgres.js")).openPostgresDatabase({ url: target, password: process.env.ATOMIC_TEST_POSTGRES_PASSWORD });
try {
	const backend = await JournalDurableBackend.open(await SqlRunJournal.open(database, { prefix }));
	try {
		await backend.hydrateWorkflow(id);
		assert.equal(backend.getWorkflow(id)?.status, outcome);
		const definition = resumeAgain(log, outcome);
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({ definitions: [definition], store: createStore(), jobs });
		const result = await runtime.resumeDurableWorkflow(id, { definition, durableBackend: backend });
		assert.ok(result.ok, result.message);
		await jobs.get(id)?.promise;
		assert.equal(backend.getWorkflow(id)?.status, outcome);
	} finally {
		await backend.close();
	}
} finally {
	await database.close();
}
