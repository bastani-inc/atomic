import assert from "node:assert/strict";
import {
	isRetryableStorageError,
	isStorageTransientError,
	StorageTransientError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	infrastructureFaultOf,
	isRetryableWorkflowError,
	isWorkflowInfrastructureError,
	WorkflowInfrastructureError,
	workflowInfrastructureErrorFor,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";

/** Every IPC hop is JSON, as Node's default `fork` serialization is. */
function hop(error: unknown): Error {
	return rehydrateError(JSON.parse(JSON.stringify(serializeError(error))));
}

const failure = () =>
	new StorageTransientError(
		{ adapter: "libsql", location: "https://db.example" },
		{ code: "connection-lost", outcome: "unknown", attempts: 1 },
		Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
	);

test("a transient storage failure crosses the pool's process boundary as its class, a retryable storage outage (#4383)", () => {
	const transient = failure();
	const received = hop(new WorkflowInfrastructureError("storage_unavailable", { cause: transient }));
	assert.ok(isWorkflowInfrastructureError(received), String(received));
	assert.equal(isRetryableWorkflowError(received), true);
	const crossed = received.cause;
	assert.ok(crossed instanceof StorageTransientError, String(crossed));
	assert.ok(crossed instanceof StorageUnavailableError);
	assert.deepEqual(
		[crossed.code, crossed.outcome, crossed.attempts, crossed.adapter, crossed.location, crossed.hint],
		["connection-lost", "unknown", 1, "libsql", "https://db.example", transient.hint],
	);
	assert.equal(crossed.message, transient.message);
	assert.ok(isRetryableStorageError(crossed));
	assert.equal(infrastructureFaultOf(crossed), "storage_unavailable");
});

test("a copy of a transient storage failure from another realm is a storage outage too (#4383)", () => {
	const transient = failure();
	const copy = { ...structuredClone({ ...transient }), name: transient.name, code: transient.code };
	assert.equal(copy instanceof StorageUnavailableError, false);
	assert.ok(isStorageTransientError(copy));
	assert.equal(infrastructureFaultOf(copy), "storage_unavailable");
	const fault = workflowInfrastructureErrorFor(copy);
	assert.equal(fault?.code, "storage_unavailable");
	assert.ok(isStorageTransientError(hop(copy)));
	assert.equal(infrastructureFaultOf({ name: "StorageTransientError", code: "not-a-code" }), undefined);
});
