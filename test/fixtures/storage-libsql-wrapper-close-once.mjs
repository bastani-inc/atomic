import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (path) => jiti.import(fileURLToPath(new URL(path, import.meta.url)));
const { openLibsqlDatabase } = await load("./storage-libsql-wrapper.ts");
const { collectReleasedLibsqlStatements, makeLibsqlDirectory, removeLibsqlDirectory } = await load(
	"../helpers/libsql-cleanup.ts",
);

const directory = makeLibsqlDirectory("libsql-wrapper-close-once-");
try {
	for (let round = 0; round < 2; round++) {
		const url = pathToFileURL(join(directory, `shared-${round}.db`)).href;
		const root = await openLibsqlDatabase({ url });
		const host = await openLibsqlDatabase({ url });
		await root.exec("CREATE TABLE IF NOT EXISTS t (x)");
		await root.run("INSERT INTO t VALUES (?)", 1);
		await host.transaction((transaction) => transaction.run("INSERT INTO t VALUES (?)", round));
		await host.all("SELECT count(*) AS n FROM t");
		await root.get("SELECT x FROM t LIMIT 1");
		const raw = createClient({ url });
		await raw.execute("SELECT count(*) FROM t");
		await collectReleasedLibsqlStatements();
		const [first, second] = round === 0 ? [root, host] : [host, root];
		await first.close();
		await collectReleasedLibsqlStatements();
		await second.close();
		await collectReleasedLibsqlStatements();
		raw.close();
	}
} finally {
	await removeLibsqlDirectory(directory);
}
process.stdout.write("closed\n");
