import assert from "node:assert/strict";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import { PoolAppendRefusedError, StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	PublicationRejectedError,
	StaleWorkLeaseError,
	WorkAttemptFencedError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	isWorkerLostError,
	WorkerLostError,
	WorkflowInfrastructureError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { typedRunFault, workerRefusal } from "../../packages/workflows/src/workers/worker-refusal.js";

const attempt = { workId: "work", generation: 4 };
const stale = new StaleWorkLeaseError({ root: "root", workId: "work", generation: 4, reason: "fenced" });

/** The refusal as the worker receives it: serialized by the coordinator, rehydrated on its side of the IPC. */
function received(error: Error): Error {
	return rehydrateError(JSON.parse(JSON.stringify(serializeError(error))));
}

test("a worker decides what a refusal means from its type after the IPC hop (#4327)", () => {
	const cases: readonly (readonly [Error, "root-lease-lost" | "fenced" | "refused"])[] = [
		[new StaleLeaseError("root", 1, 2), "root-lease-lost"],
		[stale, "fenced"],
		[
			new PublicationRejectedError(
				{ root: "root", workId: "work", generation: 4, reason: "stale-lease" },
				{ cause: stale },
			),
			"fenced",
		],
		[
			new PoolAppendRefusedError(
				{ root: "root", workId: "work", generation: 4, reason: "attempt-refused" },
				{ cause: stale },
			),
			"fenced",
		],
		[new WorkerLostError({ phase: "delivery", pid: 3 }), "fenced"],
		[new StorageUnavailableError({ adapter: "node-sqlite", location: "/j.db" }, new Error("busy")), "fenced"],
		// The pool's own authority failed for a receipt: a refused request, not the root's lease lost.
		[
			new PoolAppendRefusedError(
				{ root: "root", workId: "work", generation: 4, reason: "coordinator-authority" },
				{ cause: new StaleLeaseError("root", 1, 2) },
			),
			"refused",
		],
		[
			new PublicationRejectedError({ root: "root", workId: "work", generation: 4, reason: "outside-subtree" }),
			"refused",
		],
		[new Error("Stale work lease"), "refused"],
		[new Error("Stale lease for run root"), "refused"],
	];
	for (const [refusal, kind] of cases) {
		const arrived = received(refusal);
		const decided = workerRefusal(arrived, attempt);
		assert.equal(decided.kind, kind, `${refusal.name}: ${refusal.message}`);
		if (kind === "refused") assert.equal(decided.error, arrived, "a plain refusal rejects the request as itself");
		else {
			assert.ok(decided.error instanceof WorkAttemptFencedError, String(decided.error));
			assert.equal(decided.error.workId, "work");
			assert.equal(decided.error.generation, 4);
			assert.equal(decided.error.cause, arrived, "the attempt ends caused by the refusal");
		}
	}
});

test("without a held attempt a refusal rejects as itself, whatever it means for the worker (#4327)", () => {
	for (const [refusal, kind] of [
		[new StaleLeaseError("root", 1, 2), "root-lease-lost"],
		[stale, "fenced"],
	] as const) {
		const decided = workerRefusal(refusal, undefined);
		assert.equal(decided.kind, kind);
		assert.equal(decided.error, refusal);
	}
});

test("a run's pool fault is sent as the typed error the run failed on, not rebuilt from its code (#4327)", () => {
	const recorded = new WorkflowInfrastructureError("worker_lost", { runId: "child", stageId: "stage" });
	const lost = new WorkerLostError({ phase: "delivery", pid: 7 });
	const ordinary = new Error("the child's own failure");
	const fault = typedRunFault(recorded, [ordinary, lost, new WorkerLostError({ phase: "coordinator" })]);
	assert.equal(fault, lost, "the first thrown error with the recorded fault code");
	const received = rehydrateError(JSON.parse(JSON.stringify(serializeError(fault))));
	assert.ok(isWorkerLostError(received), String(received));
	assert.equal(received.phase, "delivery");
	assert.equal(received.pid, 7);
});

test("a run's pool fault that is not an infrastructure class is the cause of one naming the run and stage (#4327)", () => {
	const recorded = new WorkflowInfrastructureError("stale_work_lease", { runId: "child", stageId: "stage" });
	const fault = typedRunFault(recorded, [new WorkerLostError({ phase: "delivery" }), stale]);
	assert.ok(fault instanceof WorkflowInfrastructureError, String(fault));
	assert.equal(fault.code, "stale_work_lease");
	assert.equal(fault.runId, "child");
	assert.equal(fault.stageId, "stage");
	assert.equal(fault.cause, stale);
});

test("without a thrown error carrying its code, the run's recorded fault stands (#4327)", () => {
	const recorded = new WorkflowInfrastructureError("storage_unavailable", { runId: "child" });
	assert.equal(typedRunFault(recorded, []), recorded);
	assert.equal(typedRunFault(recorded, [new Error("other"), new WorkerLostError({ phase: "delivery" })]), recorded);
});
