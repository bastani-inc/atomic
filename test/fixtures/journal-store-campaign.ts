/**
 * One workflow campaign for the journal store tests (#4325): a root that records `checkpoints` tool checkpoints with
 * no journal setting, so it uses the default journal store under `ATOMIC_CODING_AGENT_DIR`. After its first checkpoint
 * it waits until `peers` campaigns have recorded theirs, so every campaign writes while the others do. Before it exits
 * it prints which shard holds its root and which database files of the store this process took the write lock on,
 * read from the holder records next to each database: a writable connection keeps an empty record from when it opens
 * and writes to it only once it takes that database's write lock.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { isShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { sleep } from "../helpers/runtime.js";

const [directory, label, peersText, checkpointsText] = process.argv.slice(2);
assert.ok(directory && label && peersText && checkpointsText);
const peers = Number(peersText);
const checkpoints = Number(checkpointsText);
const storeDirectory = join(directory, "workflows", "journal");
const backend = await initializeDurableBackend({ cwd: directory });
assert.ok(backend instanceof JournalDurableBackend);
const journal = backend.journal;
assert.ok(isShardedRunJournal(journal), "no journal setting selects the journal store");
const runId = randomUUID();
const definition = workflow({
	name: "journal-store-campaign",
	description: "Writes checkpoints while other campaigns do",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("checkpoint-0", {}, async () => ({ label }));
		writeFileSync(join(directory, `ready-${label}`), runId);
		while (readdirSync(directory).filter((name) => name.startsWith("ready-")).length < peers) await sleep(10);
		for (let index = 1; index < checkpoints; index++) await ctx.tool(`checkpoint-${index}`, { index }, async () => index);
		return {};
	},
});
const result = await run(definition, {}, { runId, cwd: directory, store: createStore() });
assert.equal(result.status, "completed", JSON.stringify(result));
const holders = existsSync(storeDirectory)
	? readdirSync(storeDirectory)
			.filter((name) => name.endsWith("-holders"))
			.filter((name) =>
				readdirSync(join(storeDirectory, name)).some(
					(record) =>
						record.startsWith(`${process.pid}-`) && statSync(join(storeDirectory, name, record)).size > 0,
				),
			)
			.map((name) => name.slice(0, -"-holders".length))
	: [];
const shard = journal.shardOf(runId);
console.log(JSON.stringify({ label, runId, pid: process.pid, shard: shard?.path, holders }));
await backend.close();
