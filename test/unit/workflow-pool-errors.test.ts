import assert from "node:assert/strict";
import {
	AgentSessionBusyError,
	isAgentSessionBusyError,
	isTaskCleanupAdmissionTimeoutError,
	isTaskCleanupError,
	TaskCleanupAdmissionTimeoutError,
	TaskCleanupError,
	type TaskCleanupFailure,
	type TaskId,
} from "@bastani/atomic";
import {
	isJournalCatalogError,
	isJournalShardUnavailableError,
	isJournalStoreError,
	isStorageConfigError,
	isStorageWriteLockTimeoutError,
	isStorageWriterQueueDegradedError,
	isStorageWriterQueueUnusableError,
	JournalCatalogError,
	JournalShardUnavailableError,
	StorageConfigError,
	StorageError,
	StorageRollbackError,
	StorageUnavailableError,
	StorageWriteLockTimeoutError,
	StorageWriterQueueDegradedError,
	StorageWriterQueueUnusableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import { StorageUnavailableError as SessionStorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { GitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";
import {
	IntercomRuntimeInactiveError,
	isIntercomRuntimeInactiveError,
} from "../../packages/intercom/runtime-inactive-error.js";
import {
	ForkSourceBusyError,
	isForkError,
	isForkSourceBusyError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import {
	isPoolAppendRefusedError,
	isStaleLeaseError,
	JournalClosedError,
	JournalError,
	PoolAppendRefusedError,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { causeChain, MAX_CAUSE_DEPTH } from "../../packages/workflows/src/shared/error-cause-chain.js";
import {
	MAX_SERIALIZED_ERRORS,
	NON_ERROR_CAUSE,
	REGISTERED_ERROR_NAMES,
	rehydrateError,
	type SerializedError,
	type SerializedErrorField,
	serializeError,
} from "../../packages/workflows/src/shared/error-codec.js";
import * as workerPoolErrors from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	causedByStaleWorkLease,
	isLocalWorkerOptionsError,
	isLocalWorkerPoolError,
	isPoolNotInitializedError,
	isPoolProtocolError,
	isPublicationRejectedError,
	isStaleWorkLeaseError,
	isWorkAttemptFencedError,
	LocalWorkerOptionsError,
	LocalWorkerPoolError,
	type LocalWorkerPoolErrorCode,
	PoolNotInitializedError,
	PoolProtocolError,
	PUBLICATION_REJECTED_REASONS,
	PublicationRejectedError,
	STALE_WORK_LEASE_REASONS,
	StaleWorkLeaseError,
	WorkAttemptFencedError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	isWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";
import * as infrastructureErrors from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import {
	AdmissionHolderStoppedError,
	failedOnPoolFault,
	infrastructureFaultOf,
	isAdmissionHolderStoppedError,
	isProcessCleanupUnconfirmedError,
	isQuarantinedCapacityError,
	isRetryableWorkflowError,
	isWorkerCleanupUnconfirmedError,
	isWorkerLostError,
	isWorkerRetryLimitError,
	isWorkerStartupError,
	isWorkerStartupTimeoutError,
	isWorkflowInfrastructureError,
	ProcessCleanupUnconfirmedError,
	QuarantinedCapacityError,
	runInfrastructureFault,
	WORKER_RETRY_LIMIT_REASONS,
	WorkerCleanupUnconfirmedError,
	WorkerLostError,
	WorkerRetryLimitError,
	WorkerStartupError,
	WorkerStartupTimeoutError,
	WorkflowInfrastructureError,
	workflowInfrastructureErrorFor,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import * as placementErrors from "../../packages/workflows/src/workers/placement-errors.js";
import {
	isRemoteStageCommandUnsupportedError,
	isSharedPoolSetupError,
	isStageInputInvalidError,
	isStageInputRefusedError,
	isStageInputTimeoutError,
	isStaleStageLeaseError,
	isWorkerPlacementConfigError,
	isWorkerPlacementError,
	isWorkspaceRestoreUnavailableError,
	RemoteStageCommandUnsupportedError,
	SharedPoolSetupError,
	StageInputInvalidError,
	StageInputRefusedError,
	StageInputTimeoutError,
	StaleStageLeaseError,
	sharedPoolProblems,
	WorkerPlacementConfigError,
	WorkerPlacementError,
	WorkspaceRestoreUnavailableError,
	workspaceBindingIdentity,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { ignoreStaleLease, ignoreStaleWorkLease } from "../../packages/workflows/src/workers/stale-refusals.js";

/** Every IPC hop is JSON, as Node's default `fork` serialization is. */
function hop(error: unknown): Error {
	return rehydrateError(JSON.parse(JSON.stringify(serializeError(error))));
}

interface Case {
	readonly error: Error;
	readonly type: abstract new (...args: never[]) => Error;
	readonly guard: (value: unknown) => boolean;
	readonly name: string;
	readonly code: string;
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, unknown>>;
}

/** A code a later version of the family may send, which this version does not know. */
const FUTURE_CODE = "future_code" as LocalWorkerPoolErrorCode;

const stale = new StaleWorkLeaseError({ root: "root", workId: "work-1", generation: 3, reason: "expired" });
const cleanupFailures: readonly TaskCleanupFailure[] = [
	{
		taskId: "task-1" as TaskId,
		resources: [
			{ resource: "process-group:4242", code: "CleanupFailed", message: "drain unconfirmed" },
			{ resource: "process-group:4343", code: "CleanupFailed", message: "exit unconfirmed" },
		],
	},
	{ taskId: "task-2" as TaskId, resources: [{ resource: "process-group:4444", code: "CleanupFailed", message: "x" }] },
];

const BINDING = workspaceBindingIdentity({
	remotes: ["https://example.invalid/repo.git"],
	head: "abc123",
	tree: "def456",
	envHash: "env",
});

const CASES: readonly Case[] = [
	{
		error: new LocalWorkerOptionsError({
			source: "settings",
			option: "heartbeatMs",
			reason: "above-maximum",
			received: "20000",
			minimum: 100,
			maximum: 15_000,
			omitted: "to use a quarter of the lease",
		}),
		type: LocalWorkerOptionsError,
		guard: isLocalWorkerOptionsError,
		name: "LocalWorkerOptionsError",
		code: "invalid-heartbeat",
		retryable: false,
		fields: {
			source: "settings",
			field: "workflows.localWorkers.heartbeatMs",
			option: "heartbeatMs",
			reason: "above-maximum",
			received: "20000",
			minimum: 100,
			maximum: 15_000,
			omitted: "to use a quarter of the lease",
		},
	},
	{
		error: new PoolNotInitializedError({ root: "root" }),
		type: PoolNotInitializedError,
		guard: isPoolNotInitializedError,
		name: "PoolNotInitializedError",
		code: "pool_not_initialized",
		retryable: false,
		fields: { root: "root" },
	},
	{
		error: new PoolNotInitializedError({}),
		type: PoolNotInitializedError,
		guard: isPoolNotInitializedError,
		name: "PoolNotInitializedError",
		code: "pool_not_initialized",
		retryable: false,
		fields: { root: undefined },
	},
	{
		error: stale,
		type: StaleWorkLeaseError,
		guard: isStaleWorkLeaseError,
		name: "StaleWorkLeaseError",
		code: "stale_work_lease",
		retryable: true,
		fields: { root: "root", workId: "work-1", generation: 3, reason: "expired" },
	},
	{
		error: new PublicationRejectedError(
			{ root: "root", workId: "work-1", generation: 3, reason: "outside-subtree", runId: "run-x" },
			{ cause: stale },
		),
		type: PublicationRejectedError,
		guard: isPublicationRejectedError,
		name: "PublicationRejectedError",
		code: "publication_rejected",
		retryable: false,
		fields: { root: "root", workId: "work-1", generation: 3, reason: "outside-subtree", runId: "run-x" },
	},
	{
		error: new PublicationRejectedError({
			root: "root",
			workId: "work-1",
			generation: 3,
			reason: "session-replaced",
			runId: "run-x",
			stageId: "stage",
			sessionId: "session-a",
		}),
		type: PublicationRejectedError,
		guard: isPublicationRejectedError,
		name: "PublicationRejectedError",
		code: "publication_rejected",
		retryable: false,
		fields: { reason: "session-replaced", runId: "run-x", stageId: "stage", sessionId: "session-a" },
	},
	{
		error: new WorkAttemptFencedError({ workId: "work-1", generation: 3 }, { cause: stale }),
		type: WorkAttemptFencedError,
		guard: isWorkAttemptFencedError,
		name: "WorkAttemptFencedError",
		code: "work_attempt_fenced",
		retryable: true,
		fields: { workId: "work-1", generation: 3 },
	},
	{
		error: new PoolProtocolError({ field: "error.fields.generation", expected: "a finite number" }),
		type: PoolProtocolError,
		guard: isPoolProtocolError,
		name: "PoolProtocolError",
		code: "pool_protocol_invalid",
		retryable: false,
		fields: { field: "error.fields.generation", expected: "a finite number" },
	},
	{
		error: new WorkflowInfrastructureError("intercom_unavailable", { runId: "run", stageId: "stage" }),
		type: WorkflowInfrastructureError,
		guard: isWorkflowInfrastructureError,
		name: "WorkflowInfrastructureError",
		code: "intercom_unavailable",
		retryable: true,
		fields: { runId: "run", stageId: "stage" },
	},
	{
		error: new WorkerLostError({
			phase: "coordinator",
			pid: 42,
			signal: "SIGKILL",
			logPath: "/logs/coordinator.log",
			logFailure: "EACCES",
		}),
		type: WorkerLostError,
		guard: isWorkerLostError,
		name: "WorkerLostError",
		code: "worker_lost",
		retryable: true,
		fields: {
			phase: "coordinator",
			pid: 42,
			signal: "SIGKILL",
			logPath: "/logs/coordinator.log",
			logFailure: "EACCES",
		},
	},
	{
		error: new WorkerLostError({ phase: "delivery", exitCode: 1 }),
		type: WorkerLostError,
		guard: isWorkerLostError,
		name: "WorkerLostError",
		code: "worker_lost",
		retryable: true,
		fields: { phase: "delivery", exitCode: 1 },
	},
	{
		error: new WorkerStartupError({ logPath: "/logs/w.log" }),
		type: WorkerStartupError,
		guard: isWorkerStartupError,
		name: "WorkerStartupError",
		code: "worker_startup_failed",
		retryable: true,
		fields: { logPath: "/logs/w.log" },
	},
	{
		error: new WorkerStartupError({ logPath: "/logs/w.log", logFailure: "ENOSPC" }),
		type: WorkerStartupError,
		guard: isWorkerStartupError,
		name: "WorkerStartupError",
		code: "worker_startup_failed",
		retryable: true,
		fields: { logPath: "/logs/w.log", logFailure: "ENOSPC" },
	},
	{
		error: new WorkerStartupError(
			{ logPath: "/logs/w.log" },
			{ hint: "Check the child's imports.", runId: "child", stageId: "stage" },
		),
		type: WorkerStartupError,
		guard: isWorkerStartupError,
		name: "WorkerStartupError",
		code: "worker_startup_failed",
		retryable: true,
		fields: { logPath: "/logs/w.log", runId: "child", stageId: "stage" },
	},
	{
		error: new WorkerStartupTimeoutError({
			logPath: "/logs/w.log",
			logFailure: "EACCES",
			timeoutMs: 500,
			elapsedMs: 512,
		}),
		type: WorkerStartupTimeoutError,
		guard: isWorkerStartupTimeoutError,
		name: "WorkerStartupTimeoutError",
		code: "worker_startup_failed",
		retryable: true,
		fields: { logPath: "/logs/w.log", logFailure: "EACCES", timeoutMs: 500, elapsedMs: 512, phase: "startup" },
	},
	{
		error: new WorkerRetryLimitError(
			{
				reason: "pool-fault",
				attempts: 3,
				limit: 3,
				childRunId: "child",
				exportName: "child",
				logPath: "/w.log",
				logFailure: "EACCES",
			},
			{ cause: new WorkerCleanupUnconfirmedError({ processGroups: [7] }) },
		),
		type: WorkerRetryLimitError,
		guard: isWorkerRetryLimitError,
		name: "WorkerRetryLimitError",
		code: "worker_retry_limit",
		retryable: true,
		fields: {
			reason: "pool-fault",
			attempts: 3,
			limit: 3,
			childRunId: "child",
			exportName: "child",
			logPath: "/w.log",
			logFailure: "EACCES",
		},
	},
	{
		error: new WorkerCleanupUnconfirmedError({ processGroups: [7, 9] }),
		type: WorkerCleanupUnconfirmedError,
		guard: isWorkerCleanupUnconfirmedError,
		name: "WorkerCleanupUnconfirmedError",
		code: "worker_cleanup_unconfirmed",
		retryable: true,
		fields: { processGroups: [7, 9] },
	},
	{
		error: new QuarantinedCapacityError({
			limits: ["admission.limits.process (1)"],
			processGroups: [7],
			waitedMs: 15_000,
		}),
		type: QuarantinedCapacityError,
		guard: isQuarantinedCapacityError,
		name: "QuarantinedCapacityError",
		code: "worker_cleanup_unconfirmed",
		retryable: true,
		fields: { limits: ["admission.limits.process (1)"], processGroups: [7], waitedMs: 15_000 },
	},
	{
		error: new AdmissionHolderStoppedError({ permitReason: "owner expired" }),
		type: AdmissionHolderStoppedError,
		guard: isAdmissionHolderStoppedError,
		name: "AdmissionHolderStoppedError",
		code: "stale_work_lease",
		retryable: true,
		fields: { permitReason: "owner expired" },
	},
	{
		error: new StaleLeaseError("root", 2, 3),
		type: StaleLeaseError,
		guard: isStaleLeaseError,
		name: "StaleLeaseError",
		code: "stale_lease",
		retryable: false,
		fields: { runId: "root", heldEpoch: 2, currentEpoch: 3 },
	},
	{
		error: new PoolAppendRefusedError(
			{ root: "root", workId: "work-1", generation: 3, reason: "attempt-refused" },
			{ cause: stale },
		),
		type: PoolAppendRefusedError,
		guard: isPoolAppendRefusedError,
		name: "PoolAppendRefusedError",
		code: "pool_append_refused",
		retryable: false,
		fields: { root: "root", workId: "work-1", generation: 3, reason: "attempt-refused" },
	},
	{
		error: new ProcessCleanupUnconfirmedError(new TaskCleanupError("stage-close", cleanupFailures)),
		type: ProcessCleanupUnconfirmedError,
		guard: isProcessCleanupUnconfirmedError,
		name: "ProcessCleanupUnconfirmedError",
		code: "process_cleanup_unconfirmed",
		retryable: true,
		fields: {
			phase: "stage-close",
			resources: cleanupFailures.flatMap((failure) =>
				failure.resources.map((resource) => ({ taskId: failure.taskId, ...resource })),
			),
		},
	},
	{
		error: new TaskCleanupError("stage-pause", cleanupFailures),
		type: TaskCleanupError,
		guard: isTaskCleanupError,
		name: "TaskCleanupError",
		code: "task_cleanup_unconfirmed",
		retryable: true,
		fields: { phase: "stage-pause", failures: cleanupFailures },
	},
	{
		error: new WorkerPlacementConfigError("settings", "workers.placement", "unsupported-option", "not shared", {
			cause: stale,
		}),
		type: WorkerPlacementConfigError,
		guard: isWorkerPlacementConfigError,
		name: "WorkerPlacementConfigError",
		code: "unsupported-option",
		retryable: false,
		fields: { source: "settings", field: "workers.placement", detail: "not shared" },
	},
	{
		error: new SharedPoolSetupError("shared-placement", [
			sharedPoolProblems.sharedJournalRequired("jsonl", "/journal"),
			sharedPoolProblems.adapterUnavailable("@scope/adapter"),
		]),
		type: SharedPoolSetupError,
		guard: isSharedPoolSetupError,
		name: "SharedPoolSetupError",
		code: "shared-journal-required",
		retryable: false,
		fields: {
			operation: "shared-placement",
			problems: [
				sharedPoolProblems.sharedJournalRequired("jsonl", "/journal"),
				sharedPoolProblems.adapterUnavailable("@scope/adapter"),
			],
		},
	},
	{
		error: new WorkspaceRestoreUnavailableError("no-capable-host", BINDING, {
			childRunId: "child",
			claimWindowMs: 3_000,
		}),
		type: WorkspaceRestoreUnavailableError,
		guard: isWorkspaceRestoreUnavailableError,
		name: "WorkspaceRestoreUnavailableError",
		code: "workspace-restore-unavailable",
		retryable: false,
		fields: { reason: "no-capable-host", binding: BINDING, childRunId: "child", claimWindowMs: 3_000 },
	},
	{
		error: new StaleStageLeaseError(
			"stage-lease-replaced",
			{ root: "root", runId: "run", stageId: "stage", seq: null },
			{ cause: stale },
		),
		type: StaleStageLeaseError,
		guard: isStaleStageLeaseError,
		name: "StaleStageLeaseError",
		code: "stale-stage-lease",
		retryable: false,
		fields: { reason: "stage-lease-replaced", root: "root", runId: "run", stageId: "stage", seq: null },
	},
	{
		error: new StageInputInvalidError(
			"malformed-payload",
			{ kind: "user-message", runId: "run", stageId: "stage", field: "intent" },
			{ cause: stale },
		),
		type: StageInputInvalidError,
		guard: isStageInputInvalidError,
		name: "StageInputInvalidError",
		code: "stage-input-invalid",
		retryable: false,
		fields: { reason: "malformed-payload", kind: "user-message", runId: "run", stageId: "stage", field: "intent" },
	},
	{
		error: new StageInputTimeoutError(
			{ root: "root", runId: "run", stageId: "stage", seq: 4, kind: "intercom-message" },
			{ timeoutMs: 60_000, elapsedMs: 60_014, phase: "applying" },
		),
		type: StageInputTimeoutError,
		guard: isStageInputTimeoutError,
		name: "StageInputTimeoutError",
		code: "stage-input-timeout",
		retryable: true,
		fields: {
			root: "root",
			runId: "run",
			stageId: "stage",
			seq: 4,
			kind: "intercom-message",
			timeoutMs: 60_000,
			elapsedMs: 60_014,
			phase: "applying",
		},
	},
	{
		error: new StageInputRefusedError(
			"stage-failed",
			{ root: "root", runId: "run", stageId: "stage", seq: 2, kind: "user-message" },
			{ detail: "session closed", cause: stale },
		),
		type: StageInputRefusedError,
		guard: isStageInputRefusedError,
		name: "StageInputRefusedError",
		code: "stage-input-refused",
		retryable: false,
		fields: {
			reason: "stage-failed",
			root: "root",
			runId: "run",
			stageId: "stage",
			seq: 2,
			kind: "user-message",
			detail: "session closed",
		},
	},
	{
		error: new RemoteStageCommandUnsupportedError("session", { runId: "run", stageId: "stage" }),
		type: RemoteStageCommandUnsupportedError,
		guard: isRemoteStageCommandUnsupportedError,
		name: "RemoteStageCommandUnsupportedError",
		code: "remote-stage-command-unsupported",
		retryable: false,
		fields: { command: "session", runId: "run", stageId: "stage" },
	},
	{
		error: new TaskCleanupAdmissionTimeoutError(
			cleanupFailures,
			{ timeoutMs: 5_000, elapsedMs: 5_012 },
			{ cause: new Error("admission refused") },
		),
		type: TaskCleanupAdmissionTimeoutError,
		guard: isTaskCleanupAdmissionTimeoutError,
		name: "TaskCleanupAdmissionTimeoutError",
		code: "task_cleanup_unconfirmed",
		retryable: true,
		fields: { phase: "command-admission", failures: cleanupFailures, timeoutMs: 5_000, elapsedMs: 5_012 },
	},
];

function assertSameError(actual: Error, expected: Error, kase: Case): void {
	assert.ok(actual instanceof kase.type, `${kase.name}: ${actual.name}`);
	assert.equal(kase.guard(actual), true);
	assert.equal(actual.name, kase.name);
	assert.equal((actual as { readonly code?: unknown }).code, kase.code);
	assert.equal((actual as { readonly retryable?: unknown }).retryable, kase.retryable);
	assert.equal(actual.message, expected.message);
	assert.equal((actual as { readonly hint?: unknown }).hint, (expected as { readonly hint?: unknown }).hint);
	for (const [field, value] of Object.entries(kase.fields))
		assert.deepEqual((actual as unknown as Record<string, unknown>)[field], value, `${kase.name}.${field}`);
}

test("every pool error keeps its class, guard, code, hint and fields across an IPC hop (#4327)", () => {
	for (const kase of CASES) {
		assertSameError(kase.error, kase.error, kase);
		assert.ok(((kase.error as { readonly hint?: unknown }).hint as string).length > 0, kase.name);
		const received = hop(kase.error);
		assertSameError(received, kase.error, kase);
		const expectedCause = kase.error.cause;
		if (expectedCause instanceof Error) {
			assert.ok(received.cause instanceof Error);
			assert.equal(received.cause.constructor, expectedCause.constructor);
			assert.equal(received.cause.message, expectedCause.message);
		} else assert.equal(received.cause, undefined);
	}
});

test("every pool error class is registered with the codec and has a round-trip case (#4327)", () => {
	const exported: readonly unknown[] = [
		...Object.values(workerPoolErrors),
		...Object.values(infrastructureErrors),
		...Object.values(placementErrors),
		StaleLeaseError,
		PoolAppendRefusedError,
		TaskCleanupError,
		TaskCleanupAdmissionTimeoutError,
	];
	const classes = exported.filter(
		(value): value is abstract new (...args: never[]) => Error =>
			typeof value === "function" &&
			value.prototype instanceof Error &&
			value !== LocalWorkerPoolError &&
			value !== WorkerPlacementError,
	);
	assert.deepEqual(
		classes.map((type) => type.name).sort(),
		[...REGISTERED_ERROR_NAMES].sort(),
		"each exported error class crosses as itself, and only those",
	);
	for (const name of REGISTERED_ERROR_NAMES)
		assert.ok(
			CASES.some((kase) => kase.name === name),
			`${name} has a round-trip case`,
		);
});

test("a task cleanup error copied from another realm crosses as its own class, and an unknown one keeps its name and code (#4327)", () => {
	for (const original of [
		new TaskCleanupError("stage-pause", cleanupFailures),
		new TaskCleanupAdmissionTimeoutError(cleanupFailures, { timeoutMs: 5_000, elapsedMs: 5_012 }),
	]) {
		const copy = { ...JSON.parse(JSON.stringify(original)), message: original.message };
		const received = hop(copy);
		assert.equal(received.constructor, original.constructor, original.name);
		assert.deepEqual((received as TaskCleanupError).failures, original.failures);
		assert.equal(received.message, original.message);
	}
	const future = rehydrateError({
		name: "TaskCleanupFutureError",
		code: "task_cleanup_unconfirmed",
		message: "m",
		hint: "h",
		family: "task-cleanup",
		fields: {},
	});
	assert.equal(future.constructor, Error);
	assert.deepEqual(
		[future.name, (future as { readonly code?: unknown }).code, future.message],
		["TaskCleanupFutureError", "task_cleanup_unconfirmed", "m"],
	);
});

test("an error that only borrows a pool class's name crosses as a plain error, and a copy's non-boolean retryable is left behind (#4327)", () => {
	const borrowed = hop(Object.assign(new Error("not a pool error"), { name: "StaleWorkLeaseError" }));
	assert.equal(borrowed.constructor, Error);
	assert.deepEqual([borrowed.name, borrowed.message], ["StaleWorkLeaseError", "not a pool error"]);
	const copy = hop({
		name: "StaleWorkLeaseError",
		code: "stale_work_lease",
		message: "m",
		retryable: "yes",
		root: "r",
		workId: "w",
		generation: 1,
		reason: "expired",
	});
	assert.ok(isStaleWorkLeaseError(copy), String(copy));
	assert.equal(copy.retryable, true);
});

test("a local worker setting refusal crosses as itself for every source, setting and reason (#4327)", () => {
	for (const source of ["sdk", "settings"] as const)
		for (const option of ["leaseMs", "heartbeatMs"] as const)
			for (const reason of ["not-an-integer", "below-minimum", "above-maximum"] as const) {
				const refusal = new LocalWorkerOptionsError({
					source,
					option,
					reason,
					received: "1.5",
					minimum: 100,
					maximum: 1_000,
					omitted: "for the default",
				});
				const received = hop(refusal);
				assert.ok(received instanceof LocalWorkerOptionsError, `${source} ${option} ${reason}: ${received}`);
				assert.deepEqual(
					[received.code, received.field, received.reason, received.hint, received.message],
					[refusal.code, refusal.field, refusal.reason, refusal.hint, refusal.message],
				);
			}
});

test("a git-required failure that reaches the pool's codec keeps its name, code and message (#4327)", () => {
	const error = new WorkflowGitRequiredError(
		{ workflow: "w", runId: "run", source: "input", field: "worktree", gitWorktreeDir: "/w" },
		new GitUnavailableError({
			code: "offline",
			offlineVariable: "ATOMIC_OFFLINE",
			platform: "linux",
			arch: "x64",
			installCommand: "apt-get install git",
		}),
	);
	const received = hop(error);
	assert.ok(isWorkflowGitRequiredError(received), String(received));
	assert.deepEqual(
		[received.name, (received as { readonly code?: unknown }).code, received.message],
		["WorkflowGitRequiredError", "git-required", error.message],
	);
});

test("a journal store error crosses as its own class with its fields, hint, retryable and cause (#4327)", () => {
	const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
	const shard = new JournalShardUnavailableError({
		code: "shard-open-failed",
		shardId: 3,
		shardPath: "/journal/shard-3.sqlite",
		runId: "root",
		cause: busy,
	});
	const crossed = hop(new WorkflowInfrastructureError("storage_unavailable", { cause: shard })).cause;
	assert.ok(crossed instanceof JournalShardUnavailableError, String(crossed));
	assert.ok(isJournalShardUnavailableError(crossed));
	assert.deepEqual(
		[
			crossed.code,
			crossed.shardId,
			crossed.shardPath,
			crossed.runId,
			crossed.hint,
			crossed.retryable,
			crossed.message,
		],
		[shard.code, 3, "/journal/shard-3.sqlite", "root", shard.hint, shard.retryable, shard.message],
	);
	assert.deepEqual(
		[(crossed.cause as Error).name, (crossed.cause as { readonly code?: unknown }).code],
		["Error", "SQLITE_BUSY"],
	);
	const catalog = hop(
		new JournalCatalogError({ code: "run-not-found", catalogPath: "/journal/catalog.sqlite", runId: "r" }),
	);
	assert.ok(isJournalCatalogError(catalog), String(catalog));
	assert.equal(catalog.code, "run-not-found");
	const schema = hop(
		new JournalCatalogError({
			code: "schema-version",
			catalogPath: "/journal/catalog.sqlite",
			found: null,
			supported: 2,
			cause: new Error("outer", { cause: Object.assign(new Error("inner"), { code: "EIO" }) }),
		}),
	);
	assert.ok(isJournalCatalogError(schema), String(schema));
	assert.equal(schema.fields.found, null, "a null field crosses as null");
	const outer = schema.cause as Error;
	assert.deepEqual(
		[outer.message, (outer.cause as Error).message, (outer.cause as { readonly code?: unknown }).code],
		["outer", "inner", "EIO"],
	);
	const future = rehydrateError({
		name: "JournalFutureError",
		code: "future-code",
		message: "m",
		hint: "h",
		retryable: true,
		family: "journal-store",
		fields: { shardId: 1 },
	});
	assert.ok(isJournalStoreError(future), String(future));
	assert.deepEqual(
		[future.name, future.code, future.hint, future.retryable, future.message, future.fields.shardId],
		["JournalFutureError", "future-code", "h", true, "m", 1],
	);

	const sent = serializeError(shard);
	assert.equal(sent.family, "journal-store");
	for (const [envelope, field, expected] of [
		[{ ...sent, code: undefined }, "error.code", "a journal store error code"],
		[{ ...sent, retryable: undefined }, "error.retryable", "a boolean"],
		[
			{ ...sent, fields: { ...sent.fields, shardId: [3] } },
			"error.fields.shardId",
			"a string, number, boolean or null",
		],
		[{ ...sent, cause: { name: "Error" } }, "error.cause.message", "a string"],
	] as const) {
		const refused = rehydrateError(envelope);
		assert.ok(isPoolProtocolError(refused), `${field}: ${refused}`);
		assert.deepEqual([refused.field, refused.expected], [field, expected]);
	}
});

test("a fork error crosses as its own class with its fields, hint, cause and cleanup cause (#4327)", () => {
	const busy = new ForkSourceBusyError(
		{ runId: "source", reason: "foreign-lease", holderId: "holder" },
		{ cause: Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }) },
	).withCleanupCause(new Error("copy removal failed"));
	const crossed = hop(new WorkflowInfrastructureError("storage_unavailable", { cause: busy })).cause;
	assert.ok(crossed instanceof ForkSourceBusyError, String(crossed));
	assert.ok(isForkSourceBusyError(crossed));
	assert.deepEqual(
		[crossed.code, crossed.runId, crossed.reason, crossed.holderId, crossed.hint, crossed.retryable, crossed.message],
		[busy.code, "source", "foreign-lease", "holder", busy.hint, true, busy.message],
	);
	assert.deepEqual(crossed.fields, busy.fields);
	assert.deepEqual(
		[(crossed.cause as Error).message, (crossed.cause as { readonly code?: unknown }).code],
		["locked", "SQLITE_BUSY"],
	);
	assert.equal(crossed.cleanupCause?.message, "copy removal failed", "the cleanup failure stays beside the error");
	const future = rehydrateError({
		name: "ForkFutureError",
		code: "future-code",
		message: "m",
		hint: "h",
		retryable: false,
		family: "fork",
		fields: { runId: "r" },
	});
	assert.ok(isForkError(future), String(future));
	assert.deepEqual(
		[future.name, future.code, future.hint, future.retryable, future.message, future.fields.runId],
		["ForkFutureError", "future-code", "h", false, "m", "r"],
	);
	const sent = serializeError(busy);
	assert.equal(sent.family, "fork");
	for (const [envelope, field, expected] of [
		[{ ...sent, code: undefined }, "error.code", "a fork error code"],
		[{ ...sent, retryable: undefined }, "error.retryable", "a boolean"],
	] as const) {
		const refused = rehydrateError(envelope);
		assert.ok(isPoolProtocolError(refused), `${field}: ${refused}`);
		assert.deepEqual([refused.field, refused.expected], [field, expected]);
	}
});

test("journal store and fork errors keep their causes within the envelope's depth, as native causes (#4327)", () => {
	const chain = (length: number): Error => {
		let error = new Error("cause 0");
		for (let index = 1; index < length; index++) error = new Error(`cause ${index}`, { cause: error });
		return error;
	};
	const links = (envelope: SerializedError | undefined, key: "cause" | "cleanupCause"): number => {
		let count = 0;
		for (let current = envelope?.[key]; current !== undefined; current = current.cause) count++;
		return count;
	};
	const shard = new JournalShardUnavailableError({
		code: "shard-missing",
		shardId: 1,
		shardPath: "/journal/shard-1.sqlite",
		cause: chain(12),
	});
	assert.equal(links(serializeError(shard), "cause"), MAX_CAUSE_DEPTH - 1, "the error and its causes fill the depth");
	const fork = new ForkSourceBusyError({ runId: "source", reason: "foreign-lease" }, { cause: chain(12) });
	fork.withCleanupCause(chain(12));
	const sent = serializeError(fork);
	assert.equal(links(sent, "cause"), MAX_CAUSE_DEPTH - 1);
	assert.equal(links(sent, "cleanupCause"), MAX_CAUSE_DEPTH - 1, "a cleanup cause keeps the same depth");

	const native = Object.getOwnPropertyDescriptor(new Error("e", { cause: 1 }), "cause");
	for (const received of [hop(shard), hop(fork)]) {
		const descriptor = Object.getOwnPropertyDescriptor(received, "cause");
		assert.deepEqual({ ...descriptor, value: undefined }, { ...native, value: undefined }, received.name);
	}
	const uncleaned = hop(new ForkSourceBusyError({ runId: "source", reason: "foreign-lease" }));
	assert.ok(isForkSourceBusyError(uncleaned));
	const later = new Error("removed later");
	uncleaned.withCleanupCause(later);
	assert.equal(uncleaned.cleanupCause, later, "a rebuilt fork error takes its first cleanup failure as itself");
});

test("a shared placement error crosses as its own class, a copy from another realm too, an unknown one as the family base (#4327)", () => {
	const setup = new SharedPoolSetupError("local-pool", [sharedPoolProblems.localContainmentUnavailable("win32")]);
	const received = hop(new Error("outer", { cause: setup }));
	assert.ok(received.cause instanceof SharedPoolSetupError, String(received.cause));
	assert.equal(received.cause.operation, "local-pool");
	assert.deepEqual(received.cause.problems, setup.problems);
	assert.ok(isSharedPoolSetupError(received), "the guard reads the chain, as everywhere");
	assert.equal(isWorkerPlacementError(hop(new Error("plain", { cause: new Error("inner") }))), false);

	const lease = new StaleStageLeaseError("attempt-replaced", { root: "r", runId: "x", stageId: "s", seq: 4 });
	const copy = { ...JSON.parse(JSON.stringify(lease)), name: lease.name, message: lease.message, code: lease.code };
	const crossed = hop({ ...copy, hint: lease.hint, retryable: false, fields: () => ({}) });
	assert.ok(crossed instanceof StaleStageLeaseError, String(crossed));
	assert.deepEqual(
		[crossed.reason, crossed.root, crossed.runId, crossed.stageId, crossed.seq],
		["attempt-replaced", "r", "x", "s", 4],
	);

	const future = rehydrateError({
		name: "WorkerPlacementFutureError",
		code: "future-placement",
		message: "m",
		hint: "h",
		retryable: true,
		family: "worker-placement",
		fields: { reason: "later" },
	});
	assert.ok(future instanceof WorkerPlacementError, String(future));
	assert.deepEqual(
		[future.name, future.code, future.message, future.hint, future.retryable],
		["WorkerPlacementFutureError", "future-placement", "m", "h", true],
	);
	assert.deepEqual(serializeError(future).fields, { reason: "later" }, "a second hop keeps the fields it was sent");
	assert.equal(hop(future).name, "WorkerPlacementFutureError");
});

test("a shared placement error whose code, reason or fields are malformed is refused, naming the member (#4327)", () => {
	const config = serializeError(new WorkerPlacementConfigError("sdk", "workers.placement", "invalid-option", "d"));
	const setup = serializeError(new SharedPoolSetupError("worker-host", [sharedPoolProblems.adapterUnavailable("m")]));
	const restore = serializeError(new WorkspaceRestoreUnavailableError("no-restore-port", BINDING));
	const lease = serializeError(
		new StaleStageLeaseError("attempt-replaced", { root: "r", runId: "x", stageId: "s", seq: null }),
	);
	const problem = (setup.fields.problems as readonly { readonly [key: string]: SerializedErrorField }[])[0]!;
	const binding = restore.fields.binding as { readonly [key: string]: SerializedErrorField };
	const refusals: readonly (readonly [SerializedError, string, string])[] = [
		[
			{ ...config, code: "other" },
			"error.code",
			"one of invalid-option, requires-local-workers, unsupported-option, changed-on-resume",
		],
		[{ ...config, fields: { ...config.fields, source: "cli" } }, "error.fields.source", "one of sdk, settings, env"],
		[{ ...config, fields: { field: "f" } }, "error.fields.source", "one of sdk, settings, env"],
		[{ ...config, fields: { ...config.fields, detail: 7 } }, "error.fields.detail", "a string"],
		[
			{ ...setup, fields: { ...setup.fields, operation: "boot" } },
			"error.fields.operation",
			"one of shared-placement, worker-host, resume, local-pool",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: [] } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: "none" } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: [{ ...problem, code: "other" }] } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: [{ ...problem, subject: 1 }] } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: [{ ...problem, fields: [] }] } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: [null] } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...restore, fields: { ...restore.fields, reason: "later" } },
			"error.fields.reason",
			"one of no-restore-port, no-capable-host",
		],
		[
			{ ...restore, fields: { ...restore.fields, binding: null } },
			"error.fields.binding",
			"a workspace binding identity: remotes, head, tree and envHash",
		],
		[
			{ ...restore, fields: { ...restore.fields, binding: { ...binding, remotes: [1] } } },
			"error.fields.binding",
			"a workspace binding identity: remotes, head, tree and envHash",
		],
		[
			{ ...restore, fields: { ...restore.fields, binding: { ...binding, tree: 1 } } },
			"error.fields.binding",
			"a workspace binding identity: remotes, head, tree and envHash",
		],
		[
			{ ...restore, fields: { ...restore.fields, binding: { ...binding, head: 1 } } },
			"error.fields.binding",
			"a workspace binding identity: remotes, head, tree and envHash",
		],
		[
			{ ...restore, fields: { ...restore.fields, binding: { ...binding, envHash: null } } },
			"error.fields.binding",
			"a workspace binding identity: remotes, head, tree and envHash",
		],
		[
			{ ...restore, fields: { ...restore.fields, binding: { ...binding, remotes: ["https://ok.invalid/r", 1] } } },
			"error.fields.binding",
			"a workspace binding identity: remotes, head, tree and envHash",
		],
		[
			{ ...setup, fields: { ...setup.fields, problems: [{ ...problem, hint: 1 }] } },
			"error.fields.problems",
			"a non-empty list of shared pool setup problems",
		],
		[
			{ ...restore, fields: { ...restore.fields, claimWindowMs: "soon" } },
			"error.fields.claimWindowMs",
			"a finite number",
		],
		[
			{ ...lease, fields: { ...lease.fields, reason: "x" } },
			"error.fields.reason",
			"one of attempt-replaced, stage-lease-replaced",
		],
		[{ ...lease, fields: { ...lease.fields, seq: "4" } }, "error.fields.seq", "a finite number or null"],
		[{ ...lease, fields: { ...lease.fields, stageId: 3 } }, "error.fields.stageId", "a string"],
	];
	for (const [envelope, field, expected] of refusals) {
		const refused = rehydrateError(envelope);
		assert.ok(isPoolProtocolError(refused), `${field}: ${refused}`);
		assert.deepEqual([refused.field, refused.expected], [field, expected]);
	}
});

