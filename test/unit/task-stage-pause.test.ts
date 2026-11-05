import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { isTaskCleanupError } from "../../packages/coding-agent/src/core/tasks/cleanup-error.js";
import type {
	Cleanup,
	OperationId,
	OwnerSnapshot,
	TaskRecord,
	TaskResult,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { cancelPausedOwnerTasks } from "../../packages/coding-agent/src/core/tasks/pause.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { StageSessionPause } from "../../packages/workflows/src/runs/foreground/stage-runner-pause.js";
import { createStageContext, type InternalStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

const intent = { kind: "agent" as const, agent: "worker", task: "Stage-owned work" };
const operation = () => randomUUID() as OperationId;
const idleRunner = () => ({
	result: new Promise<TaskResult>(() => {}),
	cleanup: Promise.resolve<Cleanup>({ kind: "reaped" }),
});

test("task pause survives stage replacement but does not fence a future stage generation", async () => {
	const boundary = new WorkflowStageAdmissionBoundary();
	const future = new WorkflowStageAdmissionBoundary();
	const sessionId = randomUUID();
	boundary.bindTaskIdentity(sessionId, "run", "stage");
	future.bindTaskIdentity(sessionId, "run", "stage");
	const host = boundary.bindAgentTaskHost({ authorizeLaunch() {} });
	try {
		await host.pauseTasks();
		const replacement = boundary.bindAgentTaskHost({ authorizeLaunch() {} });
		assert.equal(replacement, host);
		await assert.rejects(replacement.startAgentTask(intent, operation(), idleRunner), /paused/);
		const futureHost = future.bindAgentTaskHost({ authorizeLaunch() {} });
		assert.ok((await futureHost.startAgentTask(intent, operation(), idleRunner)).ok);
		assert.equal(boundary.isOpen(), true);
		let delivered = false;
		assert.equal(
			boundary.admit(
				"held-message",
				() => {
					delivered = true;
				},
				() => {
					throw new Error("late route");
				},
			).decision,
			"admitted",
		);
		assert.equal(delivered, true);
		replacement.resumeTasks();
		assert.ok((await replacement.startAgentTask(intent, operation(), idleRunner)).ok);
	} finally {
		await boundary.close();
		await future.close();
	}
});

test("stage pause reports cleanup failure only after other owned cleanup drains and rolls back the launch hold", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	const firstCleanup = Promise.withResolvers<Cleanup>();
	const secondCleanup = Promise.withResolvers<Cleanup>();
	let queuedMessagesPaused = false;
	const { session } = makeMockSession({
		pauseQueuedMessages() {
			queuedMessagesPaused = true;
		},
		async resumeQueuedMessages() {
			queuedMessagesPaused = false;
			return false;
		},
		pauseTasks: () => host.pauseTasks(),
		resumeTasks: () => host.resumeTasks(),
	});
	const pause = new StageSessionPause(() => session);
	try {
		for (const cleanup of [firstCleanup, secondCleanup]) {
			assert.ok(
				(
					await host.startAgentTask(intent, operation(), () => ({
						result: new Promise<TaskResult>(() => {}),
						cleanup: cleanup.promise,
					}))
				).ok,
			);
		}
		let finished = false;
		const pausing = pause.requestPause();
		const rejected = assert
			.rejects(pausing, (error) => {
				assert.ok(isTaskCleanupError(error), String(error));
				assert.equal(error.phase, "stage-pause");
				assert.deepEqual(
					error.failures.map((failure) => failure.resources),
					[[{ resource: "test-agent", code: "CleanupFailed", message: "release refused" }]],
				);
				return true;
			})
			.then(() => {
				finished = true;
			});
		firstCleanup.resolve({
			kind: "failed",
			resources: [{ resource: "test-agent", code: "CleanupFailed", message: "release refused" }],
		});
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(finished, false);
		assert.equal(queuedMessagesPaused, true);
		secondCleanup.resolve({ kind: "reaped" });
		await rejected;
		assert.equal(pause.isConfirmedPaused(), false);
		assert.equal(pause.isPaused(), false);
		assert.equal(queuedMessagesPaused, false);
		assert.ok(
			(await host.startAgentTask(intent, operation(), idleRunner)).ok,
			"failed pause rolls back its reversible launch hold",
		);
	} finally {
		firstCleanup.resolve({ kind: "reaped" });
		secondCleanup.resolve({ kind: "reaped" });
		const closed = await host.close("session-close");
		assert.ok(!closed.ok && closed.error.code === "CleanupFailed", "failed cleanup must remain visible");
	}
});

test("abort rejection cannot retire a stage pause while owned cleanup is pending", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	const cleanup = Promise.withResolvers<Cleanup>();
	const abortError = new Error("abort failed");
	const { session } = makeMockSession({
		pauseTasks: () => host.pauseTasks(),
		resumeTasks: () => host.resumeTasks(),
		async abort() {
			throw abortError;
		},
	});
	const pause = new StageSessionPause(() => session);
	try {
		assert.ok(
			(
				await host.startAgentTask(intent, operation(), () => ({
					result: new Promise<TaskResult>(() => {}),
					cleanup: cleanup.promise,
				}))
			).ok,
		);
		const pausing = pause.requestPause();
		const rejected = assert.rejects(pausing, (error) => error === abortError);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(pause.isPaused(), true);
		assert.equal(pause.isConfirmedPaused(), false);
		await assert.rejects(host.startAgentTask(intent, operation(), idleRunner), /paused/);
		cleanup.resolve({ kind: "reaped" });
		await rejected;
		assert.equal(pause.isPaused(), false);
		assert.ok((await host.startAgentTask(intent, operation(), idleRunner)).ok);
	} finally {
		cleanup.resolve({ kind: "reaped" });
		await host.close("session-close");
	}
});

