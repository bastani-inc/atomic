import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const shards = JSON.parse(process.argv[2]);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const { ShipShard } = await jiti.import(
	fileURLToPath(new URL("../../packages/workflows/src/workers/ship-shard.ts", import.meta.url)),
);

const opened = [];
for (const { path, root, work, readOnly, uri } of shards) {
	if (readOnly === true) {
		const target = uri === true ? pathToFileURL(path).href : path;
		const database = await openNodeSqliteDatabase(target, { readOnly: true });
		await database.get("SELECT COUNT(*) AS n FROM ship_rows");
		opened.push(database);
		continue;
	}
	const shard = await ShipShard.open(path, root);
	opened.push(shard);
	if (work === undefined) continue;
	const lease = { id: work, generation: 1, worker: "crashed-host/1", epoch: 1 };
	await shard.hold(lease, 3_600_000);
	await shard.accept(root, lease, `scope:${work}`, JSON.stringify({ unshipped: work }), 1);
}
process.stdout.write(`${JSON.stringify({ ready: process.pid, opened: opened.length })}\n`);
setInterval(() => {}, 60_000);
