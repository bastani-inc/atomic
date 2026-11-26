import type { SqliteTransactionOptions } from "../database.js";

/**
 * A write to the rows of the session `sessionId` of the sessions table `sessions`: on Postgres it is the only writer of
 * that session, while writers of other sessions run beside it; SQLite runs every write alone anyway. Every writer of a
 * session's rows names this one domain, whatever table it writes (the session store, its chat records, its search
 * index), so the checks each makes against the session's row hold until it commits. A transient failure runs it again
 * (#4383).
 */
export function sessionWriteTransaction(sessions: string, sessionId: string): SqliteTransactionOptions {
	return { retryTransientFailures: true, concurrency: { kind: "serial", domain: `${sessions}:${sessionId}` } };
}