test("a group of errors crosses with its members in order, each with its own class, within the envelope's budget (#4327)", () => {
	const lost = new WorkerLostError({ phase: "delivery" });
	const group = new AggregateError([new RangeError("first"), lost, "not an error"], "three failed", {
		cause: new Error("why"),
	});
	const received = hop(group);
	assert.ok(received instanceof AggregateError, String(received));
	assert.equal(received.message, "three failed");
	assert.equal((received.cause as Error).message, "why");
	const [first, second, third] = received.errors as Error[];
	assert.deepEqual([first?.name, first?.message], ["RangeError", "first"]);
	assert.ok(second instanceof WorkerLostError);
	assert.equal(second.phase, "delivery");
	assert.deepEqual([third?.name, third?.message], [NON_ERROR_CAUSE, "not an error"]);

	const busy = new ForkSourceBusyError({ runId: "source", reason: "foreign-lease" })
		.withCleanupCause(new Error("copy removal failed"))
		.withCleanupCause(new Error("session removal failed"));
	const crossed = hop(new WorkflowInfrastructureError("storage_unavailable", { cause: busy })).cause;
	assert.ok(crossed instanceof ForkSourceBusyError, String(crossed));
	const cleanup = crossed.cleanupCause;
	assert.ok(cleanup instanceof AggregateError, "several cleanup failures stay a group");
	assert.deepEqual(
		cleanup.errors.map((failure: Error) => failure.message),
		["copy removal failed", "session removal failed"],
	);

	const members = Array.from({ length: 4 * MAX_SERIALIZED_ERRORS }, (_, index) => new Error(`member ${index}`));
	let count = 0;
	const visit = (node: SerializedError | undefined): void => {
		if (node === undefined) return;
		count++;
		visit(node.cause);
		visit(node.cleanupCause);
		for (const member of node.errors ?? []) visit(member);
	};
	visit(serializeError(new AggregateError(members, "many", { cause: new Error("cause") })));
	assert.equal(count, MAX_SERIALIZED_ERRORS, "members share the budget with causes");
	const deepest = (depth: number): Error =>
		depth === 0 ? new Error("leaf") : new AggregateError([deepest(depth - 1)]);
	let levels = 0;
	for (
		let node: SerializedError | undefined = serializeError(deepest(3 * MAX_CAUSE_DEPTH));
		node !== undefined;
		node = node.errors?.[0]
	)
		levels++;
	assert.equal(levels, MAX_CAUSE_DEPTH, "nested groups stop at the depth bound");
});

