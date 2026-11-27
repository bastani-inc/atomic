import * as schemaCatalog from "./schema-catalog.js";

/**
 * `queueSqliteSchemaSetup` and `flushStorageSchemaSetups` of `schema-catalog.ts`, which copies loaded before #6709
 * lack. Accessed from the module namespace so a process caught by an in-place update links cleanly and falls back to
 * per-store setup transactions.
 */
const openBatch: Partial<Pick<typeof schemaCatalog, "queueSqliteSchemaSetup" | "flushStorageSchemaSetups">> =
	schemaCatalog;

export type { SqliteSchemaBatchContext, SqliteSchemaBatchSetup } from "./schema-catalog.js";

export const queueSqliteSchemaSetup: typeof schemaCatalog.queueSqliteSchemaSetup =
	openBatch.queueSqliteSchemaSetup ?? (() => false);

export const flushStorageSchemaSetups: typeof schemaCatalog.flushStorageSchemaSetups =
	openBatch.flushStorageSchemaSetups ?? (async () => {});
