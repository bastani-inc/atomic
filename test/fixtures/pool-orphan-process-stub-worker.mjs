// Protocol-level stand-in for a local workflow worker whose first attempt dies while one of
// its managed tool process groups is still running (#3986). It is forked through
// LocalWorkerPool's internal `workerEntry` option and speaks the real worker IPC protocol
// (packages/workflows/src/workers/protocol.ts).
//
// First attempt of the child with input index 0: take a real process permit from the worker's SqlResourceAdmission, bind it to a
// detached `sleep` process group, record that group, then SIGKILL itself so the group outlives it. With
// ATOMIC_TEST_ORPHAN_MODE=stall it goes silent instead, so stalled-lease recovery is what stops it. With
// ATOMIC_TEST_ORPHAN_CHILDREN=N, the first attempt of every child with index below N does the same, recording its
// group in `orphan-group-<index>` (index 0 keeps `orphan-group`).
// Its replayed attempt records whether the orphaned group was still alive when the replay was claimed.
// Every other attempt completes its child at once.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const start = JSON.parse(process.argv[2]);
const directory = dirname(start.journalPath);
const orphanChildren = Number(process.env.ATOMIC_TEST_ORPHAN_CHILDREN ?? "1");
const orphanMarker = (index) => join(directory, index === 0 ? "orphan-group" : `orphan-group-${index}`);
const replayMarker = join(directory, "replay.json");
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

function groupAlive(group) {
	try {
		process.kill(-group, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

async function orphanProcessGroup(work) {
	// Loading the admission module can outlast a short lease: keep it renewed, as a real worker's heartbeat does.
	const renewal = setInterval(() => request({ kind: "renew" }).catch(() => {}), 250);
	const jiti = createJiti(import.meta.url, { fsCache: false });
	const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
	const { resolveRunJournal } = await load("../../packages/workflows/src/durable/journal/resolution.ts");
	const { SqlResourceAdmission } = await load("../../packages/workflows/src/workers/resource-admission.ts");
	const journal = await resolveRunJournal({ journal: { path: start.journalPath } });
	const admission = await SqlResourceAdmission.open(journal, {
		...start.admission,
		root: start.root,
		holder: work.worker,
		attempt: work,
	});
	const release = await admission.acquire("process");
	const tool = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
	tool.unref();
	await release.bindProcess({ kind: "unix-process-group", id: tool.pid });
	writeFileSync(orphanMarker(work.inputs.index), String(tool.pid));
	if (process.env.ATOMIC_TEST_ORPHAN_MODE === "stall") {
		// The worker stops answering while its tool process group runs; recovery finds its lease expired and stops it.
		clearInterval(renewal);
		await new Promise(() => {});
	}
	// The worker dies while its tool process group is still running.
	process.kill(process.pid, "SIGKILL");
	await new Promise(() => {});
}

async function complete(work) {
	if (work.inputs.index === 0) {
		const group = Number(readFileSync(orphanMarker(0), "utf8"));
		writeFileSync(replayMarker, JSON.stringify({ group, orphanAliveAtReplay: groupAlive(group) }));
	}
	const journal = new DatabaseSync(start.journalPath, { readOnly: true, timeout: 60_000 });
	const row = journal
		.prepare("SELECT payload FROM wf_events WHERE run_id = ? AND key = ?")
		.get(start.root, JSON.stringify([CHECKPOINT_EVENT, "stage", `boundary-start:${work.scope}`]));
	journal.close();
	if (!row) throw new Error(`Boundary start for ${work.scope} is not journaled`);
	const run = JSON.parse(String(row.payload)).topology.boundary.child;
	await observeControl();
	await request({
		kind: "complete",
		result: { runId: run.runId, status: "completed", result: {}, stages: [], toolNodes: [] },
	});
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
		if (work.inputs.index < orphanChildren && !existsSync(orphanMarker(work.inputs.index)))
			await orphanProcessGroup(work);
		await complete(work);
	}
} catch (error) {
	// Once the root finishes, its lease is released and later polls are refused as stale. The worker reports
	// the error and stays connected and idle, as a worker with no work left would, until the pool closes.
	process.stderr.write(`orphan stub worker stopped: ${error?.stack ?? error}\n`);
	await new Promise(() => {});
}
