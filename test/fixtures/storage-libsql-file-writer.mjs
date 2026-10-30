// One of several processes writing the same libSQL `file:` database through the adapter: a plain write, a write
// inside a transaction and a read each round, the mix a workflow journal's pool sends.
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

const [url, writer, rounds] = process.argv.slice(2);
const database = await openLibsqlDatabase({ url });
const failures = [];
const attempt = async (action) => {
	try {
		await action();
	} catch (error) {
		failures.push(String(error?.cause?.message ?? error?.message ?? error).slice(0, 200));
	}
};
await attempt(() => database.exec("CREATE TABLE IF NOT EXISTS writes(writer INTEGER NOT NULL, n INTEGER NOT NULL)"));
let written = 0;
for (let n = 0; n < Number(rounds); n++) {
	await attempt(async () => {
		await database.run("INSERT INTO writes VALUES (?, ?)", Number(writer), n * 3);
		written++;
	});
	await attempt(async () => {
		await database.transaction(async (transaction) => {
			await transaction.run("INSERT INTO writes VALUES (?, ?)", Number(writer), n * 3 + 1);
			await transaction.run("INSERT INTO writes VALUES (?, ?)", Number(writer), n * 3 + 2);
		});
		written += 2;
	});
	await attempt(() => database.get("SELECT COUNT(*) AS count FROM writes"));
}
await database.close();
console.log(JSON.stringify({ writer: Number(writer), written, failures: failures.slice(0, 3), failed: failures.length }));