test("a group whose members are malformed or too many is refused, naming the member (#4327)", () => {
	const sent = serializeError(new AggregateError([new Error("a"), new Error("b")], "two failed"));
	assert.equal(sent.errors?.length, 2);
	for (const [envelope, field, expected] of [
		[{ ...sent, errors: "none" }, "error.errors", "an array of serialized errors"],
		[
			{ ...sent, errors: Array.from({ length: MAX_SERIALIZED_ERRORS + 1 }, () => sent.errors![0]!) },
			"error.errors",
			`at most ${MAX_SERIALIZED_ERRORS} serialized errors`,
		],
		[{ ...sent, errors: [sent.errors![0], { name: "Error" }] }, "error.errors[1].message", "a string"],
	] as const) {
		const refused = rehydrateError(envelope);
		assert.ok(isPoolProtocolError(refused), `${field}: ${refused}`);
		assert.deepEqual([refused.field, refused.expected], [field, expected]);
	}
	const budget = rehydrateError({
		name: "Error",
		message: "outer",
		fields: {},
		errors: Array.from({ length: MAX_SERIALIZED_ERRORS }, () => ({
			name: "AggregateError",
			message: "inner",
			fields: {},
			errors: [sent.errors![0]],
		})),
	});
	assert.ok(isPoolProtocolError(budget), "the members of one envelope share one budget");
	assert.equal(budget.expected, `at most ${MAX_SERIALIZED_ERRORS} serialized errors`);
});

