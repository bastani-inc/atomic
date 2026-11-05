// Takes the write lock of a journal store database mid-transaction for the chaos tests (#4325) and holds it until
// its stdin ends (then commits) or it is killed. `shard <path> <runId>` writes one uncommitted event to a run of a
// shard; `catalog <path>` writes an uncommitted shard and run to the catalog, as a placement does.
import { DatabaseSync } from "node:sqlite";

const [kind, path, runId] = process.argv.slice(2);
const database = new DatabaseSync(path);
database.exec("PRAGMA busy_timeout = 30000");
database.exec("BEGIN IMMEDIATE");
if (kind === "shard") {
	database
		.prepare(
			"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) VALUES (?, 1000000, 1, 'uncommitted', 'SummaryRecorded', 'null', 0)",
		)
		.run(runId);
} else {
	const next = Number(database.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM catalog_shards").get()?.next);
	database
		.prepare("INSERT INTO catalog_shards(id, path, kind, created_at, accepts_new_roots) VALUES (?, ?, 'native', 0, 1)")
		.run(next, `shard-${String(next).padStart(4, "0")}.sqlite`);
	database
		.prepare("INSERT INTO catalog_runs VALUES ('killed-placement', ?, 'killed-placement', NULL, NULL, 'running', 0)")
		.run(next);
}
process.stdout.write("locked\n");
process.stdin.resume();
await new Promise((resolve) => process.stdin.once("end", resolve));
database.exec("COMMIT");
database.close();
