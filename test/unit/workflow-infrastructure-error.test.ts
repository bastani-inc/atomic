import assert from "node:assert/strict";
import { test } from "vitest";
import { isRetryableWorkflowError, WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import {
	asWorkflowInfrastructureError,
	workflowInfrastructureFault,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";

test("pool and runtime faults classify as typed retryable errors (#3889)", () => {
	const faults = {
		"Local worker cleanup was not confirmed": "worker_cleanup_unconfirmed",
		"Local worker process cleanup unconfirmed; permits quarantined": "worker_cleanup_unconfirmed",
		"Local worker retry limit (worker stderr log: /tmp/w.log)": "worker_retry_limit",
		"Local worker startup timed out after 500 ms": "worker_startup_failed",
		"Worker exited before delivery acknowledgement": "worker_lost",
		"Stale work lease": "stale_work_lease",
		"Intercom runtime no longer active": "intercom_unavailable",
		"Storage unavailable: node-sqlite at /tmp/journal.sqlite": "storage_unavailable",
	} as const;
	for (const [message, code] of Object.entries(faults)) {
		const typed = asWorkflowInfrastructureError(new Error(message));
		assert.ok(typed instanceof WorkflowInfrastructureError, message);
		assert.equal(typed.code, code);
		assert.equal(typed.retryable, true);
		assert.equal(typed.message, message);
		assert.equal(isRetryableWorkflowError(typed), true);
	}
	assert.equal(workflowInfrastructureFault("child logic rejected the input"), undefined);
	assert.equal(asWorkflowInfrastructureError(new Error("child logic rejected the input")), undefined);
});

test("retryable faults are recognized through causes but ordinary failures are not (#3889)", () => {
	const fault = new WorkflowInfrastructureError("worker_lost", "Worker exited before delivery acknowledgement");
	assert.equal(isRetryableWorkflowError(new Error("wrapped", { cause: new Error("again", { cause: fault }) })), true);
	const copied = Object.assign(new Error("copied"), {
		name: "WorkflowInfrastructureError",
		retryable: true,
		code: "x",
	});
	assert.equal(isRetryableWorkflowError(copied), true);
	for (const failure of [new Error("Stale work lease"), "Stale work lease", undefined, null, { retryable: true }])
		assert.equal(isRetryableWorkflowError(failure), false);
});