test("every code, source, operation and reason of the shared placement errors crosses as sent (#4327)", () => {
	for (const source of ["sdk", "settings", "env"] as const)
		for (const code of [
			"invalid-option",
			"requires-local-workers",
			"unsupported-option",
			"changed-on-resume",
		] as const) {
			const received = hop(new WorkerPlacementConfigError(source, "field", code));
			assert.ok(received instanceof WorkerPlacementConfigError, `${source} ${code}: ${received}`);
			assert.deepEqual([received.source, received.code], [source, code]);
		}
	for (const operation of ["shared-placement", "worker-host", "resume", "local-pool"] as const)
		for (const code of [
			"shared-journal-required",
			"storage-adapter-unavailable",
			"journal-secret-unavailable",
			"git-unavailable",
			"process-containment-unavailable",
			"pool-on-another-host",
		] as const) {
			const problem = { code, subject: `a ${code}`, hint: "Fix it.", fields: { detail: code } };
			const received = hop(new SharedPoolSetupError(operation, [problem]));
			assert.ok(received instanceof SharedPoolSetupError, `${operation} ${code}: ${received}`);
			assert.deepEqual([received.operation, received.code, received.problems], [operation, code, [problem]]);
		}
	for (const reason of ["no-restore-port", "no-capable-host"] as const) {
		const received = hop(new WorkspaceRestoreUnavailableError(reason, BINDING));
		assert.ok(received instanceof WorkspaceRestoreUnavailableError, `${reason}: ${received}`);
		assert.equal(received.reason, reason);
		assert.deepEqual(received.binding, BINDING);
		assert.deepEqual([received.childRunId, received.claimWindowMs], [undefined, undefined]);
	}
	for (const reason of ["attempt-replaced", "stage-lease-replaced"] as const)
		for (const seq of [null, 0, 9]) {
			const received = hop(new StaleStageLeaseError(reason, { root: "r", runId: "x", stageId: "s", seq }));
			assert.ok(received instanceof StaleStageLeaseError, `${reason}: ${received}`);
			assert.deepEqual([received.reason, received.seq], [reason, seq]);
		}
	for (const kind of ["prompt-answer", "question-read", "user-message", "intercom-message"] as const) {
		const input = { root: "r", runId: "x", stageId: "s", seq: 3, kind };
		for (const reason of ["unknown-kind", "malformed-payload"] as const) {
			const received = hop(new StageInputInvalidError(reason, { kind, runId: "x", stageId: "s", field: "f" }));
			assert.ok(received instanceof StageInputInvalidError, `${reason}: ${received}`);
			assert.deepEqual([received.reason, received.kind], [reason, kind]);
		}
		for (const phase of ["unclaimed", "applying"] as const) {
			const received = hop(new StageInputTimeoutError(input, { timeoutMs: 1, elapsedMs: 2, phase }));
			assert.ok(received instanceof StageInputTimeoutError, `${phase}: ${received}`);
			assert.deepEqual([received.phase, received.kind, received.seq], [phase, kind, 3]);
		}
		for (const reason of ["stage-not-live", "session-replaced", "stage-failed", "pool-closed"] as const) {
			const received = hop(new StageInputRefusedError(reason, input));
			assert.ok(received instanceof StageInputRefusedError, `${reason}: ${received}`);
			assert.deepEqual([received.reason, received.kind, received.detail], [reason, kind, undefined]);
		}
	}
	for (const command of ["pause", "resume", "session"] as const) {
		const received = hop(new RemoteStageCommandUnsupportedError(command, { runId: "x", stageId: "s" }));
		assert.ok(received instanceof RemoteStageCommandUnsupportedError, `${command}: ${received}`);
		assert.equal(received.command, command);
	}
	const unknown = rehydrateError({
		name: "WorkerPlacementFutureError",
		code: "future-placement",
		message: "m",
		retryable: false,
		family: "worker-placement",
		fields: {},
	});
	assert.ok(unknown instanceof WorkerPlacementError);
	assert.equal(unknown.retryable, false, "a retryable flag that is not true is not retryable");
});

test("a received storage envelope's branches share the envelope's budget (#4327)", () => {
	const leaf = (name: string): SerializedError => ({ name, message: name, fields: {} });
	const chain = (key: "cause" | "rollbackCause" | "cleanupCause", length: number): SerializedError => {
		let node = leaf(`${key} ${length - 1}`);
		for (let index = length - 2; index >= 0; index--) node = { ...leaf(`${key} ${index}`), cause: node };
		return node;
	};
	const storage = (cause: number, rollback: number, cleanup: number): SerializedError => ({
		name: "StorageRollbackError",
		message: "storage",
		family: "storage",
		fields: {},
		...(cause === 0 ? {} : { cause: chain("cause", cause) }),
		...(rollback === 0 ? {} : { rollbackCause: chain("rollbackCause", rollback) }),
		...(cleanup === 0 ? {} : { cleanupCause: chain("cleanupCause", cleanup) }),
	});
	const nodes = (error: Error): number => {
		const { cause, rollbackCause, cleanupCause } = error as Error & {
			readonly rollbackCause?: unknown;
			readonly cleanupCause?: unknown;
		};
		let count = 1;
		for (const next of [cause, rollbackCause, cleanupCause]) if (next instanceof Error) count += nodes(next);
		return count;
	};
	const fits = rehydrateError(storage(7, 1, 7));
	assert.ok(fits instanceof StorageRollbackError, String(fits));
	assert.equal(nodes(fits), MAX_SERIALIZED_ERRORS, "an envelope of exactly the budget is rebuilt in full");
	const refused = rehydrateError(storage(7, 2, 7));
	assert.ok(isPoolProtocolError(refused), String(refused));
	assert.equal(refused.expected, `at most ${MAX_SERIALIZED_ERRORS} serialized errors`);
	assert.match(refused.field, /^error\.(cause|rollbackCause|cleanupCause)/);
});

test("a group's members are all sent, and the receiver's budget is exact at its edge (#4327)", () => {
	const group = (count: number): SerializedError => ({
		name: "AggregateError",
		message: "group",
		fields: {},
		errors: Array.from({ length: count }, (_, index) => ({ name: "Error", message: `member ${index}`, fields: {} })),
	});
	const sent = serializeError(
		new AggregateError(Array.from({ length: 4 * MAX_SERIALIZED_ERRORS }, (_, index) => new Error(`member ${index}`))),
	);
	assert.equal(sent.errors?.length, MAX_SERIALIZED_ERRORS - 1);
	assert.ok(sent.errors?.every((member) => member !== undefined && typeof member.message === "string"));

	const fits = rehydrateError(group(MAX_SERIALIZED_ERRORS - 1));
	assert.ok(fits instanceof AggregateError, String(fits));
	assert.equal(fits.errors.length, MAX_SERIALIZED_ERRORS - 1, "the envelope's last allowed error is rebuilt");
	const refused = rehydrateError(group(MAX_SERIALIZED_ERRORS));
	assert.ok(isPoolProtocolError(refused), String(refused));
	assert.deepEqual(
		[refused.field, refused.expected],
		[`error.errors[${MAX_SERIALIZED_ERRORS - 1}]`, `at most ${MAX_SERIALIZED_ERRORS} serialized errors`],
		"the first error past the budget is the one named",
	);

	let nested: SerializedError = { name: "Error", message: "deepest", fields: {} };
	for (let index = 0; index < MAX_CAUSE_DEPTH + 3; index++)
		nested = { name: "AggregateError", message: `group ${index}`, fields: {}, errors: [nested] };
	let levels = 0;
	for (
		let node: Error | undefined = rehydrateError(nested);
		node instanceof AggregateError;
		node = node.errors[0] as Error | undefined
	)
		levels++;
	assert.equal(levels, MAX_CAUSE_DEPTH, "members past the depth bound are left out");
});

test("errors keep class and fields over two hops, worker to coordinator to root (#4327)", () => {
	for (const kase of CASES) {
		const atCoordinator = hop(kase.error);
		const atRoot = hop(atCoordinator);
		assertSameError(atRoot, kase.error, kase);
		assert.deepEqual(serializeError(atRoot), serializeError(kase.error));
	}
});

test("a cause chain crosses with every level's class and a cleanup cause beside the primary error (#4327)", () => {
	const quarantine = new QuarantinedCapacityError({
		limits: ["admission.limits.process (1)"],
		processGroups: [7],
		waitedMs: 1,
	});
	const fenced = new WorkAttemptFencedError({ workId: "w", generation: 2 }, { cause: quarantine });
	const limit = new WorkerRetryLimitError(
		{ reason: "pool-fault", attempts: 3, limit: 3, childRunId: "child", exportName: "child" },
		{ cause: fenced },
	);
	const cleanup = new WorkerCleanupUnconfirmedError({ processGroups: [11] });
	Object.defineProperty(limit, "cleanupCause", { value: cleanup });
	const received = hop(limit);
	assert.ok(received instanceof WorkerRetryLimitError);
	assert.equal(received.code, "worker_retry_limit");
	assert.ok(received.cause instanceof WorkAttemptFencedError);
	assert.ok(received.cause.cause instanceof QuarantinedCapacityError);
	assert.deepEqual(received.cause.cause.processGroups, [7]);
	const receivedCleanup = (received as { readonly cleanupCause?: unknown }).cleanupCause;
	assert.ok(receivedCleanup instanceof WorkerCleanupUnconfirmedError);
	assert.deepEqual(receivedCleanup.processGroups, [11]);
	// The retry limit is what failed, whatever its cause names: wording never changes either code.
	assert.equal(infrastructureFaultOf(received), "worker_retry_limit");
	assert.equal(infrastructureFaultOf(received.cause), "worker_cleanup_unconfirmed");
});

test("an unknown name rehydrates into its family base keeping its name, code, hint and fields (#4327)", () => {
	const envelope = (family: SerializedError["family"], code: string | undefined): SerializedError => ({
		name: "FutureError",
		message: "Something new failed: x (future). Do the new thing.",
		...(code === undefined ? {} : { code }),
		hint: "Do the new thing.",
		retryable: true,
		...(family === undefined ? {} : { family }),
		fields: { workId: "w", attempts: [1, 2] },
	});
	const pool = rehydrateError(envelope("worker-pool", "future_code"));
	assert.ok(pool instanceof LocalWorkerPoolError);
	assert.equal(isLocalWorkerPoolError(pool), true);
	assert.equal(pool.name, "FutureError");
	assert.equal(pool.code, "future_code");
	assert.equal(pool.hint, "Do the new thing.");
	assert.equal(pool.retryable, true);
	assert.equal(pool.message, "Something new failed: x (future). Do the new thing.");
	// A second hop carries the fields the receiver could not interpret.
	assert.deepEqual(serializeError(pool).fields, { workId: "w", attempts: [1, 2] });
	assert.deepEqual(hop(pool), pool);

	const infrastructure = rehydrateError(envelope("workflow-infrastructure", "worker_lost"));
	assert.ok(infrastructure instanceof WorkflowInfrastructureError);
	assert.equal(infrastructure.name, "FutureError");
	assert.equal(infrastructure.code, "worker_lost");
	assert.equal(isRetryableWorkflowError(infrastructure), true);

	const journal = rehydrateError(envelope("journal", "future_code"));
	assert.ok(journal instanceof JournalError);
	assert.equal(journal.name, "FutureError");
	assert.equal((journal as { readonly code?: unknown }).code, "future_code");
	assert.equal((journal as { readonly hint?: unknown }).hint, "Do the new thing.");

	// A storage error the receiver does not know is the storage layer's to rebuild: its base class with its name, code
	// and scalar facts. Storage errors carry only scalar facts, so an array among them is a protocol violation.
	const storage = rehydrateError({ ...envelope("storage", "future_code"), fields: { workId: "w", attempts: 2 } });
	assert.ok(storage instanceof StorageError, String(storage));
	assert.equal(storage.name, "FutureError");
	assert.equal((storage as { readonly code?: unknown }).code, "future_code");
	assert.equal((storage as { readonly attempts?: unknown }).attempts, 2);
	const refused = rehydrateError(envelope("storage", undefined));
	assert.ok(isPoolProtocolError(refused), String(refused));
	assert.equal(refused.field, "error.fields.attempts");

	const foreign = rehydrateError(envelope(undefined, "ENOENT"));
	assert.equal(foreign.constructor, Error);
	assert.equal(foreign.name, "FutureError");
	assert.equal((foreign as { readonly code?: unknown }).code, "ENOENT");
	assert.equal((foreign as { readonly hint?: unknown }).hint, undefined);
});

test("journal errors outside the pool families cross as their family base, and storage errors as their own class (#4327)", () => {
	const closed = hop(new JournalClosedError());
	assert.ok(closed instanceof JournalError);
	assert.equal(closed.name, "JournalClosedError");
	assert.equal(closed.message, "Journal is closed");
	const unavailable = hop(new StorageUnavailableError({ adapter: "sqlite", location: "/j.db" }, new Error("busy")));
	assert.ok(unavailable instanceof StorageUnavailableError);
	assert.equal(unavailable.adapter, "sqlite");
	assert.equal(unavailable.location, "/j.db");
	assert.equal(infrastructureFaultOf(unavailable), "storage_unavailable");
	const plain = hop(Object.assign(new TypeError("bad input"), { code: "ERR_BAD" }));
	assert.equal(plain.name, "TypeError");
	assert.equal((plain as { readonly code?: unknown }).code, "ERR_BAD");
});

test("a degraded or unusable writers' queue crosses as its own storage class, and only the unusable one is an outage (#4327)", () => {
	const descriptor = { adapter: "node-sqlite", location: "/j.db" };
	const degraded = new StorageWriterQueueDegradedError(
		descriptor,
		"wake-failed",
		Object.assign(new Error("EMFILE"), { code: "EMFILE" }),
	);
	const slowed = hop(new WorkflowInfrastructureError("storage_unavailable", { cause: degraded })).cause;
	assert.ok(isStorageWriterQueueDegradedError(slowed), String(slowed));
	assert.ok(slowed instanceof StorageWriterQueueDegradedError);
	assert.deepEqual(
		[slowed.code, slowed.reason, slowed.adapter, slowed.location, slowed.hint, slowed.message],
		["writer-queue-degraded", "wake-failed", "node-sqlite", "/j.db", degraded.hint, degraded.message],
	);
	assert.equal(infrastructureFaultOf(slowed), undefined, "writers still take the lock in turn: no outage");

	const unusable = new StorageWriterQueueUnusableError(
		descriptor,
		Object.assign(new Error("EACCES"), { code: "EACCES" }),
	);
	const refused = hop(new WorkflowInfrastructureError("storage_unavailable", { cause: unusable })).cause;
	assert.ok(isStorageWriterQueueUnusableError(refused), String(refused));
	assert.ok(refused instanceof StorageWriterQueueUnusableError);
	assert.ok(refused instanceof StorageUnavailableError);
	assert.deepEqual(
		[refused.code, refused.errno, refused.adapter, refused.location, refused.hint],
		["writer-queue-unusable", "EACCES", "node-sqlite", "/j.db", unusable.hint],
	);
	assert.equal(infrastructureFaultOf(refused), "storage_unavailable");
});

