// Protocol-level stand-in for a local workflow worker (packages/workflows/src/workers/protocol.ts), forked through
// LocalWorkerPool's internal `workerEntry` option. It claims a child, holds it for ATOMIC_TEST_CASCADE_HOLD_MS while
// renewing its lease as a real worker's heartbeat does, then completes it. Being cheap to start, a pool of dozens of
// them shows what the coordinator does with many workers without each one loading the workflow runtime.
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const holdMs = Number(process.env.ATOMIC_TEST_CASCADE_HOLD_MS ?? "1500");
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

let controlRevision = -1;
async function observeControl() {
	const control = await request({ kind: "control" });
	if (control.revision === controlRevision) return control;
	controlRevision = control.revision;
	await request({ kind: "controlled", revision: control.revision });
	return control;
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
	for (;;) {
		const control = await observeControl();
		if (control.state !== "running") {
			await delay(25);
			continue;
		}
		const work = await request({ kind: "claim" });
		if (!work) {
			await delay(25);
			continue;
		}
		const renewal = setInterval(() => request({ kind: "renew" }).catch(() => {}), 250);
		await delay(holdMs);
		clearInterval(renewal);
		const runId = childRunId(work);
		await observeControl();
		await request({
			kind: "complete",
			result: { runId, status: "completed", result: {}, stages: [], toolNodes: [] },
		});
	}
} catch (error) {
	// Once the root finishes, its lease is released and later polls are refused. The worker stays connected and idle,
	// as a worker with no work left would, until the pool closes.
	process.stderr.write(`cascade stub worker stopped: ${error?.stack ?? error}\n`);
	await new Promise(() => {});
}
