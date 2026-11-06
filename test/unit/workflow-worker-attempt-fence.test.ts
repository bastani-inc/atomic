import assert from "node:assert/strict";
import { test } from "vitest";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { rehydrateError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	isStaleWorkLeaseError,
	isWorkAttemptFencedError,
	PublicationRejectedError,
	StaleWorkLeaseError,
	WorkAttemptFencedError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	AdmissionHolderStoppedError,
	isAdmissionHolderStoppedError,
	isQuarantinedCapacityError,
	isWorkflowInfrastructureError,
	QuarantinedCapacityError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { AttemptFence, endedAttemptRefusal } from "../../packages/workflows/src/workers/attempt-fence.js";
import type { WorkerReplyState } from "../../packages/workflows/src/workers/worker-replies.js";

const attempt = { workId: "work", generation: 2 };
const quarantined = () => new QuarantinedCapacityError({ limits: ["processes"], processGroups: [7], waitedMs: 900 });
const staleWork = () => new StaleWorkLeaseError({ root: "root", workId: "work", generation: 2, reason: "expired" });

function harness(fenced = false) {
	const replies: WorkerReplyState = { attemptFenced: fenced, rootLeaseLost: false };
	return { replies, fence: new AttemptFence(replies, attempt), controller: new AbortController() };
}

function failedRun(failureCode: string) {
	return {
		runId: "child",
		status: "failed",
		stages: [{ id: "stage", status: "failed", error: "text the decision never reads", failureCode }],
	};
}

test("an admission refused on a pool fault ends the attempt once, aborts its run and is sent typed (#4327)", () => {
	for (const fault of [quarantined(), new AdmissionHolderStoppedError({ permitReason: "stopped" })]) {
		const h = harness();
		h.fence.refuseAdmission(fault, h.controller);
		assert.equal(h.replies.attemptFenced, true);
		assert.equal(h.replies.rootLeaseLost, false);
		const reason = h.controller.signal.reason;
		assert.ok(isWorkAttemptFencedError(reason), String(reason));
		assert.deepEqual([reason.workId, reason.generation], ["work", 2]);
		assert.equal(reason.cause, fault);
		const request = h.fence.request();
		assert.equal(request.kind, "fenced");
		const sent = rehydrateError(request.fault);
		assert.equal(sent.name, fault.name);
		assert.ok(isQuarantinedCapacityError(sent) || isAdmissionHolderStoppedError(sent), String(sent));

		const later = new AbortController();
		h.fence.refuseAdmission(quarantined(), later);
		assert.equal(later.signal.aborted, false, "a fenced attempt is not ended again");
		assert.equal(rehydrateError(h.fence.request().fault).name, fault.name, "the first fault stays the one sent");
	}
});

test("an admission refused for any other reason, or after the attempt was fenced, ends nothing (#4327)", () => {
	for (const refusal of [new Error("Quarantined capacity"), staleWork(), undefined]) {
		const h = harness();
		h.fence.refuseAdmission(refusal, h.controller);
		assert.equal(h.controller.signal.aborted, false);
		assert.equal(h.replies.attemptFenced, false);
		assert.deepEqual(h.fence.request(), { kind: "fenced" });
	}
	const fenced = harness(true);
	fenced.fence.refuseAdmission(quarantined(), fenced.controller);
	assert.equal(fenced.controller.signal.aborted, false);
	assert.deepEqual(fenced.fence.request(), { kind: "fenced" }, "a fence its replies set carries no fault");
});

test("a result is the child's outcome unless the attempt was fenced or the run failed on a pool fault (#4327)", () => {
	const own = harness();
	assert.equal(own.fence.instead({ runId: "child", status: "completed", stages: [] }, []), undefined);
	assert.equal(own.fence.instead(failedRun("stage_failed"), [staleWork()]), undefined);
	assert.equal(own.replies.attemptFenced, false);
	assert.deepEqual(own.fence.request(), { kind: "fenced" });

	const fenced = harness(true);
	const instead = fenced.fence.instead({ runId: "child", status: "completed", stages: [] }, []);
	assert.ok(instead instanceof WorkAttemptFencedError, String(instead));
	assert.deepEqual([instead.workId, instead.generation], ["work", 2]);
	assert.equal(instead.cause, undefined);
	assert.deepEqual(fenced.fence.request(), { kind: "fenced" });
});

test("a run that failed on a pool fault ends the attempt with that fault, typed from what the run threw (#4327)", () => {
	const typed = harness();
	const fault = quarantined();
	const ended = typed.fence.instead(failedRun("worker_cleanup_unconfirmed"), [new Error("other"), fault]);
	assert.ok(isWorkAttemptFencedError(ended), String(ended));
	assert.deepEqual([ended.workId, ended.generation], ["work", 2]);
	assert.equal(ended.cause, fault);
	assert.equal(typed.replies.attemptFenced, true);
	const sent = rehydrateError(typed.fence.request().fault);
	assert.ok(isQuarantinedCapacityError(sent), String(sent));
	assert.deepEqual(sent.processGroups, [7]);

	const wrapped = harness();
	const stale = staleWork();
	const wrappedEnd = wrapped.fence.instead(failedRun("stale_work_lease"), [stale]);
	const cause = wrappedEnd?.cause;
	assert.ok(isWorkflowInfrastructureError(cause), String(cause));
	assert.equal(cause.code, "stale_work_lease");
	assert.equal(cause.runId, "child");
	assert.equal(cause.stageId, "stage");
	assert.equal(cause.cause, stale);
	const wrappedSent = rehydrateError(wrapped.fence.request().fault);
	assert.ok(isWorkflowInfrastructureError(wrappedSent), String(wrappedSent));
	assert.ok(isStaleWorkLeaseError(wrappedSent.cause), String(wrappedSent.cause));

	const recorded = harness();
	const recordedEnd = recorded.fence.instead(failedRun("storage_unavailable"), []);
	assert.ok(isWorkflowInfrastructureError(recordedEnd?.cause), String(recordedEnd?.cause));
	assert.equal(recordedEnd.cause.code, "storage_unavailable");
	assert.equal(rehydrateError(recorded.fence.request().fault).name, "WorkflowInfrastructureError");
});

test("a closing attempt's heartbeat tolerates only refusals of an ended attempt (#4327)", () => {
	assert.equal(endedAttemptRefusal(new WorkAttemptFencedError(attempt)), true);
	assert.equal(endedAttemptRefusal(staleWork()), true);
	assert.equal(
		endedAttemptRefusal(
			new PublicationRejectedError(
				{ root: "root", workId: "work", generation: 2, reason: "stale-lease" },
				{ cause: staleWork() },
			),
		),
		true,
	);
	assert.equal(endedAttemptRefusal(new StaleLeaseError("root", 1, 2)), true);
	assert.equal(endedAttemptRefusal(quarantined()), false);
	assert.equal(endedAttemptRefusal(new Error("Stale work lease")), false);
	assert.equal(endedAttemptRefusal(undefined), false);
});
