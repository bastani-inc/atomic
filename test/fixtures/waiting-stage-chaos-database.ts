/**
 * The database the waiting-stage chaos fixtures share (#4309): `ATOMIC_CHAOS_DB_URL` is a libSQL URL (`libsql:`,
 * `https:` or `file:`), or `node-sqlite:<path>` for Atomic's own SQLite driver, whose writers share one file through
 * its writers' queue. `ATOMIC_CHAOS_DB_TOKEN_FILE` names a file holding a libSQL token.
 */
import { readFileSync } from "node:fs";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

const NODE_SQLITE = "node-sqlite:";

export function openChaosDatabase(url: string, tokenFile: string | undefined): Promise<SqliteDatabase> {
	if (url.startsWith(NODE_SQLITE)) return openNodeSqliteDatabase(url.slice(NODE_SQLITE.length));
	return openLibsqlDatabase({
		url,
		...(tokenFile === undefined ? {} : { authToken: readFileSync(tokenFile, "utf8").trim() }),
	});
}