test("storage errors cross as the storage layer serializes them: their class, code, facts and rollback, never their causes' text (#4327)", () => {
	const descriptor = { adapter: "sqlite", location: "/j.db" };
	const timeout = new StorageWriteLockTimeoutError(
		descriptor,
		{ timeoutMs: 5_000, elapsedMs: 5_012, phase: "queued", holderPid: 4_242, holderHeldMs: 6_000 },
		Object.assign(new Error("SQLITE_BUSY postgres://user:SENTINEL@db"), { errcode: 5, password: "SENTINEL" }),
	);
	const fault = new WorkflowInfrastructureError("storage_unavailable", { cause: timeout });
	const sent = serializeError(fault);
	assert.equal(JSON.stringify(sent).includes("SENTINEL"), false, JSON.stringify(sent));
	assert.equal(sent.cause?.family, "storage");
	assert.equal(sent.cause?.message, timeout.message, "the storage error's own message is built from safe parts");
	assert.deepEqual(sent.cause?.cause?.fields, {}, "a driver error under it keeps no facts");
	const received = rehydrateError(sent);
	assert.ok(isWorkflowInfrastructureError(received), String(received));
	const crossed = received.cause;
	assert.ok(isStorageWriteLockTimeoutError(crossed), String(crossed));
	assert.ok(crossed instanceof StorageWriteLockTimeoutError);
	assert.equal(crossed.code, "write-lock-timeout");
	assert.deepEqual(
		[crossed.adapter, crossed.location, crossed.timeoutMs, crossed.elapsedMs, crossed.phase, crossed.holderPid],
		["sqlite", "/j.db", 5_000, 5_012, "queued", 4_242],
	);
	assert.equal(crossed.message, timeout.message);
	assert.equal(infrastructureFaultOf(crossed), "storage_unavailable");
	assert.equal(isRetryableWorkflowError(received), true);

	const rollback = hop(new StorageRollbackError(new Error("write failed"), new StoreClosedError(descriptor)));
	assert.ok(rollback instanceof StorageRollbackError, String(rollback));
	assert.ok(rollback.rollbackCause instanceof StoreClosedError, String(rollback.rollbackCause));
	assert.equal(rollback.rollbackCause.location, "/j.db");
	assert.equal((rollback.cause as Error).message, "", "the failed write's text stays behind");

	// A cross-realm copy of a write-lock timeout is a storage outage too, and crosses as the class it names.
	const copy = {
		...structuredClone({ ...timeout }),
		name: timeout.name,
		code: timeout.code,
		message: timeout.message,
	};
	assert.equal(infrastructureFaultOf(copy), "storage_unavailable");
	assert.ok(isStorageWriteLockTimeoutError(rehydrateError(serializeError(copy))));
	assert.equal(
		infrastructureFaultOf({ name: "StorageWriterQueueUnusableError", code: "writer-queue-unusable" }),
		"storage_unavailable",
	);

	const malformed = { ...sent.cause!, cause: { name: "Error", message: "", fields: { detail: [1] } } };
	const refused = rehydrateError(malformed);
	assert.ok(isPoolProtocolError(refused), String(refused));
	assert.equal(refused.field, "error.cause.fields.detail");
	assert.equal(refused.expected, "a string, finite number or boolean");
	const notEnvelope = rehydrateError({ ...sent.cause!, rollbackCause: 5 });
	assert.ok(isPoolProtocolError(notEnvelope), String(notEnvelope));
	assert.equal(notEnvelope.field, "error.rollbackCause");
});

/** How many errors deep a chain is, following `cause` without a bound. */
function chainLength(error: unknown): number {
	let length = 0;
	for (let node = error; node instanceof Error; node = node.cause) length++;
	return length;
}

test("a storage error's chain crosses bounded, with its hint, its cleanup failure, and a copy's own text, code and hint (#4327)", () => {
	const descriptor = { adapter: "sqlite", location: "/j.db" };
	// A hint the storage error was given crosses, and the storage layer rebuilds the error with it.
	const config = hop(new StorageConfigError("settings", "storage.journal", "unknown adapter", "Install the adapter."));
	assert.ok(isStorageConfigError(config), String(config));
	assert.equal(config.hint, "Install the adapter.");

	// The cleanup failure attached to a storage error crosses beside it, without its text.
	const cleaned = Object.defineProperty(new StoreClosedError(descriptor), "cleanupCause", {
		value: new Error("close failed: SENTINEL"),
	});
	const sentCleaned = serializeError(cleaned);
	assert.equal(sentCleaned.cleanupCause?.name, "Error");
	assert.equal(sentCleaned.cleanupCause?.message, "");
	const receivedCleaned = rehydrateError(sentCleaned);
	assert.ok(receivedCleaned instanceof StoreClosedError, String(receivedCleaned));
	assert.equal((receivedCleaned as { readonly cleanupCause?: Error }).cleanupCause?.name, "Error");

	// A cause that is not an object keeps no facts.
	assert.deepEqual(serializeError(new StorageUnavailableError(descriptor, null)).cause?.fields, {});

	// Under other errors, a storage error's own chain stops at the bound of the whole chain, sent or received.
	let driver = new Error("driver");
	for (let index = 0; index < 2 * MAX_CAUSE_DEPTH; index++) driver = new Error(`driver ${index}`, { cause: driver });
	const outage = new StorageUnavailableError(descriptor, driver);
	let levels = 0;
	const nested = serializeError(new Error("outer", { cause: new Error("middle", { cause: outage }) }));
	for (let node: SerializedError | undefined = nested; node !== undefined; node = node.cause) levels++;
	assert.equal(levels, MAX_CAUSE_DEPTH);
	let deep: SerializedError = { name: "Error", message: "", fields: {} };
	for (let index = 0; index < 2 * MAX_CAUSE_DEPTH; index++)
		deep = { name: "StorageError", message: `level ${index}`, fields: {}, cause: deep };
	const received = rehydrateError({
		name: "Error",
		message: "outer",
		fields: {},
		cause: { name: "Error", message: "middle", fields: {}, cause: { ...deep, family: "storage" } },
	});
	assert.equal(chainLength(received), MAX_CAUSE_DEPTH);

	// A wide storage chain shares the envelope's budget.
	const chain = (depth: number): Error =>
		depth === 0 ? new Error("leaf") : new Error(`level ${depth}`, { cause: chain(depth - 1) });
	const wide = Object.defineProperty(
		new StorageRollbackError(chain(MAX_CAUSE_DEPTH), chain(MAX_CAUSE_DEPTH)),
		"cleanupCause",
		{
			value: chain(MAX_CAUSE_DEPTH),
		},
	);
	let count = 0;
	const visit = (node: SerializedError | undefined): void => {
		if (node === undefined) return;
		count++;
		visit(node.cause);
		visit(node.rollbackCause);
		visit(node.cleanupCause);
	};
	visit(serializeError(wide));
	assert.equal(count, MAX_SERIALIZED_ERRORS);

	// A copy of a storage outage from another realm crosses with its own text, code and hint, or with none.
	const copy = {
		name: "StorageUnavailableError",
		adapter: "a",
		location: "l",
		message: "Storage unavailable: a at l",
		code: "future-outage",
		hint: "Wait.",
	};
	const sentCopy = serializeError(copy);
	assert.deepEqual([sentCopy.message, sentCopy.code, sentCopy.hint], [copy.message, "future-outage", "Wait."]);
	assert.deepEqual(sentCopy.fields, { adapter: "a", location: "l" });
	const bare = serializeError({ name: "StorageUnavailableError", adapter: "a", location: "l" });
	assert.deepEqual([bare.message, bare.code, bare.hint], ["", undefined, undefined]);
	assert.ok(rehydrateError(bare) instanceof StorageUnavailableError);
	// A code or hint that is not text is left behind, so the copy still crosses as a valid envelope.
	const odd = serializeError({ name: "StorageUnavailableError", adapter: "a", location: "l", code: 5, hint: 6 });
	assert.deepEqual([odd.code, odd.hint], [undefined, undefined]);
	assert.ok(rehydrateError(odd) instanceof StorageUnavailableError);
});

test("cause chains are bounded and cycles end them (#4327)", () => {
	let deep: Error = new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason: "fenced" });
	for (let index = 0; index < 3 * MAX_CAUSE_DEPTH; index++) deep = new Error(`level ${index}`, { cause: deep });
	let levels = 0;
	for (let node: SerializedError | undefined = serializeError(deep); node !== undefined; node = node.cause) levels++;
	assert.equal(levels, MAX_CAUSE_DEPTH);
	assert.equal(causeChain(deep).length, MAX_CAUSE_DEPTH);
	assert.equal(causedByStaleWorkLease(deep), false);

	const first = new Error("first");
	const second = new Error("second", { cause: first });
	Object.defineProperty(first, "cause", { value: second });
	const received = hop(first);
	assert.equal(received.message, "first");
	assert.equal((received.cause as Error).message, "second");
	assert.equal((received.cause as Error).cause, undefined);

	// Causes and cleanup causes together stay within one budget.
	const wide = (depth: number): Error => {
		const error = new Error(`wide ${depth}`, depth === 0 ? undefined : { cause: wide(depth - 1) });
		if (depth > 0) Object.defineProperty(error, "cleanupCause", { value: wide(depth - 1) });
		return error;
	};
	let count = 0;
	const visit = (node: SerializedError | undefined): void => {
		if (node === undefined) return;
		count++;
		visit(node.cause);
		visit(node.cleanupCause);
	};
	visit(serializeError(wide(10)));
	assert.equal(count, MAX_SERIALIZED_ERRORS);
});

test("causes that are not errors keep only their type and primitive text (#4327)", () => {
	const received = hop(new Error("outer", { cause: "disk full" }));
	assert.equal(NON_ERROR_CAUSE, "NonErrorCause");
	assert.equal((received.cause as Error).name, "NonErrorCause");
	assert.equal((received.cause as Error).message, "disk full");
	const numeric = serializeError(new Error("outer", { cause: 5 })).cause;
	assert.deepEqual(numeric, { name: NON_ERROR_CAUSE, message: "5", fields: { type: "number" } });
	const nothing = serializeError(new Error("outer", { cause: null })).cause;
	assert.deepEqual(nothing, { name: NON_ERROR_CAUSE, message: "", fields: { type: "null" } });
	assert.deepEqual(serializeError(Symbol("s")), { name: NON_ERROR_CAUSE, message: "", fields: { type: "symbol" } });
	assert.deepEqual(serializeError(true), { name: "NonErrorCause", message: "true", fields: { type: "boolean" } });
	assert.deepEqual(
		serializeError(() => {}),
		{ name: "NonErrorCause", message: "", fields: { type: "function" } },
	);
	assert.deepEqual(serializeError(new StorageError("s")), {
		name: "StorageError",
		message: "s",
		family: "storage",
		fields: {},
	});
	assert.equal(Object.hasOwn(hop(new StaleLeaseError("r", 1, 2)), "cause"), false, "no cause unless one was sent");
	assert.equal(serializeError(new Error("no cause")).cause, undefined);
});

test("only declared fields cross: credentials and content on an error never enter the envelope (#4327)", () => {
	const sentinel = "sk-SENTINEL-credential";
	const typed = Object.assign(new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason: "fenced" }), {
		token: sentinel,
		inputs: { prompt: sentinel },
	});
	const plain = Object.assign(new Error("plain"), { token: sentinel, stderr: sentinel });
	for (const error of [typed, plain, new Error("wrapped", { cause: typed })])
		assert.equal(JSON.stringify(serializeError(error)).includes(sentinel), false);
});

test("a storage outage's causes cross with their identity but never their text (#4327)", () => {
	const sentinel = "postgres://pool:SENTINEL-password@db.internal/journal";
	const driver = Object.assign(new Error(`connect ECONNREFUSED ${sentinel}`, { cause: sentinel }), {
		code: "ECONNREFUSED",
	});
	const outage = new StorageUnavailableError({ adapter: "custom", location: "custom journal" }, driver, "Error");
	const envelope = serializeError(new WorkflowInfrastructureError("storage_unavailable", { cause: outage }));
	assert.equal(JSON.stringify(envelope).includes("SENTINEL"), false, JSON.stringify(envelope));
	const crossed = envelope.cause?.cause;
	assert.equal(crossed?.name, "Error");
	assert.equal(crossed?.code, "ECONNREFUSED");
	assert.equal(crossed?.message, "");
	assert.equal(crossed?.cause?.message, "");
	assert.equal(envelope.cause?.message, outage.message, "the outage's own message is built from safe parts");
	const plain = serializeError(new Error("outer", { cause: new Error("inner detail") }));
	assert.equal(plain.cause?.message, "inner detail", "causes outside a storage outage keep their text");
});

test("a malformed envelope yields a typed protocol error naming the member and what it expected (#4327)", () => {
	const valid = serializeError(new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason: "fenced" }));
	const json = "a JSON string, finite number, boolean, null, array or object";
	const families =
		"one of worker-pool, workflow-infrastructure, journal, storage, journal-store, fork, worker-placement, task-cleanup, stage-wait, tool-detachment, run-eviction, git-provision, git-required, workspace, session-start, decision, task-evicted, agent-rehydrate, background-compaction, github-copilot, debug, edit-tool, write-selector, shell-tool, llama-server, startup-benchmark, subscription, task-tool, task-message, intercom-broker";
	const nested = (depth: number): SerializedErrorField => (depth === 0 ? 1 : [nested(depth - 1)]);
	const cases: readonly (readonly [unknown, string, string])[] = [
		["Stale work lease", "error", "a serialized error"],
		[null, "error", "a serialized error"],
		[[valid], "error", "a serialized error"],
		[{ ...valid, name: 3 }, "error.name", "a string"],
		[{ ...valid, message: undefined }, "error.message", "a string"],
		[{ ...valid, code: 7 }, "error.code", "a string"],
		[{ ...valid, code: "publication_rejected" }, "error.code", "stale_work_lease, the code of StaleWorkLeaseError"],
		[{ ...valid, code: undefined }, "error.code", "stale_work_lease, the code of StaleWorkLeaseError"],
		[{ ...valid, hint: false }, "error.hint", "a string"],
		[{ ...valid, retryable: "yes" }, "error.retryable", "a boolean"],
		[{ ...valid, family: "other" }, "error.family", families],
		[{ ...valid, family: 4 }, "error.family", families],
		[{ ...valid, fields: "x" }, "error.fields", "an object"],
		[{ ...valid, fields: null }, "error.fields", "an object"],
		[{ ...valid, fields: [] }, "error.fields", "an object"],
		[
			{ ...valid, fields: { ...valid.fields, extra: { nested: Number.POSITIVE_INFINITY } } },
			"error.fields.extra",
			json,
		],
		[{ ...valid, fields: { ...valid.fields, extra: { nested: undefined } } }, "error.fields.extra", json],
		[{ ...valid, fields: { ...valid.fields, extra: Number.NaN } }, "error.fields.extra", json],
		[{ ...valid, fields: { ...valid.fields, extra: nested(MAX_CAUSE_DEPTH + 1) } }, "error.fields.extra", json],
		[{ ...valid, fields: { ...valid.fields, generation: "1" } }, "error.fields.generation", "a finite number"],
		[{ ...valid, fields: { ...valid.fields, root: 1 } }, "error.fields.root", "a string"],
		[
			{ ...valid, fields: { ...valid.fields, reason: "bored" } },
			"error.fields.reason",
			`one of ${STALE_WORK_LEASE_REASONS.join(", ")}`,
		],
		[{ ...valid, cause: { name: "Error" } }, "error.cause.message", "a string"],
		[{ ...valid, cleanupCause: 4 }, "error.cleanupCause", "a serialized error"],
		[
			{ name: "WorkflowInfrastructureError", message: "m", family: "workflow-infrastructure", fields: {} },
			"error.code",
			"a workflow infrastructure fault code",
		],
		[
			{
				...serializeError(new WorkerCleanupUnconfirmedError({ processGroups: [] })),
				fields: { processGroups: ["7"] },
			},
			"error.fields.processGroups",
			"an array of finite numbers",
		],
		[
			{
				...serializeError(new WorkerCleanupUnconfirmedError({ processGroups: [] })),
				fields: { processGroups: 7 },
			},
			"error.fields.processGroups",
			"an array of finite numbers",
		],
		[
			{
				...serializeError(new QuarantinedCapacityError({ limits: [], processGroups: [], waitedMs: 1 })),
				fields: { limits: ["a", 1], processGroups: [], waitedMs: 1 },
			},
			"error.fields.limits",
			"an array of strings",
		],
		[
			{
				...serializeError(new QuarantinedCapacityError({ limits: [], processGroups: [], waitedMs: 1 })),
				fields: { limits: "a", processGroups: [], waitedMs: 1 },
			},
			"error.fields.limits",
			"an array of strings",
		],
		[
			{
				...serializeError(new WorkerStartupTimeoutError({ logPath: "l", timeoutMs: 1, elapsedMs: 1 })),
				fields: { logPath: "l", timeoutMs: 1, elapsedMs: 1, phase: "run" },
			},
			"error.fields.phase",
			"one of startup",
		],
		[
			{ ...serializeError(new WorkerLostError({ phase: "delivery" })), fields: { phase: "delivery", pid: "7" } },
			"error.fields.pid",
			"a finite number",
		],
		[
			{ ...serializeError(new WorkerLostError({ phase: "delivery" })), fields: { phase: "delivery", signal: 9 } },
			"error.fields.signal",
			"a string",
		],
	];
	for (const [envelope, field, expected] of cases) {
		const error = rehydrateError(envelope);
		assert.ok(error instanceof PoolProtocolError, `${field}: ${error.name}`);
		assert.equal(error.code, "pool_protocol_invalid");
		assert.equal(error.field, field);
		assert.equal(error.expected, expected, field);
	}
	assert.deepEqual(
		hop(Object.assign(new LocalWorkerPoolError(FUTURE_CODE, "m", "h"), {})),
		new LocalWorkerPoolError(FUTURE_CODE, "m", "h"),
	);
});

