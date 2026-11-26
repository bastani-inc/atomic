import * as migrations from "./migrations.js";
import * as statementSequence from "./statement-sequence.js";

/**
 * `storageSchemaCurrent` and `ensureTableFillfactor` of `migrations.ts` and `transactionFinisher` of
 * `statement-sequence.ts`, which the copies of those modules (and of `statement-batches.ts`) that 0.10.3 and 0.10.4
 * loaded lack. A process that loaded those copies before an in-place update replaced the installation keeps them, and
 * can load the modules that use these from the update: a named import of any of them would fail to link there, so they
 * take them from here, a path no earlier release has (#6560). Without them every open checks its schema in a
 * transaction, tables keep their default fillfactor, and a transaction's last writes run before its `COMMIT`, as there.
 */
const schemaChecks: Partial<Pick<typeof migrations, "storageSchemaCurrent" | "ensureTableFillfactor">> = migrations;
const finishers: Partial<Pick<typeof statementSequence, "transactionFinisher" | "MAX_SEQUENCE_REQUEST_STATEMENTS">> =
	statementSequence;

export const storageSchemaCurrent: typeof migrations.storageSchemaCurrent =
	schemaChecks.storageSchemaCurrent ?? (async () => false);

export const ensureTableFillfactor: typeof migrations.ensureTableFillfactor =
	schemaChecks.ensureTableFillfactor ?? (async () => {});

export const transactionFinisher: typeof statementSequence.transactionFinisher =
	finishers.transactionFinisher ?? (() => undefined);

/**
 * `MAX_SEQUENCE_REQUEST_STATEMENTS` of `statement-sequence.ts`, which the copies 0.10.3 and 0.10.4's prereleases loaded
 * lack: the most statements one request of a sequence carries (#6560).
 */
export const MAX_SEQUENCE_REQUEST_STATEMENTS: number = finishers.MAX_SEQUENCE_REQUEST_STATEMENTS ?? 256;
