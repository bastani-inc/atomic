import type { FencedPathId, SqliteTransactionOptions, TransactionConcurrency } from "../../src/core/storage/index.js";
import { fencedPath } from "../../src/core/storage/index.js";

// A fenced transaction names an audited path (#4793): only `fencedPath(name)` mints a `FencedPathId`.
export const serial: TransactionConcurrency = { kind: "serial" };
export const serialDomain: SqliteTransactionOptions = { concurrency: { kind: "serial", domain: "team_sessions" } };
// @ts-expect-error a plain string is not an audited fenced path.
export const forged: FencedPathId = "pool.commit";
// @ts-expect-error an unaudited caller cannot opt in by passing a string.
export const unaudited: TransactionConcurrency = { kind: "fenced", audit: "pool.commit" };
// @ts-expect-error only names listed in fenced-paths.ts are accepted.
export const unlisted = fencedPath("pool.commit");
// @ts-expect-error a fenced transaction names its audit.
export const anonymous: TransactionConcurrency = { kind: "fenced" };
