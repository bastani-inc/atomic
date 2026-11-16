import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openLibsqlDatabase } = await jiti.import(fileURLToPath(new URL("./storage-libsql-wrapper.ts", import.meta.url)));

async function finalizeDiscardedStatements() {
	globalThis.gc();
	await new Promise((resolve) => setImmediate(resolve));
}

const directory = mkdtempSync(join(tmpdir(), "libsql-wrapper-close-once-"));
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
		await finalizeDiscardedStatements();
		const [first, second] = round === 0 ? [root, host] : [host, root];
		await first.close();
		await finalizeDiscardedStatements();
		await second.close();
		await finalizeDiscardedStatements();
		raw.close();
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
process.stdout.write("closed\n");
