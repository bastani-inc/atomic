// Protocol-level stand-in for a local workflow worker (packages/workflows/src/workers/protocol.ts), forked through
// LocalWorkerPool's internal `workerEntry` option. It claims children and runs them by their `mode` input: a `waits`
// child publishes its one stage as waiting released for a tool result, as a worker does every so often, renews its
// lease, and completes once `gate` exists; a `holds` child renews its lease and completes once `gate` exists, publishing
// nothing; a `quick` child completes at once. A worker ends cleanly once a claim reply retires it.
//
// Every step is appended to the file ATOMIC_TEST_WAITING_LOG names, as one JSON line: `ready`, `claimed`, `completing`
// and `retired`, with the worker's pid. With ATOMIC_TEST_WAITING_FAIL_FROM set to n, the n-th worker the pool starts and
// every later one exit before they are ready; with ATOMIC_TEST_WAITING_EXIT_AFTER_READY set to n, the n-th worker exits,
// as a crash, right after it is ready, before it claims anything.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const log = process.env.ATOMIC_TEST_WAITING_LOG;
const failFrom = Number(process.env.ATOMIC_TEST_WAITING_FAIL_FROM ?? "0");
const exitAfterReady = Number(process.env.ATOMIC_TEST_WAITING_EXIT_AFTER_READY ?? "0");
let sequence = 0;
let retired = false;
const pending = new Map();
process.on("message", (reply) => {
	if (reply.delivery) {
		process.send({ id: 0, kind: "delivery-ack", deliveryId: reply.delivery.id });
		return;
	}
	if (reply.kind !== undefined) return;
	if (reply.retire) retired = true;
	const receiver = pending.get(reply.id);
	pending.delete(reply.id);
	if (reply.error) receiver?.reject(new Error(reply.error.message ?? String(reply.error)));
	else receiver?.resolve(reply.value);
});
process.on("disconnect", () => process.exit(retired ? 0 : 1));

function request(message) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		process.send({ ...message, id }, (error) => {
			if (error) reject(error);
		});
	});
}

function record(event, extra = {}) {
	if (log !== undefined) appendFileSync(log, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
}

/** The child's run as a worker publishes it: one stage, waiting released for a tool result. */
function waitingRun(work) {
	const now = Date.now();
	return {
		id: work.childRunId,
		name: "pool-waiting-child",
		inputs: work.inputs,
		status: "running",
		parentRunId: start.root,
		parentStageId: work.boundaryId,
		rootRunId: start.root,
		startedAt: now,
		toolNodes: [],
		stages: [
			{
				id: `stage-${work.inputs.index}`,
				name: "wait",
				status: "waiting",
				parentIds: [],
				toolEvents: [],
				startedAt: now,
				sessionId: `session-${work.inputs.index}`,
				wait: { kind: "tool", since: now, toolCalls: [{ toolCallId: "wait-1", toolName: "bash" }] },
			},
		],
	};
}

let started = 0;
if (log !== undefined) {
	appendFileSync(`${log}.starts`, "x");
	started = readFileSync(`${log}.starts`, "utf8").length;
}
if (failFrom > 0 && started >= failFrom) process.exit(1);

try {
	await request({ kind: "ready" });
	record("ready");
	if (started === exitAfterReady) process.exit(1);
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
			if (retired) {
				record("retired");
				process.disconnect();
				break;
			}
			await delay(25);
			continue;
		}
		const { index, mode, gate } = work.inputs;
		record("claimed", { index });
		while (mode !== "quick" && !existsSync(gate)) {
			if (mode === "waits") await request({ kind: "activity", runs: [waitingRun(work)] });
			await request({ kind: "heartbeat", reports: [] });
			await delay(100);
		}
		record("completing", { index });
		await request({
			kind: "complete",
			result: { runId: work.childRunId, status: "completed", result: { index }, stages: [], toolNodes: [] },
		});
	}
} catch (error) {
	// Once the root finishes, its lease is released and later polls are refused. The worker stays connected and idle,
	// as a worker with no work left would, until the pool closes.
	process.stderr.write(`waiting stub worker stopped: ${error?.stack ?? error}\n`);
	await new Promise(() => {});
}
