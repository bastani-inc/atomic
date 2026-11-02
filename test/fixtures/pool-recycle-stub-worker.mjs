// Protocol-level stand-in for a local workflow worker (packages/workflows/src/workers/protocol.ts), forked through
// LocalWorkerPool's internal `workerEntry` option. The first ATOMIC_TEST_RECYCLES workers the pool starts each report
// that they end between children for their memory (`recycle`), as a worker past `maxWorkerRssBytes` does, and exit
// cleanly; `recycles` beside the journal counts them. Every later worker claims the root's child and completes it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const recycles = Number(process.env.ATOMIC_TEST_RECYCLES ?? "5");
const counter = join(dirname(start.journalPath), "recycles");
const CHECKPOINT_EVENT = "CheckpointRecorded";

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
let recycled = false;
process.on("disconnect", () => process.exit(recycled ? 0 : 1));

function request(message) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		process.send({ ...message, id }, (error) => {
			if (error) reject(error);
		});
	});
}

/** The child run the root's boundary start names for this work's scope. */
function childRunId(work) {
	const journal = new DatabaseSync(start.journalPath, { readOnly: true, timeout: 60_000 });
	try {
		const row = journal
			.prepare("SELECT payload FROM wf_events WHERE run_id = ? AND key = ?")
			.get(start.root, JSON.stringify([CHECKPOINT_EVENT, "stage", `boundary-start:${work.scope}`]));
		if (!row) throw new Error(`Boundary start for ${work.scope} is not journaled`);
		return JSON.parse(String(row.payload)).topology.boundary.child.runId;
	} finally {
		journal.close();
	}
}

try {
	await request({ kind: "ready" });
	const ended = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
	if (ended < recycles) {
		writeFileSync(counter, String(ended + 1));
		// A pool that does not know the request refuses it; the worker ends all the same, as it would have.
		await request({ kind: "recycle", rssBytes: 1 }).catch(() => {});
		recycled = true;
		process.disconnect();
	} else {
		let controlRevision = -1;
		for (;;) {
			const control = await request({ kind: "control" });
			if (control.revision !== controlRevision) {
				controlRevision = control.revision;
				await request({ kind: "controlled", revision: control.revision });
			}
			if (control.state !== "running") {
				await delay(25);
				continue;
			}
			const work = await request({ kind: "claim" });
			if (!work) {
				await delay(25);
				continue;
			}
			await request({
				kind: "complete",
				result: { runId: childRunId(work), status: "completed", result: {}, stages: [], toolNodes: [] },
			});
		}
	}
} catch (error) {
	// Once the root finishes, its lease is released and later polls are refused. The worker stays connected and idle,
	// as a worker with no work left would, until the pool closes.
	process.stderr.write(`recycle stub worker stopped: ${error?.stack ?? error}\n`);
	await new Promise(() => {});
}