test("pausing during fallback creation cancels the retired session's generation-owned tasks", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	const fallbackStarted = Promise.withResolvers<void>();
	const allowFallback = Promise.withResolvers<void>();
	let creations = 0;
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			adapters: {
				agentSession: {
					async create() {
						const primary = creations++ === 0;
						if (!primary) {
							fallbackStarted.resolve();
							await allowFallback.promise;
						}
						return makeMockSession({
							pauseTasks: () => host.pauseTasks(),
							resumeTasks: () => host.resumeTasks(),
							async prompt() {
								if (!primary) return "done";
								assert.ok((await host.startAgentTask(intent, operation(), idleRunner)).ok);
								throw new Error("429 rate limit exceeded");
							},
						}).session;
					},
				},
			},
		}),
	) as InternalStageContext;
	const prompting = ctx.prompt("work");
	try {
		await fallbackStarted.promise;
		await ctx.__requestPause();
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		try {
			assert.equal(watched.value.snapshot.tasks[0].execution.kind, "settled");
			assert.equal(watched.value.snapshot.tasks[0].cleanup.kind, "reaped");
		} finally {
			watched.value.dispose();
		}
		await assert.rejects(host.startAgentTask(intent, operation(), idleRunner), /paused/);
	} finally {
		allowFallback.resolve();
		await ctx.__resume();
		await prompting;
		await ctx.__dispose();
		await host.close("session-close");
	}
});

test("a pause waits for the quarantined cleanup of a command it stopped, not one that had already settled (#4338)", async () => {
	const quarantined: Cleanup = {
		kind: "quarantined",
		resources: [
			{ resource: "process-group:9", code: "CleanupUnconfirmed", message: "Output reader drain was not confirmed" },
		],
	};
	const record = (taskId: string, cleanup: Cleanup) =>
		({
			ref: { ownerId: "owner", taskId, attemptId: "1", generation: "1" },
			kind: "command",
			execution: { kind: "running" },
			cleanup,
		}) as unknown as TaskRecord;
	const snapshot = { tasks: [record("stopped", { kind: "active" }), record("raced", { kind: "active" })] };
	const subscription = {
		get snapshot() {
			return snapshot;
		},
		onReconcile: (_snapshot: OwnerSnapshot, _events: readonly never[]) => {},
		drain() {},
		dispose() {},
	};
	const settle = (taskId: string, cleanup: Cleanup) => {
		snapshot.tasks = snapshot.tasks.map((task) =>
			task.ref.taskId === taskId
				? ({
						...task,
						execution: { kind: "settled", result: { kind: "completed" } },
						cleanup,
					} as unknown as TaskRecord)
				: task,
		);
		subscription.onReconcile(snapshot as unknown as OwnerSnapshot, []);
	};
	const host = {
		watchOwnerTasks: () => ({ ok: true, value: subscription }),
		ownerBinding: { supervisor: { drainCommandAdmissions: async () => {} }, owner: {} },
		cancelTask: async (taskId: string) => {
			// "raced" finished on its own between the snapshot and its cancel, so nothing stopped it.
			if (taskId === "raced") settle("raced", quarantined);
			return {
				ok: true,
				value: {
					taskId,
					decision: taskId === "stopped" ? "cancellation-requested" : "already-settled",
					execution: { kind: "running" },
					cleanup: { kind: "active" },
				},
			};
		},
	} as unknown as AgentTaskHost;
	const idle = subscription.onReconcile;
	let paused = false;
	const pausing = cancelPausedOwnerTasks(host).then(() => {
		paused = true;
	});
	while (subscription.onReconcile === idle) await new Promise<void>((resolve) => setImmediate(resolve));
	settle("stopped", quarantined);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(paused, false, "the pause must wait for the cleanup of the command it stopped");
	settle("stopped", { kind: "reaped" });
	await pausing;
	assert.equal(paused, true, "an earlier quarantine is confirmed by the owner's close, not the pause");
});
