// Two libSQL adapter databases over one file, as a workflow root and a worker host in one process open a shared
// journal: statements, an exec, a transaction and a batch on each, then both closed, in one order and then the other.
// Each close runs collections that finalize the other database's statements, so the second close finds none holding
// its connection. Prints "closed" once every database closed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

const directory = mkdtempSync(join(tmpdir(), "libsql-close-once-"));
try {
	for (let round = 0; round < 2; round++) {
		const url = pathToFileURL(join(directory, `shared-${round}.db`)).href;
		const root = await openLibsqlDatabase({ url });
		const host = await openLibsqlDatabase({ url });
		await root.exec("CREATE TABLE IF NOT EXISTS t (x)");
		await root.batch([{ sql: "INSERT INTO t VALUES (?)", params: [1] }]);
		await host.transaction((transaction) => transaction.run("INSERT INTO t VALUES (?)", round));
		await host.all("SELECT count(*) AS n FROM t");
		await root.get("SELECT x FROM t LIMIT 1");
		const [first, second] = round === 0 ? [root, host] : [host, root];
		await first.close();
		await second.close();
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
process.stdout.write("closed\n");