test("a known name under another family is not trusted as that class (#4327)", () => {
	const envelope = { ...serializeError(new StaleLeaseError("r", 1, 2)), family: "worker-pool" as const };
	const error = rehydrateError(envelope);
	assert.equal(error instanceof StaleLeaseError, false);
	assert.ok(error instanceof LocalWorkerPoolError);
	assert.equal(error.name, "StaleLeaseError");
	assert.equal(isStaleLeaseError(error), true, "structurally it still names a stale lease");
});

test("an error from another realm that carries a known class's identity crosses with that class's fields (#4327)", () => {
	const foreign = Object.assign(new Error("Stale work lease from another realm"), {
		name: "StaleWorkLeaseError",
		code: "stale_work_lease",
		root: "root",
		workId: "work-9",
		generation: 4,
		reason: "superseded",
	});
	const envelope = serializeError(foreign);
	assert.deepEqual(envelope.fields, { root: "root", workId: "work-9", generation: 4, reason: "superseded" });
	const error = rehydrateError(envelope);
	assert.ok(error instanceof StaleWorkLeaseError, String(error));
	assert.equal(error.workId, "work-9");
	assert.equal(error.reason, "superseded");
});

test("only a protocol violation becomes a rehydrated error; any other failure while reading propagates (#4327)", () => {
	const failure = new Error("reading the envelope failed");
	const envelope = {
		get name(): string {
			throw failure;
		},
	};
	assert.throws(
		() => rehydrateError(envelope),
		(error: unknown) => error === failure,
	);
});

test("guards recognize an instance by its prototype even without its own name and code (#4327)", () => {
	const classes: readonly (readonly [(value: unknown) => boolean, abstract new (...args: never[]) => Error])[] = [
		[isAgentSessionBusyError, AgentSessionBusyError],
		[isIntercomRuntimeInactiveError, IntercomRuntimeInactiveError],
		[isStaleLeaseError, StaleLeaseError],
		[isPoolAppendRefusedError, PoolAppendRefusedError],
	];
	for (const [guard, type] of classes) assert.equal(guard(Object.create(type.prototype)), true, type.name);
});

test("structural guards recognize errors from other realms and reject near misses (#4327)", () => {
	assert.equal(isStaleWorkLeaseError({ name: "StaleWorkLeaseError", code: "stale_work_lease" }), true);
	assert.equal(isStaleWorkLeaseError({ name: "StaleWorkLeaseError", code: "stale_lease" }), false);
	assert.equal(isStaleWorkLeaseError({ name: "Error", code: "stale_work_lease" }), false);
	assert.equal(isStaleWorkLeaseError("StaleWorkLeaseError"), false);
	assert.equal(isStaleLeaseError({ name: "StaleLeaseError", code: "stale_lease" }), true);
	assert.equal(isStaleLeaseError({ name: "StaleLeaseError" }), false);
	assert.equal(isStaleLeaseError(null), false);
	assert.equal(isPoolAppendRefusedError({ name: "PoolAppendRefusedError", code: "pool_append_refused" }), true);
	assert.equal(isPoolAppendRefusedError({ name: "PoolAppendRefusedError", code: "x" }), false);
	assert.equal(isPoolAppendRefusedError(undefined), false);
	assert.equal(isLocalWorkerPoolError({ name: "PublicationRejectedError", code: "publication_rejected" }), true);
	assert.equal(isLocalWorkerPoolError({ name: "LocalWorkerPoolError", code: "stale_work_lease" }), true);
	assert.equal(
		isLocalWorkerPoolError({ name: "X", code: "publication_rejected" }),
		false,
		"a pool code under a foreign name",
	);
	assert.equal(isLocalWorkerPoolError({ name: "StaleWorkLeaseError", code: "stale_lease" }), false);
	assert.equal(isLocalWorkerPoolError({ name: 1, code: "publication_rejected" }), false);
	assert.equal(isLocalWorkerPoolError(null), false);
	assert.equal(isWorkflowInfrastructureError({ name: "WorkerLostError", code: "worker_lost", retryable: true }), true);
	assert.equal(isWorkflowInfrastructureError({ name: "WorkerLostError", code: "worker_lost" }), false);
	assert.equal(
		isWorkflowInfrastructureError({ name: "StaleWorkLeaseError", code: "stale_work_lease", retryable: true }),
		false,
	);
	assert.equal(isWorkerStartupError({ name: "WorkerStartupTimeoutError", code: "worker_startup_failed" }), true);
	assert.equal(isWorkerStartupTimeoutError({ name: "WorkerStartupError", code: "worker_startup_failed" }), false);
});

test("an outage from a subclass of StorageUnavailableError, whose name is its own, is still a storage outage (#4327)", () => {
	class AdapterUnavailableError extends StorageUnavailableError {}
	const outage = new AdapterUnavailableError({ adapter: "sqlite", location: "/j.db" }, new Error("busy"));
	assert.equal(outage.name, "AdapterUnavailableError");
	assert.equal(infrastructureFaultOf(outage), "storage_unavailable");
	assert.equal(workflowInfrastructureErrorFor(outage)?.code, "storage_unavailable");
});

test("former magic messages are no longer faults, fences or retryable without their types (#4327)", () => {
	const phrases = [
		"Local worker cleanup was not confirmed",
		"Local worker process cleanup unconfirmed; permits quarantined",
		"Local worker retry limit",
		"Local worker startup timed out after 500 ms",
		"Local worker exited before readiness",
		"Worker exited before delivery acknowledgement",
		"Local worker pool coordinator exited (SIGKILL)",
		"Stale work lease",
		"Stale resource admission attempt",
		"Intercom runtime no longer active",
		"Storage unavailable: sqlite at /j.db",
		"Stale lease for run root",
		"Pool stage publication is outside the work subtree: run",
	];
	for (const phrase of phrases)
		for (const error of [new Error(phrase), new Error("wrapped", { cause: new Error(phrase) }), phrase]) {
			assert.equal(infrastructureFaultOf(error), undefined, phrase);
			assert.equal(workflowInfrastructureErrorFor(error), undefined, phrase);
			assert.equal(isRetryableWorkflowError(error), false, phrase);
			assert.equal(causedByStaleWorkLease(error), false, phrase);
			assert.equal(isStaleLeaseError(error), false, phrase);
		}
});

test("typed faults keep their behavior whatever their message says (#4327)", () => {
	const reworded = Object.defineProperty(
		new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason: "fenced" }),
		"message",
		{ value: "entirely different wording" },
	);
	assert.equal(causedByStaleWorkLease(new Error("outer", { cause: reworded })), true);
	assert.equal(infrastructureFaultOf(reworded), "stale_work_lease");
	assert.equal(isRetryableWorkflowError(reworded), true);
	const translated = workflowInfrastructureErrorFor(new Error("outer", { cause: reworded }));
	assert.ok(translated instanceof WorkflowInfrastructureError);
	assert.equal(translated.code, "stale_work_lease");
	assert.ok(translated.cause instanceof Error);
	const own = new WorkerLostError({ phase: "delivery" });
	assert.equal(workflowInfrastructureErrorFor(own), own);
	const intercom = Object.assign(new Error("runtime ended"), {
		name: "IntercomRuntimeInactiveError",
		code: "intercom_unavailable",
	});
	assert.equal(infrastructureFaultOf(intercom), "intercom_unavailable");
	assert.equal(
		infrastructureFaultOf({ name: "StorageUnavailableError", adapter: "a", location: "l" }),
		"storage_unavailable",
	);
	assert.equal(infrastructureFaultOf({ name: "StorageUnavailableError", adapter: "a" }), undefined);
	assert.equal(infrastructureFaultOf({ name: "StorageUnavailableError", location: "l" }), undefined);
	assert.equal(infrastructureFaultOf({ name: "OtherError", adapter: "a", location: "l" }), undefined);
	assert.equal(infrastructureFaultOf({ name: "X", code: 4 }), undefined);
});

test("retryability comes from the type: pool errors only where replay can succeed (#4327)", () => {
	const rejected = (reason: "outside-subtree" | "stale-lease") =>
		new PublicationRejectedError({ root: "r", workId: "w", generation: 1, reason });
	assert.equal(rejected("stale-lease").retryable, true);
	assert.equal(isRetryableWorkflowError(rejected("stale-lease")), true);
	assert.equal(rejected("outside-subtree").retryable, false);
	assert.equal(isRetryableWorkflowError(rejected("outside-subtree")), false);
	assert.equal(isRetryableWorkflowError(new PoolNotInitializedError({ root: "r" })), false);
	assert.equal(isRetryableWorkflowError(new StaleLeaseError("r", 1, 2)), false);
	assert.equal(
		isRetryableWorkflowError(new Error("a", { cause: new Error("b", { cause: rejected("stale-lease") }) })),
		true,
	);
	assert.equal(isRetryableWorkflowError({ retryable: true }), false);
	assert.equal(isRetryableWorkflowError(undefined), false);
	// An abort reason stays the caller's: it is never an infrastructure fault.
	const abort = new DOMException("stopped", "AbortError");
	assert.equal(infrastructureFaultOf(abort), undefined);
	assert.equal(workflowInfrastructureErrorFor(abort), undefined);
});

test("a cancellation crosses the IPC as itself, never as a fault or a retryable error (#4327)", () => {
	const reason = new Error("stopped by the user");
	const abort = new DOMException("The operation was aborted", "AbortError");
	const envelope = serializeError(Object.assign(abort, { cause: reason }));
	assert.equal(envelope.name, "AbortError");
	assert.equal(envelope.code, undefined);
	assert.equal(envelope.family, undefined);
	assert.equal(envelope.retryable, undefined);
	const received = rehydrateError(envelope);
	assert.equal(received.name, "AbortError");
	assert.equal(received.message, "The operation was aborted");
	assert.equal((received as { code?: unknown }).code, undefined);
	assert.equal((received.cause as Error).message, "stopped by the user");
	assert.equal(infrastructureFaultOf(received), undefined);
	assert.equal(workflowInfrastructureErrorFor(received), undefined);
	assert.equal(isRetryableWorkflowError(received), false);
	assert.equal(isLocalWorkerPoolError(received), false);
});

test("a failed run's recorded fault codes, not its text, decide whether it failed on the pool (#4327)", () => {
	const failedStage = (failureCode: string | undefined, error = "Stale work lease") => ({
		id: "stage",
		status: "failed",
		error,
		...(failureCode === undefined ? {} : { failureCode }),
	});
	const fromStage = runInfrastructureFault({
		runId: "child",
		status: "failed",
		stages: [{ id: "ok", status: "completed", failureCode: "worker_lost" }, failedStage("stale_work_lease")],
	});
	assert.ok(fromStage instanceof WorkflowInfrastructureError);
	assert.equal(fromStage.code, "stale_work_lease");
	assert.equal(fromStage.runId, "child");
	assert.equal(fromStage.stageId, "stage");
	const fromRun = runInfrastructureFault({
		runId: "child",
		status: "failed",
		failure: { code: "storage_unavailable" },
	});
	assert.equal(fromRun?.runId, "child");
	const odd = runInfrastructureFault({
		runId: 5,
		status: "failed",
		stages: [null, "stage", { id: 7, status: "failed", failureCode: "worker_lost" }],
	});
	assert.equal(odd?.code, "worker_lost");
	assert.equal(odd?.runId, undefined, "a run id that is not a string is not kept");
	assert.equal(odd?.stageId, undefined, "a stage id that is not a string is not kept");
	assert.equal(fromRun?.code, "storage_unavailable");
	assert.equal(fromRun?.stageId, undefined);
	assert.equal(runInfrastructureFault({ status: "failed", failure: { code: "worker_lost" } })?.runId, undefined);
	for (const result of [
		{ status: "failed", error: "Stale work lease", stages: [failedStage(undefined)] },
		{ status: "failed", failure: { code: "rate_limited" }, stages: [failedStage("unknown")] },
		{ status: "completed", failure: { code: "worker_lost" } },
		{ status: "failed", failure: null, stages: "not stages" },
	])
		assert.equal(runInfrastructureFault(result), undefined);
});

