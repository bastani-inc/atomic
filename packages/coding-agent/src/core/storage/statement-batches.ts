import type { SqliteExecutor } from "./database.js";
import * as migrations from "./migrations.js";
import * as statementSequence from "./statement-sequence.js";

/**
 * `applyStorageMigrationsTogether` of `migrations.ts` and `statementBatch` of `statement-sequence.ts`, which 0.10.3's
 * copies of those modules lack. A process that loaded those copies before an update replaced the installation keeps
 * them, and can load the modules that batch statements from the update: a named import of either would fail to link
 * there, so they take both from here. Without them each domain migrates, and each statement runs, in turn, as that
 * release ran them: its connection thread runs SQL text of several statements sent in one request as only the first.
 */
const migrationsTogether: Partial<Pick<typeof migrations, "applyStorageMigrationsTogether">> = migrations;
const batches: Partial<Pick<typeof statementSequence, "statementBatch">> = statementSequence;

export const applyStorageMigrationsTogether: typeof migrations.applyStorageMigrationsTogether =
	migrationsTogether.applyStorageMigrationsTogether ??
	(async (database, domains) => {
		const results: migrations.StorageMigrationResult[] = [];
		for (const { domain, steps, options } of domains)
			results.push(await migrations.applyStorageMigrations(database, domain, steps, options));
		return results;
	});

export const statementBatch: typeof statementSequence.statementBatch = batches.statementBatch ?? statementsInTurn;

/** `statementBatch` where the copy of `statement-sequence.ts` a process holds lacks it: each statement in turn. */
async function statementsInTurn<const Reads extends readonly (() => Promise<unknown>)[]>(
	executor: SqliteExecutor,
	writes: readonly statementSequence.BatchWrite[],
	reads: Reads,
): Promise<{ -readonly [K in keyof Reads]: Awaited<ReturnType<Reads[K]>> }> {
	for (const write of writes) {
		if (write === false || write === undefined) continue;
		if (typeof write === "string") await executor.exec(write);
		else await executor.run(write.sql, ...write.params);
	}
	const values: unknown[] = [];
	for (const read of reads) values.push(await read());
	return values as { -readonly [K in keyof Reads]: Awaited<ReturnType<Reads[K]>> };
}
