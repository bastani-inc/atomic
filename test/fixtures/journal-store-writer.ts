/**
 * A writer process for the journal store chaos tests (#4325). `router` opens the journal store in a directory and
 * writes its own root there; `shard` opens one shard file directly, as a pool worker opens its root's shard. Each
 * writer appends `count` keyed checkpoints to its run under a lease named after the run, so a writer restarted after
 * SIGKILL takes its lease back and appends the same keys again. Prints `progress <n>` after each append and a JSON
 * summary at the end: how many appends wrote a row, how many found their key already written, and the longest wait.
 * With `barrier` and `peers`, a writer holding its lease waits until `peers` writers have marked `barrier`, so they all
 * write while the others do.
 */
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";

const [mode, target, runId, countText, barrier, peersText] = process.argv.slice(2);
assert.ok((mode === "router" || mode === "shard") && target && runId && countText);
const count = Number(countText);
const journal: RunJournal =
	mode === "router"
		? await openSelectedRunJournal({ kind: "sharded", dir: target }, dirname(target))
		: await openSqlRunJournal(target);
await journal.createRun({ runId, name: "chaos-writer", cwd: dirname(target), createdAt: Date.now(), status: "running" });
const holder = `writer:${runId}`;
const outcome = await journal.acquire(runId, holder);
assert.equal(outcome.status, "acquired", JSON.stringify(outcome));
if (outcome.status !== "acquired") process.exit(2);
if (barrier !== undefined) {
	writeFileSync(join(barrier, runId), "");
	while (readdirSync(barrier).length < Number(peersText)) await delay(10);
}
let appended = 0;
let existed = 0;
let maxWaitMs = 0;
for (let index = 0; index < count; index++) {
	const started = performance.now();
	const result = await journal.append(
		outcome.lease,
		{ type: "CheckpointRecorded", payload: { kind: "tool", index, writer: runId } },
		{ key: `checkpoint-${index}` },
	);
	maxWaitMs = Math.max(maxWaitMs, performance.now() - started);
	if (result.status === "appended") appended++;
	else existed++;
	process.stdout.write(`progress ${index + 1}\n`);
}
await journal.append(outcome.lease, { type: "StatusChanged", payload: { status: "completed" } }, { key: "finished" });
await journal.release(outcome.lease);
await journal.close();
process.stdout.write(`${JSON.stringify({ runId, appended, existed, maxWaitMs })}\n`);