test("messages render what failed, the subject, the code and the hint (#4327)", () => {
	assert.equal(
		stale.message,
		"Work attempt is no longer current: work work-1 generation 3 of root root (expired) (stale_work_lease). The pool replays the child from its last checkpoint under the attempt that owns its work now.",
	);
	assert.equal(
		new PoolNotInitializedError({ root: "root" }).message,
		"Worker pool is not initialized: root root (pool_not_initialized). Initialize the root's pool under its lease before running pool operations for it.",
	);
	assert.equal(
		new PoolNotInitializedError({}).message,
		"Worker pool is not initialized: no root prepared (pool_not_initialized). Initialize the root's pool under its lease before running pool operations for it.",
	);
	assert.equal(
		new PublicationRejectedError({ root: "r", workId: "w", generation: 2, reason: "stale-lease" }).message,
		"Pool stage publication rejected (stale-lease): work w generation 2 (publication_rejected). The publishing attempt no longer owns its work; the pool replays the child under its current attempt.",
	);
	assert.equal(
		new WorkAttemptFencedError({ workId: "w", generation: 2 }).message,
		"Work attempt fenced: work w generation 2 (work_attempt_fenced). The child replays from its last checkpoint; see `cause` for what ended the attempt.",
	);
	assert.equal(
		new PoolProtocolError({ field: "error.name", expected: "a string" }).message,
		"Invalid worker pool message: error.name is not a string (pool_protocol_invalid). Every process of a pool must run the same Atomic version; restart the root after an upgrade.",
	);
	assert.equal(
		new WorkflowInfrastructureError("storage_unavailable").message,
		"Storage unavailable: the workflow run (storage_unavailable). The workflow journal could not be reached; check the storage it names, then retry or resume.",
	);
	assert.equal(
		new WorkflowInfrastructureError("worker_lost", { runId: "run" }).message,
		"Local worker lost: run run (worker_lost). The pool replays the affected children from their last checkpoints; retry or resume the run if it failed.",
	);
	assert.equal(
		new WorkerLostError({ phase: "coordinator", pid: 9, exitCode: 1 }).message,
		"Local worker lost: pool coordinator process 9 exited (code 1) (worker_lost). The pool and its unfinished children failed; read the coordinator's log for why, and resume the root to start a new pool.",
	);
	assert.equal(
		new WorkerLostError({ phase: "coordinator", pid: 9, exitCode: 1, logPath: "/logs/coordinator.log" }).message,
		"Local worker lost: pool coordinator process 9 exited (code 1), log /logs/coordinator.log (worker_lost). The pool and its unfinished children failed; read the coordinator's log for why, and resume the root to start a new pool.",
	);
	assert.equal(
		new WorkerLostError({ phase: "coordinator", pid: 9, logPath: "/logs/coordinator.log", logFailure: "EACCES" })
			.message,
		"Local worker lost: pool coordinator process 9 exited, log /logs/coordinator.log could not be written: EACCES (worker_lost). The pool and its unfinished children failed; read the coordinator's log for why, and resume the root to start a new pool.",
	);
	assert.equal(
		new WorkerStartupError({ logPath: "/logs/w.log", logFailure: "ENOSPC" }).message,
		"Local worker startup failed: worker exited before readiness (log /logs/w.log could not be written: ENOSPC) (worker_startup_failed). Read the worker log for the cause; the pool runs no child on a worker that never became ready.",
	);
	assert.equal(
		new WorkerLostError({ phase: "delivery" }).message,
		"Local worker lost: worker process exited before it acknowledged a delivery (worker_lost). The pool replays the affected children from their last checkpoints; retry or resume the run if it failed.",
	);
	assert.equal(
		new WorkerStartupError({ logPath: "/w.log" }).message,
		"Local worker startup failed: worker exited before readiness (log /w.log) (worker_startup_failed). Read the worker log for the cause; the pool runs no child on a worker that never became ready.",
	);
	assert.equal(
		new WorkerStartupTimeoutError({ logPath: "/w.log", timeoutMs: 500, elapsedMs: 501 }).message,
		"Local worker startup failed: worker not ready after 500 ms (log /w.log) (worker_startup_failed). Workers were too slow to start, usually because the machine is busy or the pool is large for its cores. Raise workflows.localWorkers.startupTimeoutMs (localWorkers.startupTimeoutMs in the SDK) to allow more time.",
	);
	assert.equal(
		new WorkerRetryLimitError({ reason: "worker-lost", attempts: 3, limit: 3, childRunId: "c", exportName: "e" })
			.message,
		"Local worker retry limit: child c (e) lost its worker 3 times (worker_retry_limit). Only this child failed; retry it or resume the root once the fault in `cause` is fixed.",
	);
	assert.equal(
		new WorkerRetryLimitError({ reason: "worker-crashes", attempts: 4, limit: 3 }).message,
		"Local worker retry limit: 4 workers crashed without running a child, over the limit of 3 (worker_retry_limit). The pool stopped because its workers keep crashing; read their logs for the crash.",
	);
	assert.equal(
		new WorkerCleanupUnconfirmedError({ processGroups: [] }).message,
		"Local worker process cleanup unconfirmed: permits of stopped workers are still held (worker_cleanup_unconfirmed). Resource permits of the surviving process groups stay quarantined until they exit; stop them or restart the host.",
	);
	assert.equal(
		new QuarantinedCapacityError({ limits: ["a (1)", "b (2)"], processGroups: [3, 4], waitedMs: 1.6 }).message,
		"Local worker process cleanup unconfirmed: process permit refused after 2 ms: a (1) and b (2) held by quarantined permits of process groups 3, 4 that survived SIGKILL (worker_cleanup_unconfirmed). The child replays within its attempt limit; stop those process groups to free their capacity.",
	);
	assert.equal(
		new AdmissionHolderStoppedError({}).message,
		"Work attempt is no longer current: the admission holder was stopped (stale_work_lease). The pool stopped the worker that asked; the child replays within its attempt limit.",
	);
	assert.equal(
		new StaleLeaseError("run", 1, 2).message,
		"Stale lease for run run: held epoch 1, current epoch 2 (stale_lease). Another holder owns the run's journal lease now, or it was released; stop writing under this lease and resume the run to take it again.",
	);
	assert.equal(
		new PoolAppendRefusedError({ root: "r", workId: "w", generation: 1, reason: "foreign-root" }).message,
		"Pool delivery receipt refused (foreign-root): work w generation 1 of root r (pool_append_refused). The receipt was not written; the stage's undelivered messages stay queued for its current attempt.",
	);
});

test("every infrastructure fault code renders what failed, its default subject and its own hint (#4327)", () => {
	const expected = {
		worker_lost: ["Local worker lost", "The pool replays the affected children"],
		worker_cleanup_unconfirmed: ["Local worker process cleanup unconfirmed", "Resource permits of the surviving"],
		worker_retry_limit: ["Local worker retry limit", "Only this child failed"],
		worker_startup_failed: ["Local worker startup failed", "Read the worker log"],
		stale_work_lease: ["Work attempt is no longer current", "The pool replays the child from its last checkpoint"],
		intercom_unavailable: ["Intercom unavailable", "The stage's Intercom runtime ended"],
		storage_unavailable: ["Storage unavailable", "The workflow journal could not be reached"],
	} as const;
	const hints = new Set<string>();
	for (const [code, [what, hint]] of Object.entries(expected)) {
		const error = new WorkflowInfrastructureError(code as keyof typeof expected, { runId: "run", stageId: "stage" });
		assert.equal(error.message, `${what}: run run stage stage (${code}). ${error.hint}`);
		assert.ok(error.hint.startsWith(hint), error.hint);
		hints.add(error.hint);
		assert.equal(Object.hasOwn(error, "cause"), false, "no cause unless one was given");
	}
	assert.equal(hints.size, Object.keys(expected).length, "each fault has its own hint");
	const custom = new WorkflowInfrastructureError("worker_lost", {
		subject: "a subject",
		hint: "Do this.",
		cause: stale,
	});
	assert.equal(custom.message, "Local worker lost: a subject (worker_lost). Do this.");
	assert.equal(custom.cause, stale);
	assert.equal(new WorkflowInfrastructureError("worker_lost").runId, undefined);
	assert.equal(new WorkflowInfrastructureError("worker_lost", { runId: "r" }).stageId, undefined);
});

test("every publication rejection reason has its own hint, and only stale-lease is retryable (#4327)", () => {
	const hints = new Set<string>();
	for (const reason of [
		"outside-subtree",
		"boundary-unlinked",
		"stale-lease",
		"session-mismatch",
		"session-replaced",
	] as const) {
		const error = new PublicationRejectedError({ root: "r", workId: "w", generation: 1, reason, stageId: "s" });
		assert.equal(error.retryable, reason === "stale-lease", reason);
		assert.ok(error.hint.length > 0, reason);
		assert.equal(
			error.message,
			`Pool stage publication rejected (${reason}): stage s of work w generation 1 (publication_rejected). ${error.hint}`,
		);
		assert.equal(error.runId, undefined);
		assert.equal(error.sessionId, undefined);
		hints.add(error.hint);
	}
	assert.equal(hints.size, 5);
	assert.deepEqual(STALE_WORK_LEASE_REASONS.length, new Set(STALE_WORK_LEASE_REASONS).size);
	const full = new PublicationRejectedError({
		root: "r",
		workId: "w",
		generation: 1,
		reason: "session-replaced",
		runId: "run",
		stageId: "s",
		sessionId: "session",
	});
	assert.match(
		full.message,
		/^Pool stage publication rejected \(session-replaced\): run run, stage s, session session of work w/,
	);
});

test("the session's busy refusal and Intercom's inactive runtime are typed for the pool to act on (#4327)", () => {
	const busy = new AgentSessionBusyError();
	assert.equal(busy.name, "AgentSessionBusyError");
	assert.equal(busy.code, "agent_session_busy");
	assert.equal(busy.hint, "Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
	assert.equal(
		busy.message,
		"Agent is already processing: the session is running a turn (agent_session_busy). Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
	);
	assert.equal(isAgentSessionBusyError(busy), true);
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "agent_session_busy" }), true);
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "other" }), false);
	assert.equal(isAgentSessionBusyError({ name: "Error", code: "agent_session_busy" }), false);
	assert.equal(isAgentSessionBusyError(new Error("Agent is already processing")), false);
	assert.equal(isAgentSessionBusyError(null), false);
	assert.equal(isAgentSessionBusyError("AgentSessionBusyError"), false);

	const inactive = new IntercomRuntimeInactiveError({ cause: stale });
	assert.equal(inactive.name, "IntercomRuntimeInactiveError");
	assert.equal(inactive.code, "intercom_unavailable");
	assert.equal(inactive.cause, stale);
	assert.ok(inactive.hint.length > 0);
	assert.equal(
		inactive.message,
		`Intercom runtime no longer active: its session context ended (intercom_unavailable). ${inactive.hint}`,
	);
	assert.equal(isIntercomRuntimeInactiveError(inactive), true);
	assert.equal(isIntercomRuntimeInactiveError(hop(inactive)), true, "recognized by name and code after a hop");
	assert.equal(infrastructureFaultOf(hop(inactive)), "intercom_unavailable");
	assert.equal(isIntercomRuntimeInactiveError({ name: "IntercomRuntimeInactiveError", code: "x" }), false);
	assert.equal(isIntercomRuntimeInactiveError({ name: "X", code: "intercom_unavailable" }), false);
	assert.equal(isIntercomRuntimeInactiveError(new Error("Intercom runtime no longer active")), false);
	assert.equal(isIntercomRuntimeInactiveError(undefined), false);
	assert.equal(isIntercomRuntimeInactiveError(null), false);
});

test("a received envelope deeper than the bound keeps only the bounded chain (#4327)", () => {
	let envelope: SerializedError = { name: "Error", message: "deepest", fields: {} };
	for (let index = 0; index < 2 * MAX_CAUSE_DEPTH; index++)
		envelope = {
			name: "Error",
			message: `level ${index}`,
			fields: {},
			cause: envelope,
			...(index % 2 === 0 ? { cleanupCause: { name: "Error", message: "cleanup", fields: {} } } : {}),
		};
	let levels = 0;
	for (let node: unknown = rehydrateError(envelope); node instanceof Error; node = node.cause) levels++;
	assert.equal(levels, MAX_CAUSE_DEPTH);
	const shallow = rehydrateError({
		name: "Error",
		message: "top",
		fields: {},
		cleanupCause: { name: "StaleWorkLeaseError", message: "m", family: "worker-pool", fields: { bad: true } },
	});
	assert.ok(shallow instanceof PoolProtocolError, "an invalid cleanup cause invalidates the envelope");
	assert.equal(shallow.field, "error.cleanupCause.fields.root");
});

test("serialization reads only an error's own string code and hint, and family-specific retryability (#4327)", () => {
	const numeric = Object.assign(new Error("numeric"), { code: 404, hint: 7, retryable: true });
	assert.deepEqual(serializeError(numeric), { name: "Error", message: "numeric", fields: {} });
	const nameless = Object.assign(Object.create(null), { message: 3 }) as object;
	assert.deepEqual(serializeError(nameless), { name: "Error", message: "", fields: {} });
	const journal = Object.assign(new JournalError("j"), { retryable: false });
	assert.deepEqual(serializeError(journal), {
		name: "Error",
		message: "j",
		retryable: false,
		family: "journal",
		fields: {},
	});
	assert.equal(serializeError(new StorageError("s")).family, "storage");
	assert.equal(serializeError(new LocalWorkerPoolError(FUTURE_CODE, "m", "h")).retryable, false);
});

test("every reason of every typed refusal survives the IPC hop (#4327)", () => {
	for (const reason of [
		"missing",
		"not-leased",
		"generation-mismatch",
		"worker-mismatch",
		"epoch-mismatch",
		"expired",
		"root-not-running",
		"fenced",
		"superseded",
	] as const) {
		const received = hop(new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason }));
		assert.ok(received instanceof StaleWorkLeaseError);
		assert.equal(received.reason, reason);
	}
	for (const reason of [
		"outside-subtree",
		"boundary-unlinked",
		"stale-lease",
		"session-mismatch",
		"session-replaced",
	] as const) {
		const received = hop(new PublicationRejectedError({ root: "r", workId: "w", generation: 1, reason }));
		assert.ok(received instanceof PublicationRejectedError);
		assert.equal(received.reason, reason);
		assert.equal(received.retryable, reason === "stale-lease");
	}
	for (const reason of ["worker-lost", "refused-stale", "pool-fault", "worker-crashes"] as const) {
		const received = hop(new WorkerRetryLimitError({ reason, attempts: 3, limit: 3 }));
		assert.ok(received instanceof WorkerRetryLimitError);
		assert.equal(received.reason, reason);
	}
	for (const reason of ["foreign-root", "coordinator-authority", "attempt-refused"] as const) {
		const received = hop(new PoolAppendRefusedError({ root: "r", workId: "w", generation: 1, reason }));
		assert.ok(received instanceof PoolAppendRefusedError);
		assert.equal(received.reason, reason);
	}
	for (const phase of ["delivery", "coordinator"] as const) {
		const received = hop(new WorkerLostError({ phase }));
		assert.ok(received instanceof WorkerLostError);
		assert.equal(received.phase, phase);
	}
	const reasons = [STALE_WORK_LEASE_REASONS, PUBLICATION_REJECTED_REASONS, WORKER_RETRY_LIMIT_REASONS];
	for (const union of reasons) assert.equal(new Set(union).size, union.length);
	assert.ok(WORKER_RETRY_LIMIT_REASONS.every((reason) => reason.length > 0));
});

