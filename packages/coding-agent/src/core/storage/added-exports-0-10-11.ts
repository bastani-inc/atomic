import * as schemaCatalog from "./schema-catalog.js";
import * as statementSequence from "./statement-sequence.js";

/**
 * `noteStorageSchemaTables` and `refreshStorageSchemaCatalog` of `schema-catalog.ts`, which the copy 0.10.11-alpha.1
 * loaded lacks, and `MAX_SEQUENCE_REQUEST_STATEMENTS` of `statement-sequence.ts`, which the copies 0.10.3 and 0.10.4's
 * prereleases loaded lack. A process that loaded those copies, or 0.10.11-alpha.1's `added-exports.js`, before an
 * in-place update replaced the installation keeps them, and can load the modules that use these from the update: a
 * named import of any of them would fail to link there, so they take them from here, a path no earlier release has
 * (#6560). With 0.10.11-alpha.1's catalog, which knows nothing of fork tables, an open keeps the catalog it read, as
 * there.
 */
const catalogUpdates: Partial<Pick<typeof schemaCatalog, "noteStorageSchemaTables" | "refreshStorageSchemaCatalog">> =
	schemaCatalog;
const sequences: Partial<Pick<typeof statementSequence, "MAX_SEQUENCE_REQUEST_STATEMENTS">> = statementSequence;

export const noteStorageSchemaTables: typeof schemaCatalog.noteStorageSchemaTables =
	catalogUpdates.noteStorageSchemaTables ?? (() => {});

export const refreshStorageSchemaCatalog: typeof schemaCatalog.refreshStorageSchemaCatalog =
	catalogUpdates.refreshStorageSchemaCatalog ?? (() => {});

/** The most statements one request of a sequence carries (#6560). */
export const MAX_SEQUENCE_REQUEST_STATEMENTS: number = sequences.MAX_SEQUENCE_REQUEST_STATEMENTS ?? 256;
