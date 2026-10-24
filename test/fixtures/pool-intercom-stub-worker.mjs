// Protocol-level stand-in for a local workflow worker, forked by the pooled Intercom fan-out
// test (test/integration/workflow-pool-intercom-owner.test.ts). It speaks the real worker IPC
// protocol (packages/workflows/src/workers/protocol.ts) and follows the order a real worker
// follows when an Intercom-capable agent stage starts: publish the stage, take the root's
// pending-stage route, then start the stage session. The stage session itself, with the real
// Intercom extension, runs in the test process: the stub hands it the route capability over a
// local socket the moment the route request returns, and waits for the stage to finish its
// Intercom calls before it completes the claimed work.
//
// It loads only Node built-ins so that 150 of them stay cheap.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const config = JSON.parse(readFileSync(join(dirname(start.journalPath), "fanout-config.json"), "utf8"));
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

let claimed;

function fail(error) {
	process.stderr.write(`intercom fan-out stub worker failed: ${error?.stack ?? error}\n`);
	appendFileSync(config.failureLog, `pid ${process.pid} work ${claimed ?? "none"}: ${error?.message ?? error}\n`);
	process.exit(1);
}

let controlRevision = -1;
let busy = false;
async function observeControl() {
	const control = await request({ kind: "control" });
	if (control.revision === controlRevision) return control;
	controlRevision = control.revision;
	if (control.state !== "quit" || !busy) await request({ kind: "controlled", revision: control.revision });
	return control;
}

/** Hands the stage to the test process and resolves once its Intercom calls are done. */
function runStage(stage) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(config.stageSocket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify(stage)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.end();
			resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
		});
		socket.once("error", reject);
	});
}

const journal = new DatabaseSync(start.journalPath, { readOnly: true, timeout: 60_000 });
const boundaryStart = journal.prepare("SELECT payload FROM wf_events WHERE run_id = ? AND key = ?");

async function perform(work) {
	busy = true;
	claimed = work.id;
	const root = start.root;
	const row = boundaryStart.get(root, JSON.stringify([CHECKPOINT_EVENT, "stage", `boundary-start:${work.scope}`]));
	if (!row) throw new Error(`Boundary start for ${work.scope} is not journaled`);
	const run = { ...JSON.parse(String(row.payload)).topology.boundary.child };
	const startedAt = Date.now();
	const stageId = randomUUID();
	const sessionId = randomUUID();
	let stageStatus = "running";
	const stage = () => ({
		id: stageId,
		name: "agent",
		status: stageStatus,
		parentIds: [],
		executionOrder: 1,
		startedAt,
		...(stageStatus === "completed" ? { endedAt: Date.now(), result: "done" } : {}),
		replayKey: "agent",
		sessionId,
		pendingStageDeliveryAvailable: true,
		model: "fixture/fanout-model",
		toolEvents: [],
	});
	const snapshot = () => ({
		id: run.runId,
		name: run.runName,
		inputs: work.inputs,
		status: "running",
		stages: [stage()],
		toolNodes: [],
		startedAt,
		parentRunId: run.parentRunId,
		parentStageId: run.parentStageId,
		rootRunId: root,
		phase: "executing",
		phaseStartedAt: startedAt,
		lastProgressAt: Date.now(),
	});

	let renewal;
	let controlPulse;
	const heartbeat = setInterval(() => {
		renewal ??= request({ kind: "renew" })
			.catch(fail)
			.finally(() => {
				renewal = undefined;
			});
		controlPulse ??= observeControl()
			.catch(fail)
			.finally(() => {
				controlPulse = undefined;
			});
	}, config.heartbeatMs);

	await request({ kind: "activity", runs: [snapshot()] });
	// A test that holds route registration learns from this log when every stage is waiting for its route.
	if (config.routeLog) appendFileSync(config.routeLog, `${run.runId}\n`);
	const capability = await request({ kind: "route", runId: run.runId });
	if (typeof capability !== "string") throw new Error("Root pending-stage route is unavailable");
	await runStage({ runId: run.runId, stageId, stageName: "agent", sessionId, capability });

	clearInterval(heartbeat);
	await renewal;
	await controlPulse;
	stageStatus = "completed";
	await observeControl();
	await request({
		kind: "complete",
		result: { runId: run.runId, status: "completed", result: {}, stages: [stage()], toolNodes: [] },
	});
	busy = false;
}

let performed = 0;
try {
	await request({ kind: "ready" });
	for (;;) {
		let work;
		try {
			const control = await observeControl();
			if (control.state !== "running") {
				await delay(25);
				continue;
			}
			work = await request({ kind: "claim" });
		} catch (error) {
			// Once the root run ends it releases its lease and refuses further polls as stale; a
			// worker whose work is done stays connected and idle until the test closes the pool.
			if (performed === 0) throw error;
			break;
		}
		if (!work) {
			await delay(25 + Math.random() * 25);
			continue;
		}
		await perform(work);
		performed++;
	}
} catch (error) {
	fail(error);
}