test("each guard recognizes its own class structurally and nothing else (#4327)", () => {
	const structural: readonly (readonly [(value: unknown) => boolean, string, string])[] = [
		[isLocalWorkerOptionsError, "LocalWorkerOptionsError", "invalid-lease"],
		[isLocalWorkerOptionsError, "LocalWorkerOptionsError", "invalid-heartbeat"],
		[isPoolNotInitializedError, "PoolNotInitializedError", "pool_not_initialized"],
		[isStaleWorkLeaseError, "StaleWorkLeaseError", "stale_work_lease"],
		[isPublicationRejectedError, "PublicationRejectedError", "publication_rejected"],
		[isWorkAttemptFencedError, "WorkAttemptFencedError", "work_attempt_fenced"],
		[isPoolProtocolError, "PoolProtocolError", "pool_protocol_invalid"],
		[isWorkerLostError, "WorkerLostError", "worker_lost"],
		[isWorkerStartupError, "WorkerStartupError", "worker_startup_failed"],
		[isWorkerStartupError, "WorkerStartupTimeoutError", "worker_startup_failed"],
		[isWorkerStartupTimeoutError, "WorkerStartupTimeoutError", "worker_startup_failed"],
		[isWorkerRetryLimitError, "WorkerRetryLimitError", "worker_retry_limit"],
		[isWorkerCleanupUnconfirmedError, "WorkerCleanupUnconfirmedError", "worker_cleanup_unconfirmed"],
		[isQuarantinedCapacityError, "QuarantinedCapacityError", "worker_cleanup_unconfirmed"],
		[isAdmissionHolderStoppedError, "AdmissionHolderStoppedError", "stale_work_lease"],
		[isStaleLeaseError, "StaleLeaseError", "stale_lease"],
		[isPoolAppendRefusedError, "PoolAppendRefusedError", "pool_append_refused"],
	];
	for (const [guard, name, code] of structural) {
		assert.equal(guard({ name, code }), true, `${name} ${code}`);
		assert.equal(guard({ name, code: `${code}_other` }), false, `${name} with another code`);
		assert.equal(guard({ name: `${name}Other`, code }), false, `${code} under another name`);
		assert.equal(guard({ code }), false);
		assert.equal(guard(null), false);
		assert.equal(guard(undefined), false);
		assert.equal(guard(name), false);
	}
	for (const name of [
		"WorkflowInfrastructureError",
		"WorkerLostError",
		"WorkerStartupError",
		"WorkerStartupTimeoutError",
		"WorkerRetryLimitError",
		"WorkerCleanupUnconfirmedError",
		"QuarantinedCapacityError",
		"AdmissionHolderStoppedError",
	]) {
		assert.equal(isWorkflowInfrastructureError({ name, code: "worker_lost", retryable: true }), true, name);
		assert.equal(isWorkflowInfrastructureError({ name, code: "lost", retryable: true }), false, name);
		assert.equal(isRetryableWorkflowError({ name, code: "storage_unavailable", retryable: true }), true, name);
	}
	assert.equal(isWorkflowInfrastructureError(null), false);
	for (const code of [
		"invalid-lease",
		"invalid-heartbeat",
		"pool_not_initialized",
		"stale_work_lease",
		"publication_rejected",
		"work_attempt_fenced",
		"pool_protocol_invalid",
	]) {
		assert.equal(isLocalWorkerPoolError({ name: "LocalWorkerPoolError", code }), true, code);
		assert.equal(isLocalWorkerPoolError({ name: "Future", code }), false, `${code} under a foreign name`);
	}
	assert.equal(isLocalWorkerPoolError({ name: "LocalWorkerPoolError" }), false);
	assert.equal(isLocalWorkerPoolError(undefined), false);
});

test("an infrastructure fault that carries stale_work_lease stays in its own family across a hop (#4327)", () => {
	const faults: readonly Error[] = [
		new AdmissionHolderStoppedError({ permitReason: "worker exit confirmed" }),
		new WorkflowInfrastructureError("stale_work_lease", { runId: "child" }),
	];
	for (const fault of faults) {
		assert.equal(isLocalWorkerPoolError(fault), false, fault.name);
		assert.equal(isWorkflowInfrastructureError(fault), true, fault.name);
		assert.equal(serializeError(fault).family, "workflow-infrastructure", fault.name);
	}
	const foreign = { name: "FutureInfraError", code: "stale_work_lease", message: "m", retryable: true };
	assert.equal(isLocalWorkerPoolError(foreign), false, "a pool code under a name of neither family");
	assert.equal(serializeError(foreign).family, undefined);
	const clone = {
		name: "AdmissionHolderStoppedError",
		code: "stale_work_lease",
		message: "m",
		retryable: true,
		permitReason: "host reboot confirmed",
	};
	const holder = rehydrateError(serializeError(clone));
	assert.ok(holder instanceof AdmissionHolderStoppedError, String(holder));
	assert.equal(holder.permitReason, "host reboot confirmed");
});

test("cause chains keep the error first and bound cleanup chains as they bound causes (#4327)", () => {
	const top = new Error("top", { cause: new Error("next") });
	assert.equal(causeChain(top)[0], top);
	assert.equal(causeChain(top).length, 2);
	assert.deepEqual(causeChain("text"), []);
	assert.deepEqual(causeChain(null), []);
	let cleanup: Error = new Error("cleanup 0");
	for (let index = 1; index < 3 * MAX_CAUSE_DEPTH; index++) {
		const next = new Error(`cleanup ${index}`);
		Object.defineProperty(next, "cleanupCause", { value: cleanup });
		cleanup = next;
	}
	let levels = 0;
	for (let node: SerializedError | undefined = serializeError(cleanup); node !== undefined; node = node.cleanupCause)
		levels++;
	assert.equal(levels, MAX_CAUSE_DEPTH);
	let envelope: SerializedError = { name: "Error", message: "deepest", fields: {} };
	for (let index = 0; index < 2 * MAX_CAUSE_DEPTH; index++)
		envelope = { name: "Error", message: `level ${index}`, fields: {}, cleanupCause: envelope };
	let received = 0;
	for (
		let node: unknown = rehydrateError(envelope);
		node instanceof Error;
		node = (node as { readonly cleanupCause?: unknown }).cleanupCause
	)
		received++;
	assert.equal(received, MAX_CAUSE_DEPTH);
});

test("unknown names fall back to their family base with defaults where the sender sent nothing (#4327)", () => {
	const pool = rehydrateError({ name: "Future", message: "m", family: "worker-pool", fields: {} });
	assert.ok(pool instanceof LocalWorkerPoolError);
	assert.equal(pool.code, "");
	assert.equal(pool.hint, "");
	assert.equal(pool.retryable, false);
	assert.equal(Object.hasOwn(pool, "cause"), false);
	const cause = new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason: "fenced" });
	const infrastructure = rehydrateError({
		name: "FutureFault",
		message: "m",
		code: "storage_unavailable",
		hint: "Check the disk.",
		family: "workflow-infrastructure",
		fields: { disk: "/dev/x", ok: null, flag: false },
		cause: serializeError(cause),
	});
	assert.ok(infrastructure instanceof WorkflowInfrastructureError);
	assert.equal(infrastructure.hint, "Check the disk.");
	assert.ok(infrastructure.cause instanceof StaleWorkLeaseError);
	assert.deepEqual(serializeError(infrastructure).fields, { disk: "/dev/x", ok: null, flag: false });
	const plain = rehydrateError({ name: "Weird", message: "m", hint: "ignored", fields: {} });
	assert.equal(plain.constructor, Error);
	assert.equal(Object.hasOwn(plain, "hint"), false, "only a family error carries a hint");
	assert.equal(Object.hasOwn(plain, "code"), false);
	const subclass = Object.defineProperty(new WorkflowInfrastructureError("worker_lost"), "name", {
		value: "FutureWorkerFault",
	});
	assert.equal(serializeError(subclass).family, "workflow-infrastructure");
	assert.equal(serializeError(new LocalWorkerPoolError(FUTURE_CODE, "m", "h")).family, "worker-pool");
	// The session store's own StorageUnavailableError is another class with the same name, adapter and location: it
	// crosses as a storage outage and stays one after the hop.
	const session = new SessionStorageUnavailableError({ adapter: "jsonl", location: "/s" }, new Error("io"));
	assert.equal(infrastructureFaultOf(session), "storage_unavailable");
	const sent = serializeError(session);
	assert.equal(sent.family, "storage");
	assert.deepEqual(sent.fields, { adapter: "jsonl", location: "/s" });
	const received = rehydrateError(sent);
	assert.ok(received instanceof StorageUnavailableError, String(received));
	assert.equal(received.adapter, "jsonl");
	assert.equal(received.location, "/s");
	assert.equal(infrastructureFaultOf(received), "storage_unavailable");
	assert.equal(serializeError({ name: "StorageUnavailableError", message: "m", adapter: "jsonl" }).family, undefined);
});

test("an infrastructure fault code this version does not know keeps its family, code and message (#4327)", () => {
	for (const name of ["WorkerOomError", "WorkflowInfrastructureError"]) {
		const received = rehydrateError({
			name,
			message: "Local worker out of memory: worker 7 (worker_oom). Lower maxWorkers.",
			code: "worker_oom",
			hint: "Lower maxWorkers.",
			retryable: true,
			family: "workflow-infrastructure",
			fields: { runId: "child" },
		});
		assert.ok(received instanceof WorkflowInfrastructureError, `${name}: ${String(received)}`);
		assert.equal(received.name, name);
		assert.equal(received.code, "worker_oom");
		assert.equal(received.hint, "Lower maxWorkers.");
		assert.equal(received.message, "Local worker out of memory: worker 7 (worker_oom). Lower maxWorkers.");
		assert.equal(isRetryableWorkflowError(received), true);
		assert.equal(infrastructureFaultOf(received), undefined, "an unknown code is not one of this version's faults");
	}
	const unhinted = rehydrateError({
		name: "WorkerOomError",
		message: "m",
		code: "worker_oom",
		family: "workflow-infrastructure",
		fields: {},
	});
	assert.ok(unhinted instanceof WorkflowInfrastructureError);
	assert.equal(unhinted.hint, "", "an unknown code borrows no other fault's hint");
	const unhintedBase = rehydrateError({
		name: "WorkflowInfrastructureError",
		message: "m",
		code: "worker_oom",
		family: "workflow-infrastructure",
		fields: {},
	});
	assert.ok(unhintedBase instanceof WorkflowInfrastructureError);
	assert.equal(unhintedBase.code, "worker_oom");
	assert.equal(unhintedBase.hint, "", "the family base named outright borrows no hint either");
	const known = rehydrateError({
		name: "WorkflowInfrastructureError",
		message: "m",
		code: "worker_lost",
		family: "workflow-infrastructure",
		fields: {},
	});
	assert.ok(known instanceof WorkflowInfrastructureError);
	assert.equal(known.hint, new WorkflowInfrastructureError("worker_lost").hint, "a known code keeps its own hint");
});

test("every class name of the worker pool family identifies it with a pool code (#4327)", () => {
	for (const name of [
		"LocalWorkerPoolError",
		"LocalWorkerOptionsError",
		"PoolNotInitializedError",
		"StaleWorkLeaseError",
		"PublicationRejectedError",
		"WorkAttemptFencedError",
		"PoolProtocolError",
	])
		assert.equal(isLocalWorkerPoolError({ name, code: "publication_rejected" }), true, name);
});

test("each fault class renders its own facts in its message (#4327)", () => {
	assert.equal(new LocalWorkerPoolError(FUTURE_CODE, "m", "h").name, "LocalWorkerPoolError");
	assert.equal(Object.hasOwn(new LocalWorkerPoolError(FUTURE_CODE, "m", "h"), "cause"), false);
	assert.equal(new LocalWorkerPoolError(FUTURE_CODE, "m", "h", { cause: stale }).cause, stale);
	const texts = {
		"worker-lost": "lost its worker",
		"refused-stale": "was refused by the root as stale",
		"pool-fault": "failed on a fault of the pool",
	} as const;
	for (const [reason, text] of Object.entries(texts))
		assert.equal(
			new WorkerRetryLimitError({
				reason: reason as keyof typeof texts,
				attempts: 2,
				limit: 3,
				childRunId: "c",
				exportName: "e",
			}).message.split(" (worker_retry_limit)")[0],
			`Local worker retry limit: child c (e) ${text} 2 times`,
		);
	assert.equal(
		new WorkerRetryLimitError({ reason: "worker-lost", attempts: 3, limit: 3, childRunId: "c" }).runId,
		"c",
	);
	assert.match(
		new WorkerCleanupUnconfirmedError({ processGroups: [7, 9] }).message,
		/^Local worker process cleanup unconfirmed: process groups 7, 9 still running after SIGKILL \(worker_cleanup_unconfirmed\)/,
	);
	assert.match(
		new AdmissionHolderStoppedError({ permitReason: "host reboot confirmed" }).message,
		/^Work attempt is no longer current: the admission holder was stopped \(host reboot confirmed\) \(stale_work_lease\)/,
	);
	assert.match(
		new WorkerLostError({ phase: "delivery", pid: 5, signal: "SIGTERM", exitCode: 1 }).message,
		/^Local worker lost: worker process 5 exited before it acknowledged a delivery \(SIGTERM\) \(worker_lost\)/,
	);
	assert.match(
		new WorkerLostError({ phase: "coordinator" }).message,
		/^Local worker lost: pool coordinator process exited \(worker_lost\)/,
	);
});

test("stale-lease catch handlers end a step quietly only on their own refusal (#4327)", () => {
	const staleWork = new StaleWorkLeaseError({ root: "r", workId: "w", generation: 1, reason: "superseded" });
	const staleRoot = new StaleLeaseError("r", 1, 2);
	const other = new Error("journal locked");
	assert.equal(ignoreStaleWorkLease(staleWork), undefined);
	assert.equal(ignoreStaleLease(staleRoot), undefined);
	for (const [handler, refused] of [
		[ignoreStaleWorkLease, staleRoot],
		[ignoreStaleWorkLease, other],
		[ignoreStaleLease, staleWork],
		[ignoreStaleLease, other],
	] as const)
		assert.throws(
			() => handler(refused),
			(error: unknown) => error === refused,
		);
});

test("a run result failed on a pool fault only when its classification recorded one (#4327)", () => {
	assert.equal(failedOnPoolFault({ status: "failed", runId: "c", failure: { code: "worker_lost" } }), true);
	assert.equal(
		failedOnPoolFault({
			status: "failed",
			runId: "c",
			stages: [{ id: "s", status: "failed", failureCode: "stale_work_lease" }],
		}),
		true,
	);
	assert.equal(failedOnPoolFault({ status: "failed", runId: "c", failure: { code: "child_failed" } }), false);
	assert.equal(failedOnPoolFault({ status: "completed", runId: "c", failure: { code: "worker_lost" } }), false);
});

test("the session's busy-refusal guard rejects values that are not objects (#4327)", () => {
	for (const value of [undefined, null, "AgentSessionBusyError", 7, true])
		assert.equal(isAgentSessionBusyError(value), false, String(value));
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "agent_session_busy" }), true);
});
