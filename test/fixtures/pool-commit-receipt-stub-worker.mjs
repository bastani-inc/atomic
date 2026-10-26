// Protocol-level stand-in for a local workflow worker, forked by
// test/unit/workflow-pool-commit-usage-receipt.test.ts through LocalWorkerPool's internal `workerEntry` option.
// It claims its work, commits one session append and then one checkpoint, and records each commit receipt in
// `commit-receipts.log` next to the journal before sending the next request. Afterwards it only follows pool
// control, so the pool can close it.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const receipts = join(dirname(start.journalPath), "commit-receipts.log");

let sequence = 0;
const pending = new Map();
process.on("message", (reply) => {
	if (reply.delivery) {
		process.send({ id: 0, kind: "delivery-ack", deliveryId: reply.delivery.id });
		return;
	}
	const receiver = pending.get(reply.id);
	pending.delete(reply.id);
	if (reply.error) receiver?.reject(new Error(reply.error));
	else receiver?.resolve(reply.value);
});
process.on("disconnect", () => process.exit(1));

function request(message) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		process.send({ ...message, id }, (error) => {
			if (error) reject(error);
		});
	});
}

async function commit(label, mutation) {
	const receipt = await request({ kind: "commit", operation: `${label}-operation`, mutation });
	appendFileSync(receipts, `${JSON.stringify({ label, receipt })}\n`);
}

await request({ kind: "ready" });
while (!(await request({ kind: "claim" }))) await delay(25);
await commit("session-append", { kind: "session-append", sessionId: "session", entries: [], expectSeq: 0 });
await commit("checkpoint", {
	kind: "checkpoint",
	checkpoint: {
		kind: "tool",
		workflowId: start.root,
		checkpointId: "checkpoint",
		name: "tool",
		argsHash: "hash",
		output: null,
		completedAt: Date.now(),
	},
});
let revision = -1;
for (;;) {
	const control = await request({ kind: "control" });
	if (control.revision !== revision) {
		revision = control.revision;
		await request({ kind: "controlled", revision });
		if (control.state === "quit") process.exit(0);
	}
	await delay(25);
}
