import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// One attempt of a shared pool (#4310) working through its stages' inputs, as a worker host's coordinator does, for the
// chaos tests: it takes each stage's next input under a stage lease, "processes" it, and acknowledges it. Every step goes
// to the log, one line each, so the test can check what happened after it killed, stopped or skewed this process.
const [url, prefix, root, attemptJson, log, leaseMs, processMs] = process.argv.slice(2);
const attempt = JSON.parse(attemptJson);
const jiti = createJiti(import.meta.url, { fsCache: true });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");
const { SqlRunJournal } = await load("../../packages/workflows/src/durable/journal/sql-run-journal.ts");
const { openSqlPoolQueue } = await load("../../packages/workflows/src/durable/journal/sql-pool-queue.ts");
const { SqlSharedPool } = await load("../../packages/workflows/src/durable/journal/sql-shared-pool.ts");
const { isStaleStageLeaseError } = await load("../../packages/workflows/src/workers/placement-errors.ts");

const write = (line) => appendFileSync(log, `${line} ${process.pid} ${Date.now()}\n`);
const database = await openLibsqlDatabase({ url });
const journal = await SqlRunJournal.open(database, { prefix });
const queue = await openSqlPoolQueue(journal);
const shared = await SqlSharedPool.open(journal, queue);
const state = await journal.leaseState(root);
const lease = { runId: root, holderId: state.holderId, epoch: state.epoch };
write("ready");
let declined = 0;
try {
	for (;;) {
		const stages = await shared.stagesWithInputs(root, [attempt.id]);
		if (stages.length === 0) break;
		for (const stage of stages) {
			const taken = await shared.takeStageInput(lease, attempt, stage, Number(leaseMs));
			if (taken === undefined) {
				write(`declined ${attempt.id} ${stage.stageId}`);
				declined++;
				continue;
			}
			write(`took ${attempt.id} ${taken.stageId} ${taken.seq} ${taken.token}`);
			await delay(Number(processMs));
			await shared.ackStageInput(lease, taken, JSON.stringify({ pid: process.pid }));
			write(`acked ${attempt.id} ${taken.stageId} ${taken.seq} ${taken.token}`);
		}
		await delay(5);
	}
	write(`done ${declined}`);
} catch (error) {
	if (!isStaleStageLeaseError(error)) throw error;
	write(`refused ${error.code} ${error.reason} ${error.stageId} ${error.seq}`);
} finally {
	await journal.close();
	await database.close();
}
