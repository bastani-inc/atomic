// Protocol-level stand-in for a local workflow worker (packages/workflows/src/workers/protocol.ts), forked through
// LocalWorkerPool's internal `workerEntry` option. It claims children and runs them by their `mode` input: a `waits`
// child publishes its one stage as waiting released for a tool result and gives its place back, as a worker does,
// renews its lease until `gate` exists, then takes a place back and completes; a `holds` child renews its lease and
// completes once `gate` exists; a `quick` child completes at once. The first attempt of a `fences` child ends fenced,
// and the worker of a `crashes` child's first attempt exits holding it; each creates `gate` first, and completes once
// replayed. A worker ends cleanly once a claim reply retires it.
//
// Every step is appended to the file ATOMIC_TEST_WAITING_LOG names, as one JSON line: `ready`, `claimed`,
// `place-released`, `place-asked`, `place-reacquired`, `completing` and `retired`, with the worker's pid and the child's
// index. A pool that does not know places refuses the place requests; the child then goes on as if granted, unrecorded.
// With ATOMIC_TEST_WAITING_FAIL_FROM set to n, the n-th worker the pool starts and every later one exit before they are
// ready, after ATOMIC_TEST_WAITING_FAIL_DELAY_MS, and with ATOMIC_TEST_WAITING_FAIL_ONLY set to n, only the n-th one
// does; with ATOMIC_TEST_WAITING_EXIT_AFTER_READY set to n, the n-th worker
// exits, as a crash, right after it is ready, before it claims anything.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const log = process.env.ATOMIC_TEST_WAITING_LOG;
const failFrom = Number(process.env.ATOMIC_TEST_WAITING_FAIL_FROM ?? "0");
const exitAfterReady = Number(process.env.ATOMIC_TEST_WAITING_EXIT_AFTER_READY ?? "0");
const failDelayMs = Number(process.env.ATOMIC_TEST_WAITING_FAIL_DELAY_MS ?? "0");
const failOnly = Number(process.env.ATOMIC_TEST_WAITING_FAIL_ONLY ?? "0");
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
if ((failFrom > 0 && started >= failFrom) || (failOnly > 0 && started === failOnly)) {
	await delay(failDelayMs);
	process.exit(1);
}

/** Asks the pool about the attempt's place; a pool that does not know places refuses, which counts as no answer. */
function place(op) {
	return request({ kind: "place", op }).then(
		() => true,
		() => false,
	);
}

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
		if ((mode === "fences" || mode === "crashes") && !existsSync(gate)) {
			writeFileSync(gate, "");
			if (mode === "crashes") process.exit(1);
			await request({ kind: "fenced" });
			continue;
		}
		if (mode === "waits") {
			await request({ kind: "activity", runs: [waitingRun(work)] });
			if (await place("release")) record("place-released", { index });
		}
		while (mode !== "quick" && mode !== "fences" && mode !== "crashes" && !existsSync(gate)) {
			await request({ kind: "heartbeat", reports: [] });
			await delay(100);
		}
		if (mode === "waits") {
			record("place-asked", { index });
			const granted = place("reacquire");
			let answered = false;
			void granted.then(() => {
				answered = true;
			});
			while (!answered) {
				await request({ kind: "heartbeat", reports: [] });
				await delay(100);
			}
			if (await granted) record("place-reacquired", { index });
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
