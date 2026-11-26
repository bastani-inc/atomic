/**
 * A process that starts a staged full-session clone (#5594) and stops for good part way through, after it staged every
 * entry and the first blob, so its parent can SIGKILL it there. Prints `paused` once it stopped.
 *
 *   node --import jiti/register fork-staging-crash.ts '<json>'
 *
 * `<json>`: `{ database: { kind: "sqlite", path } | { kind: "postgres", url, password? },
 * sourcePrefix, destPrefix, sourceId, childId }`.
 */
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";

type DatabaseConfig =
	| { readonly kind: "sqlite"; readonly path: string }
	| { readonly kind: "postgres"; readonly url: string; readonly password?: string };

const config = JSON.parse(process.argv[2]!) as {
	readonly database: DatabaseConfig;
	readonly sourcePrefix: string;
	readonly destPrefix: string;
	readonly sourceId: string;
	readonly childId: string;
};

function open(database: DatabaseConfig): Promise<SqliteDatabase> {
	if (database.kind === "sqlite") return openNodeSqliteDatabase(database.path);
	return openPostgresDatabase({
		url: database.url,
		...(database.password === undefined ? {} : { password: database.password }),
	});
}

const source = await SqlSessionStore.open(await open(config.database), { prefix: config.sourcePrefix });
const dest = await SqlSessionStore.open(await open(config.database), { prefix: config.destPrefix });
let blobReads = 0;
const stopping = new Proxy(source, {
	get(target, key) {
		const value = Reflect.get(target, key, target) as unknown;
		if (key === "getBlob")
			return async (sessionId: string, hash: string) => {
				if (++blobReads === 2) {
					// Alive until the parent's SIGKILL, holding its connections, with nothing more to run.
					setInterval(() => {}, 60_000);
					process.stdout.write("paused\n");
					await new Promise<never>(() => {});
				}
				return target.getBlob(sessionId, hash);
			};
		return typeof value === "function" ? value.bind(target) : value;
	},
});
const head = await source.readEntrySizes(config.sourceId, 1, 0);
await dest.createStagedFork(
	{
		id: config.childId,
		version: SESSION_FORMAT_VERSION,
		createdAt: "2026-11-19T00:00:00.000Z",
		cwd: "/project",
		parentSessionId: config.sourceId,
	},
	completeSessionForkStream(config.sourceId, head.epoch, head.lastSeq),
	{ store: stopping, sessionId: config.sourceId, epoch: head.epoch, hashes: [], receipts: new Map() },
);
process.stdout.write("published\n");
