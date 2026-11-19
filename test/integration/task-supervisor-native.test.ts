import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import * as native from "@bastani/atomic-natives";
import { test, vi } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	type FakeExecution,
	type FakeRunnerContext,
	TaskSupervisor,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { bunExecutable, sleep, spawnSyncCollect } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const intent: C.AgentIntent = { kind: "agent", agent: "worker", task: "\n x \n", description: "" };
const operation = () => randomUUID() as C.OperationId;
function harness(factory?: (context: FakeRunnerContext) => FakeExecution, wait?: C.TaskWaitConfiguration) {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const contexts: FakeRunnerContext[] = [];
	const results: Array<ReturnType<typeof deferred<C.TaskResult>>> = [];
	const cleanups: Array<ReturnType<typeof deferred<C.Cleanup>>> = [];
	const host = supervisor.bindHostSession({
		scope,
		tasks: { wait },
		authorizeLaunch() {},
		createRunner(context) {
			contexts.push(context);
			if (factory) return factory(context);
			const result = deferred<C.TaskResult>();
			const cleanup = deferred<C.Cleanup>();
			results.push(result);
			cleanups.push(cleanup);
			context.signal.addEventListener(
				"abort",
				() => {
					result.resolve({ kind: "cancelled", cause: "owner-close" });
					cleanup.resolve({ kind: "reaped" });
				},
				{ once: true },
			);
			return { result: result.promise, cleanup: cleanup.promise };
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	return { supervisor, owner, host, scope, contexts, results, cleanups };
}
async function eventually(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check() && Date.now() < deadline) await sleep(5);
	assert.ok(check(), "condition must converge through bounded reconciliation");
}
function designatedWait(h: ReturnType<typeof harness>) {
	const watch = value(h.supervisor.watchOwnerTasks(h.owner));
	const observation = watch.snapshot.tasks[0].observation;
	watch.dispose();
	assert.equal(observation.kind, "foreground");
	if (observation.kind !== "foreground") throw new Error("missing designation");
	const wait = h.supervisor.findWait(observation.waitId);
	assert.ok(wait, "registration must precede the public promise's first await");
	return wait;
}

// RFC #2884: observation never relaunches or stops the admitted execution.
test("facade returns after setup, replays one execution and preserves identity across default, explicit and elapsed observations", async () => {
	const h = harness();
	const observe = vi.spyOn(h.supervisor, "observeTaskWait");
	try {
		const op = operation();
		const task = value(await h.supervisor.startAgentTask(h.owner, intent, op));
		const ref = h.supervisor.taskReference(task);
		assert.equal(h.contexts.length, 1);
		assert.equal(value(await h.supervisor.startAgentTask(h.owner, intent, op)), task);
		assert.equal(h.contexts.length, 1);
		assert.deepEqual(value(await h.supervisor.initialObservation(task)).kind, "yielded");
		const background = value(await h.supervisor.initialObservation(task));
		assert.equal(background.kind === "yielded" && background.reason, "default-background");
		const explicit = value(await h.supervisor.initialObservation(task, { kind: "background" }));
		assert.equal(explicit.kind === "yielded" && explicit.reason, "explicit");
		const foreground = value(await h.supervisor.initialObservation(task, { kind: "foreground", budgetMs: 0 }));
		assert.equal(foreground.kind === "yielded" && foreground.reason, "elapsed");
		observe.mockClear();
		const pending = h.supervisor.waitForTask(task, 0, h.host);
		assert.ok(pending instanceof Promise);
		// PR #2934: native expiry can release designation before the next JS snapshot.
		// Capture the real lease at the observation door, not from transient host focus.
		assert.equal(observe.mock.calls.length, 1);
		const wait = observe.mock.lastCall?.[0];
		assert.ok(wait, "registration must precede the public promise's first await");
		const JS_DESCHEDULE_MS = 50;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, JS_DESCHEDULE_MS);
		assert.equal(h.supervisor.findWait(h.supervisor.waitId(wait)), wait);
		const elapsed = value(await pending);
		assert.equal(elapsed.kind === "yielded" && elapsed.reason, "elapsed");
		assert.equal(elapsed.kind === "yielded" && elapsed.waitId, h.supervisor.waitId(wait));
		assert.equal(h.supervisor.findWait(h.supervisor.waitId(wait)), undefined);
		assert.deepEqual(h.supervisor.taskReference(task), ref);
		const watch = value(h.supervisor.watchOwnerTasks(h.owner));
		assert.equal(watch.snapshot.tasks[0].execution.kind, "running");
		assert.deepEqual(watch.snapshot.tasks[0].observation, { kind: "background", reason: "elapsed" });
		assert.equal(h.contexts[0].signal.aborted, false);
		watch.dispose();
		const conflict = await h.supervisor.startAgentTask(h.owner, { ...intent, task: "x" }, op);
		assert.equal(!conflict.ok && conflict.error.code, "OperationConflict");
		const second = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
		assert.notEqual(h.supervisor.taskReference(second).taskId, ref.taskId);
		assert.equal(h.contexts.length, 2);
	} finally {
		observe.mockRestore();
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884: ready terminal outcomes win before initial observation, exactly once.
test("terminal-before-return is settled and cannot restart its runner", async () => {
	const h = harness(() => ({
		result: Promise.resolve({ kind: "failed", code: "fixture", message: "", exitCode: 0 }),
		cleanup: Promise.resolve({ kind: "reaped" }),
	}));
	const op = operation();
	try {
		const task = value(await h.supervisor.startAgentTask(h.owner, intent, op));
		const observed = value(await h.supervisor.initialObservation(task));
		assert.deepEqual(observed, {
			kind: "settled",
			taskId: h.supervisor.taskReference(task).taskId,
			result: { kind: "failed", code: "fixture", message: "", exitCode: 0 },
		});
		assert.equal(value(await h.supervisor.startAgentTask(h.owner, intent, op)), task);
		assert.equal(h.contexts.length, 1);
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884 D1: SDK observations never take designated host focus.
test("designation replacement, SDK yield and observer disposal leave the same execution alive", async () => {
	const h = harness();
	try {
		const task = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
		const first = h.supervisor.waitForTask(task, undefined, h.host);
		const w1 = designatedWait(h);
		await h.supervisor.waitForTask(task, 0);
		const snapshot = () => {
			const watch = value(h.supervisor.watchOwnerTasks(h.owner));
			const state = watch.snapshot;
			watch.dispose();
			return state;
		};
		assert.deepEqual(snapshot().tasks[0].observation, { kind: "foreground", waitId: h.supervisor.waitId(w1) });
		const third = h.supervisor.waitForTask(task, undefined, h.host);
		const w3 = designatedWait(h);
		value(h.supervisor.yieldTaskWait(w1, "intercom-coordination"));
		assert.equal(value(await first).kind, "yielded");
		assert.deepEqual(snapshot().tasks[0].observation, { kind: "foreground", waitId: h.supervisor.waitId(w3) });
		value(h.supervisor.disposeTaskWait(w3));
		const disposed = await third;
		assert.equal(!disposed.ok && disposed.error.code, "ObserverCancelled");
		// RFC #2884: a delayed yield replays disposal instead of throwing at the mapper.
		assert.deepEqual(h.supervisor.yieldTaskWait(w3, "explicit"), disposed);
		assert.deepEqual(h.supervisor.yieldTaskWait(w3, "intercom-coordination"), disposed);
		assert.deepEqual(snapshot().tasks[0].observation, { kind: "background", reason: "observer-cancelled" });
		assert.equal(snapshot().tasks[0].execution.kind, "running");
		assert.equal(h.contexts[0].signal.aborted, false);
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884: host authority precedes admission; strings and copied objects confer none.
test("authorization denial admits nothing, scope and wrong-owner IDs are refused, capabilities cannot serialize", async () => {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = {
		kind: "workflow-stage",
		sessionId: randomUUID(),
		runId: "r",
		stageId: "s",
		stageAttemptId: "a",
	};
	let runners = 0;
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {
			throw new Error("existing delegation refusal");
		},
		createRunner() {
			runners++;
			throw new Error("must not run");
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const mismatch = supervisor.openTaskOwner(host, { ...scope, stageAttemptId: "stale" });
	assert.equal(!mismatch.ok && mismatch.error.code, "ScopeMismatch");
	await assert.rejects(supervisor.startAgentTask(owner, intent, operation()), /existing delegation refusal/);
	assert.equal(runners, 0);
	const watch = value(supervisor.watchOwnerTasks(owner));
	assert.deepEqual(watch.snapshot.tasks, []);
	watch.dispose();
	assert.throws(() => JSON.stringify(host), /not serializable/);
	assert.throws(() => JSON.stringify(owner), /not serializable/);
	const other = harness();
	try {
		const task = value(await other.supervisor.startAgentTask(other.owner, intent, operation()));
		const refused = await supervisor.waitForTaskId(owner, other.supervisor.taskReference(task).taskId);
		assert.equal(!refused.ok && refused.error.code, "UnknownTask");
		assert.throws(() => supervisor.taskReference(structuredClone(task)), /Foreign task/);
		const pending = other.supervisor.waitForTask(task, undefined, other.host);
		const wait = designatedWait(other);
		assert.throws(() => JSON.stringify(task), /not serializable/);
		assert.throws(() => JSON.stringify(wait), /not serializable/);
		value(other.supervisor.disposeTaskWait(wait));
		await pending;
	} finally {
		value(await other.supervisor.closeTaskOwner(other.owner, "session-close"));
		value(await supervisor.closeTaskOwner(owner, "stage-close"));
	}
});

// RFC #2884: closing seals immediately but cannot claim reaping from an outcome.
test("owner-close seals admission and waits for explicit cleanup after cooperative stop", async () => {
	const result = deferred<C.TaskResult>();
	const cleanup = deferred<C.Cleanup>();
	let signal: AbortSignal | undefined;
	const h = harness((context) => {
		signal = context.signal;
		return { result: result.promise, cleanup: cleanup.promise };
	});
	const task = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
	const wait = h.supervisor.waitForTask(task);
	let closed = false;
	const close = h.supervisor.closeTaskOwner(h.owner, "session-close").then((receipt) => {
		closed = true;
		return receipt;
	});
	assert.equal(signal?.aborted, true);
	const refused = await h.supervisor.startAgentTask(h.owner, intent, operation());
	assert.equal(!refused.ok && refused.error.code, "OwnerClosing");
	result.resolve({ kind: "failed", code: "late", message: "late outcome is not cleanup" });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(closed, false);
	cleanup.resolve({ kind: "reaped" });
	const receipt = value(await close);
	assert.equal(receipt.tasks[0].cleanup.kind, "reaped");
	const observed = value(await wait);
	assert.equal(observed.kind === "settled" && observed.result.kind, "cancelled");
	assert.equal(h.contexts.length, 1);
});

// RFC #2884: zero patches, raw attention, exact report replay and ordered journal facts.
test("metrics and attention retain absent, empty, zero and report identity", async () => {
	const h = harness();
	try {
		await h.supervisor.startAgentTask(h.owner, intent, operation());
		const watch = value(h.supervisor.watchOwnerTasks(h.owner));
		assert.equal(Object.hasOwn(watch.snapshot.tasks[0], "metrics"), false);
		const context = h.contexts[0];
		const report: C.ActivityReport = { reportId: "zero", change: { kind: "metrics", toolCount: 0 } };
		value(context.reportActivity(report));
		assert.equal(value(context.reportActivity(report)).disposition, "duplicate");
		const conflict = context.reportActivity({ reportId: "zero", change: { kind: "metrics", toolCount: 1 } });
		assert.equal(!conflict.ok && conflict.error.code, "ReportConflict");
		value(
			context.reportActivity({
				reportId: "attention",
				change: {
					kind: "attention-set",
					attention: {
						kind: "input-needed",
						requestId: "q8",
						prompt: "",
						route: { sessionId: h.scope.sessionId, promptId: "q8" },
					},
				},
			}),
		);
		value(context.reportActivity({ reportId: "stale-clear", change: { kind: "attention-clear", requestId: "q7" } }));
		watch.drain();
		assert.deepEqual(watch.snapshot.tasks[0].metrics, { toolCount: 0 });
		assert.equal(watch.snapshot.tasks[0].attention.kind, "input-needed");
		const iterator = watch.events[Symbol.asyncIterator]();
		const first = await iterator.next();
		const second = await iterator.next();
		assert.equal(first.done, false);
		assert.equal(second.done, false);
		if (!first.done && !second.done)
			assert.ok(BigInt(first.value.cursor.sequence) < BigInt(second.value.cursor.sequence));
		watch.dispose();
		assert.equal((await iterator.next()).done, true);
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// PR #2902: callback disposal must stop publication from the active native drain.
test("disposal during reconciliation ends pending and new subscription reads", async () => {
	const h = harness();
	try {
		value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
		const watch = value(h.supervisor.watchOwnerTasks(h.owner));
		const pending = watch.events[Symbol.asyncIterator]().next();
		let reconciled = false;
		watch.onReconcile = () => {
			reconciled = true;
			watch.dispose();
		};
		value(
			h.contexts[0].reportActivity({
				reportId: "dispose",
				change: { kind: "action", tool: "read", text: "latest" },
			}),
		);
		watch.drain();
		assert.equal(reconciled, true);
		assert.equal(watch.snapshot.tasks[0].currentAction?.text, "latest");
		assert.deepEqual(await pending, { done: true, value: undefined });
		assert.deepEqual(await watch.events[Symbol.asyncIterator]().next(), { done: true, value: undefined });
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884: the final oversized event may leave no authentic native wake at all.
test("bounded fallback poll reconciles evicted final activity in its captured async context", async () => {
	const h = harness();
	const storage = new AsyncLocalStorage<string>();
	let restored: string | undefined;
	try {
		await h.supervisor.startAgentTask(h.owner, intent, operation());
		const watch = storage.run("owner-context", () => value(h.supervisor.watchOwnerTasks(h.owner)));
		watch.onReconcile = () => {
			restored = storage.getStore();
		};
		const text = "x".repeat(2 * 1024 * 1024);
		value(
			h.contexts[0].reportActivity({ reportId: "oversized-final", change: { kind: "action", tool: "read", text } }),
		);
		await eventually(() => watch.snapshot.tasks[0].currentAction?.text === text);
		assert.equal(restored, "owner-context");
		watch.dispose();
		const iterator = watch.events[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).done, true);
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884: native capabilities cannot cross the structured-clone environment boundary.
test("native runner replay, stale generation and cross-environment capability boundaries are enforced", async () => {
	const actor = new native.TaskSupervisor();
	const scope: native.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const host = actor.bindHostSession(scope);
	const owner = value(actor.openTaskOwner(host, scope));
	const task = value(actor.startAgentTask(owner, intent, operation()));
	const runner = value(actor.claimTaskRunner(task));
	const duplicateRunner = actor.claimTaskRunner(task);
	assert.equal(duplicateRunner.ok, false);
	const watch = value(actor.watchOwnerTasks(owner, (_event) => {}));
	const stale = actor.watchOwnerTasks(owner, (_event) => {}, { generation: "stale", sequence: "9007199254740993" });
	assert.equal(!stale.ok && stale.error.code, "StaleGeneration");
	const worker = new Worker(
		`
		const { parentPort, workerData } = require("node:worker_threads");
		const { TaskSupervisor } = require(workerData.module);
		const actor = new TaskSupervisor();
		const host = actor.bindHostSession(workerData.scope);
		const owner = actor.openTaskOwner(host, workerData.scope).value;
		const found = actor.lookupTask(owner, workerData.taskId);
		let copied = "accepted";
		try { actor.reportTaskActivity(workerData.runner, { reportId: "foreign", change: { kind: "metrics", tokenCount: 0 } }); }
		catch (error) { copied = error.message; }
		actor.closeTaskOwner(owner, "session-close").then((closed) => {
			parentPort.postMessage({ refusal: found.ok ? "accepted" : found.error.code, copied, closed: closed.ok });
		});
	`,
		{
			eval: true,
			workerData: {
				module: createRequire(import.meta.url).resolve("@bastani/atomic-natives"),
				scope,
				taskId: value(actor.taskReference(task)).taskId,
				runner,
			},
		},
	);
	try {
		const received = await new Promise<{ refusal: string; copied: string; closed: boolean }>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
		assert.equal(received.refusal, "UnknownTask");
		assert.match(received.copied, /recover.*RunnerLease/i);
		assert.equal(received.closed, true);
	} finally {
		await worker.terminate();
	}
	const report: native.OutcomeReport = {
		reportId: "terminal",
		result: { kind: "failed", code: "fixture", message: "" },
	};
	const receipt = value(actor.reportTaskOutcome(runner, report));
	assert.deepEqual(value(actor.reportTaskOutcome(runner, report)), receipt);
	const conflicting = actor.reportTaskOutcome(runner, {
		reportId: "later",
		result: { kind: "cancelled", cause: "user" },
	});
	assert.equal(conflicting.ok, false);
	const late = actor.reportTaskActivity(runner, { reportId: "late", change: { kind: "metrics", tokenCount: 0 } });
	assert.equal(!late.ok && late.error.code, "TaskTerminal");
	value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
	actor.disposeSubscription(watch.lease);
	value(await actor.closeTaskOwner(owner, "session-close"));
	const reopened = actor.openTaskOwner(host, scope);
	assert.equal(reopened.ok, false);
});

// RFC #2884: the last settlement remains visible even when no valid wake survives.
test("oversized final settlement is recovered without cleanup or any later event", async () => {
	const h = harness();
	const task = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
	const watch = value(h.supervisor.watchOwnerTasks(h.owner));
	const message = "terminal".repeat(128 * 1024);
	h.results[0].resolve({ kind: "failed", code: "large", message });
	await eventually(() => watch.snapshot.tasks[0].execution.kind === "settled");
	const execution = watch.snapshot.tasks[0].execution;
	assert.deepEqual(execution, { kind: "settled", result: { kind: "failed", code: "large", message } });
	assert.equal(watch.snapshot.tasks[0].cleanup.kind, "active");
	assert.deepEqual(watch.snapshot.tasks[0].ref, h.supervisor.taskReference(task));
	h.cleanups[0].resolve({ kind: "reaped" });
	value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	assert.equal(watch.snapshot.state, "closed");
	let count = 0;
	for await (const event of watch.events) {
		assert.equal(event.schemaVersion, 1);
		count++;
	}
	assert.ok(count <= 64);
});

// RFC #2884: slow consumers reconcile a snapshot rather than silently losing terminal facts.
test("bounded iterable overflow and throwing consumers preserve final closure", async () => {
	const h = harness();
	await h.supervisor.startAgentTask(h.owner, intent, operation());
	const watch = value(h.supervisor.watchOwnerTasks(h.owner));
	watch.onReconcile = () => {
		throw new Error("consumer failed");
	};
	for (let index = 0; index < 150; index++) {
		value(
			h.contexts[0].reportActivity({ reportId: `burst-${index}`, change: { kind: "metrics", toolCount: index } }),
		);
		watch.drain();
	}
	assert.equal(watch.failure?.message, "consumer failed");
	assert.deepEqual(watch.snapshot.tasks[0].metrics, { toolCount: 149 });
	value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	assert.equal(watch.snapshot.state, "closed");
	assert.equal(watch.snapshot.tasks[0].execution.kind, "settled");
	assert.equal(watch.snapshot.tasks[0].cleanup.kind, "reaped");
	let count = 0;
	for await (const event of watch.events) {
		assert.equal(event.schemaVersion, 1);
		count++;
	}
	assert.ok(count <= 64);
	watch.dispose();
	watch.dispose();
});

// RFC #2884: cancellation commits first; a late success is refused until confirmed stop.
test("native cancellation retains late output and cleanup failure keeps owner closing until reaped retry", async () => {
	const actor = new native.TaskSupervisor();
	const scope: native.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const owner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
	const task = value(actor.startAgentTask(owner, intent, operation()));
	const runner = value(actor.claimTaskRunner(task));
	const ref = value(actor.taskReference(task));
	const watch = value(actor.watchOwnerTasks(owner, (_event) => {}));
	const output: native.OutputRef = {
		ownerId: ref.ownerId,
		taskId: ref.taskId,
		artifactId: " raw artifact ",
		byteCount: "9007199254740993",
		omittedRanges: [
			{ start: "0", end: "0" },
			{ start: "0", end: "0" },
		],
	};
	value(actor.cancelTask(task, "user"));
	const late = actor.reportTaskOutcome(runner, {
		reportId: "late-success",
		result: { kind: "completed", output, exitCode: 0 },
	});
	assert.equal(!late.ok && late.error.code, "ReportConflict");
	const resources = [{ resource: "fixture", code: "busy", message: " raw diagnostic " }];
	value(actor.acknowledgeTaskCleanup(runner, { kind: "failed", resources }));
	const failed = await actor.closeTaskOwner(owner, "session-close");
	assert.equal(!failed.ok && failed.error.code, "CleanupFailed");
	const drained = value(actor.drainOwnerTasks(watch.lease));
	assert.equal(
		drained.events.some((event) => event.payload.kind === "owner-closed"),
		false,
	);
	const cancelled = actor.cancelTask(task, "shutdown");
	assert.equal(!cancelled.ok && cancelled.error.code, "CleanupFailed");
	value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
	const receipt = value(await actor.closeTaskOwner(owner, "session-close"));
	assert.deepEqual(receipt.tasks[0].execution, {
		kind: "settled",
		result: { kind: "cancelled", cause: "user", output },
	});
	assert.equal(receipt.tasks[0].cleanup.kind, "reaped");
	actor.disposeSubscription(watch.lease);
});

// RFC #2884: a native owner close from another actor instance reaches the retained JS execution.
test("same-scope replay converges and native external cancellation bridges through the live subscription", async () => {
	const h = harness();
	assert.equal(value(h.supervisor.openTaskOwner(h.host, h.scope)), h.owner);
	await h.supervisor.startAgentTask(h.owner, intent, operation());
	const actor = new native.TaskSupervisor();
	const owner = value(actor.openTaskOwner(actor.bindHostSession(h.scope), h.scope));
	const close = actor.closeTaskOwner(owner, "session-close");
	await eventually(() => h.contexts[0].signal.aborted);
	assert.equal(value(await close).tasks[0].cleanup.kind, "reaped");
	value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
});

// RFC #2884: facade instances share the same environment's execution continuation.
test("operation replay across facade instances returns the original lease without a second execution", async () => {
	// PR #2934: designation identity needs a wait that cannot expire during inspection.
	const h = harness(undefined, { kind: "until-settled" });
	try {
		const op = operation();
		const task = value(await h.supervisor.startAgentTask(h.owner, intent, op));
		const peer = new TaskSupervisor();
		assert.equal(value(peer.openTaskOwner(h.host, h.scope)), h.owner);
		assert.equal(value(await peer.startAgentTask(h.owner, intent, op)), task);
		assert.equal(h.contexts.length, 1);
		const pending = peer.waitForTask(task, undefined, h.host);
		const wait = designatedWait(h);
		assert.equal(h.supervisor.findWait(peer.waitId(wait)), wait);
		value(h.supervisor.yieldTaskWait(wait, "explicit"));
		assert.equal(value(await pending).kind, "yielded");
		assert.equal(h.supervisor.findWait(peer.waitId(wait)), undefined);
		assert.equal(h.contexts[0].signal.aborted, false);
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884: confirmed stop after cancellation does not require a late result.
test("cancelled cleanup closes the owner while the independent result stays pending", async () => {
	const result = deferred<C.TaskResult>();
	const cleanup = deferred<C.Cleanup>();
	const h = harness(() => ({ result: result.promise, cleanup: cleanup.promise }));
	await h.supervisor.startAgentTask(h.owner, intent, operation());
	let closed = false;
	const closing = h.supervisor.closeTaskOwner(h.owner, "session-close").then((receipt) => {
		value(receipt);
		closed = true;
		return receipt;
	});
	try {
		cleanup.resolve({ kind: "reaped" });
		await eventually(() => closed);
		assert.equal(value(await closing).tasks[0].cleanup.kind, "reaped");
	} finally {
		result.resolve({ kind: "cancelled", cause: "owner-close" });
		await closing;
	}
});

// RFC #2884: owner lifetime includes resources attached to an accepted natural result.
test("external native owner close aborts settled but unreaped resources without rewriting result", async () => {
	const result = deferred<C.TaskResult>();
	const cleanup = deferred<C.Cleanup>();
	const natural: C.TaskResult = { kind: "failed", code: "natural", message: "", exitCode: 0 };
	const h = harness(({ signal }) => {
		signal.addEventListener("abort", () => cleanup.resolve({ kind: "reaped" }), { once: true });
		return { result: result.promise, cleanup: cleanup.promise };
	});
	await h.supervisor.startAgentTask(h.owner, intent, operation());
	const watch = value(h.supervisor.watchOwnerTasks(h.owner));
	result.resolve(natural);
	await eventually(() => watch.snapshot.tasks[0].execution.kind === "settled");
	assert.equal(watch.snapshot.tasks[0].cleanup.kind, "active");
	const peer = new native.TaskSupervisor();
	const owner = value(peer.openTaskOwner(peer.bindHostSession(h.scope), h.scope));
	const closing = peer.closeTaskOwner(owner, "session-close");
	try {
		await eventually(() => h.contexts[0].signal.aborted);
		const receipt = value(await closing);
		assert.deepEqual(receipt.tasks[0].execution, { kind: "settled", result: natural });
		assert.equal(receipt.tasks[0].cleanup.kind, "reaped");
	} finally {
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
		await closing;
	}
});

// RFC #2884: reconnect retains exact cursor argument and non-serializable lease identity.
test("watch reconnect accepts a cursor and exposes a stable opaque subscription lease", async () => {
	const h = harness();
	try {
		await h.supervisor.startAgentTask(h.owner, intent, operation());
		const first = value(h.supervisor.watchOwnerTasks(h.owner));
		const from = first.cursor;
		first.dispose();
		const watch = value(h.supervisor.watchOwnerTasks(h.owner, from));
		assert.deepEqual(watch.cursor, from);
		assert.equal(watch.lease, watch.lease);
		assert.notEqual(watch.lease, first.lease);
		assert.throws(() => JSON.stringify(watch.lease), /not serializable/);
		watch.dispose();
		watch.dispose();
		assert.equal((await watch.events[Symbol.asyncIterator]().next()).done, true);
	} finally {
		value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	}
});

// RFC #2884: verify the real native registration budget without a >30s suite test.
test("requested agent waits apply owner defaults, until-settled and highest-priority per-call budgets", async () => {
	const waitDoor = vi.spyOn(native.TaskSupervisor.prototype, "waitForTask");
	try {
		for (const [configuration, expected] of [
			[undefined, 30000],
			[{ kind: "automatic", commandBudgetMs: 17 }, 30000],
			[{ kind: "automatic", agentBudgetMs: 7 }, 7],
			[{ kind: "automatic", agentBudgetMs: 0 }, 0],
			[{ kind: "until-settled" }, undefined],
		] satisfies Array<[C.TaskWaitConfiguration | undefined, number | undefined]>) {
			const h = harness(undefined, configuration);
			try {
				const task = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
				const pending = [h.supervisor.waitForTask(task)];
				assert.equal(waitDoor.mock.lastCall?.[1], expected);
				pending.push(h.supervisor.waitForTaskId(h.owner, h.supervisor.taskReference(task).taskId));
				assert.equal(waitDoor.mock.lastCall?.[1], expected);
				pending.push(h.supervisor.initialObservation(task, { kind: "foreground" }));
				assert.equal(waitDoor.mock.lastCall?.[1], expected);
				pending.push(h.supervisor.waitForTask(task, 0));
				assert.equal(waitDoor.mock.lastCall?.[1], 0);
				pending.push(h.supervisor.initialObservation(task, { kind: "foreground", budgetMs: 0 }));
				assert.equal(waitDoor.mock.lastCall?.[1], 0);
				assert.equal(value(await h.supervisor.initialObservation(task)).kind, "yielded");
				assert.equal(h.contexts[0].signal.aborted, false);
				value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
				for (const observed of await Promise.all(pending)) value(observed);
			} finally {
				value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			}
		}
	} finally {
		waitDoor.mockRestore();
	}
});

// RFC #2884: exercise generated N-API numeric conversion in both supported runtimes.
test("Node and Bun preserve wide explicit wait and foreground budgets", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "test/fixtures/task-s1-wide-budget.mjs"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /WIDE BUDGET PRESERVED/);
	}
});

// RFC #2884: natural cleanup-first must not publish reaped before the natural result.
test("natural result and cleanup are independent in either delivery order", async () => {
	for (const cleanupFirst of [true, false]) {
		const result = deferred<C.TaskResult>();
		const cleanup = deferred<C.Cleanup>();
		const h = harness(() => ({ result: result.promise, cleanup: cleanup.promise }));
		const natural: C.TaskResult = { kind: "failed", code: "natural", message: "", exitCode: 0 };
		const task = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
		const watch = value(h.supervisor.watchOwnerTasks(h.owner));
		try {
			if (cleanupFirst) {
				cleanup.resolve({ kind: "reaped" });
				await sleep(0);
				watch.drain();
				assert.equal(watch.snapshot.tasks[0].execution.kind, "running");
				assert.equal(watch.snapshot.tasks[0].cleanup.kind, "active");
				result.resolve(natural);
			} else {
				result.resolve(natural);
				await eventually(() => watch.snapshot.tasks[0].execution.kind === "settled");
				assert.equal(watch.snapshot.tasks[0].cleanup.kind, "active");
				cleanup.resolve({ kind: "reaped" });
			}
			await eventually(() => watch.snapshot.tasks[0].cleanup.kind === "reaped");
			assert.deepEqual(value(await h.supervisor.waitForTask(task)), {
				kind: "settled",
				taskId: h.supervisor.taskReference(task).taskId,
				result: natural,
			});
			const cancelled = h.supervisor.cancelTask(task, "user");
			assert.ok(cancelled instanceof Promise);
			assert.equal(value(await cancelled.then((receipt) => receipt)).decision, "already-settled");
			assert.equal(h.contexts[0].signal.aborted, false);
		} finally {
			result.resolve(natural);
			cleanup.resolve({ kind: "reaped" });
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
		}
	}
});

// RFC #2884: abort must also release cleanup that was already waiting on a result.
test("cleanup received before cancellation can close without a result", async () => {
	const result = deferred<C.TaskResult>();
	const cleanup = deferred<C.Cleanup>();
	const h = harness(() => ({ result: result.promise, cleanup: cleanup.promise }));
	const task = value(await h.supervisor.startAgentTask(h.owner, intent, operation()));
	cleanup.resolve({ kind: "reaped" });
	await sleep(0);
	const requested = h.supervisor.cancelTask(task, "user");
	assert.ok(requested instanceof Promise);
	assert.equal(value(await requested).decision, "cancellation-requested");
	let closed = false;
	const closing = h.supervisor.closeTaskOwner(h.owner, "session-close").then((receipt) => {
		closed = true;
		return value(receipt);
	});
	try {
		await eventually(() => closed);
		assert.deepEqual((await closing).tasks[0].execution, {
			kind: "settled",
			result: { kind: "cancelled", cause: "user" },
		});
	} finally {
		result.resolve({ kind: "cancelled", cause: "user" });
		await closing;
	}
});

// RFC #2884: numeric TaskResult fields are numbers, not signed 32-bit exit statuses.
test("Node and Bun preserve exact exit codes and reject numerically distinct replays", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "test/fixtures/task-s1-exit-codes.mjs"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /EXIT CODES PRESERVED 26/);
	}
});

// RFC #2884: reconnecting at the same cursor cannot change attention or cleanup facts.
test("Node and Bun keep cancellation, settlement and owner-close projections consistent", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([
			runtime,
			"--import",
			"jiti/register",
			"test/fixtures/task-s1-projections.ts",
			"attention",
		]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /ATTENTION PROJECTIONS CONSISTENT 3/);
	}
});

// RFC #2884: no optional callback or later cleanup may be needed to wake the last observer.
test("Node and Bun expose bounded overflow and native reset through iterator completion", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([
			runtime,
			"--import",
			"jiti/register",
			"test/fixtures/task-s1-projections.ts",
			"overflow",
		]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /ITERATOR RECONCILIATION OBSERVED 3/);
	}
});

// RFC #2884: result, cleanup and setup failures preserve arbitrary JS rejection diagnostics.
test("Node and Bun report JavaScript rejection values without blocking cleanup or leaking rejections", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "--import", "jiti/register", "test/fixtures/task-s1-rejections.ts"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /JS REJECTIONS PRESERVED 42 diagnostics and 2 independent cleanup orders/);
	}
});

// RFC #2884: metric fields share the terminal report's exact numeric replay semantics.
test("Node and Bun preserve every metric combination and reject changed numeric reports", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "--import", "jiti/register", "test/fixtures/task-s1-metrics.ts"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /METRICS PRESERVED 2744 combinations 107016 conflicts/);
	}
});

// RFC #2884: arbitrary callback throws cannot interrupt native wakes or fallback reconciliation.
test("Node and Bun contain callback failures through real wake and timer paths", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "--import", "jiti/register", "test/fixtures/task-s1-callbacks.ts"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout.toString(),
			/CALLBACK FAILURES CONTAINED 45 direct\/native-wake\/fallback-timer cases/,
		);
	}
});

// RFC #2884: lossless raw strings and exact replay survive both public native hosts.
test("Node and Bun preserve UTF-16 code units across S1 records and replay", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "--import", "jiti/register", "test/fixtures/task-s1-utf16.ts"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout.toString(),
			/UTF16 PRESERVED 9 strings 54 variant reports 405 conflicts 27 facade launches/,
		);
	}
});

// RFC #2884: authorized replay retention is bounded independently for each task.
test("Node and Bun evict report identities while retaining terminal receipts", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "test/fixtures/task-s1-retention.mjs"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /RETENTION VERIFIED 256 duplicates 256 conflicts/);
	}
});

// RFC #2884: caller IDs cannot prevent the facade's result or independent reaping.
test("Node and Bun settle runner outcomes despite deterministic activity ID collisions", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([
			runtime,
			"--import",
			"jiti/register",
			"test/fixtures/task-s1-report-collision.ts",
		]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /REPORT COLLISIONS SETTLED 256 forced candidates/);
	}
});

// RFC #2884: Tokio panics do not fail the child process, so stderr is part of the oracle.
test("Node and Bun accept NaN wait budgets without native panics and retain observation cleanup", () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		const result = spawnSyncCollect([runtime, "--import", "jiti/register", "test/fixtures/task-s1-nan-budget.ts"]);
		assert.equal(result.exitCode, 0, `${runtime}\n${result.stdout}\n${result.stderr}`);
		assert.doesNotMatch(result.stderr.toString(), /panicked at|unhandled.*rejection/i, result.stderr.toString());
		assert.match(result.stdout.toString(), /NAN BUDGET LIFECYCLE VERIFIED 2 native doors 4 facade configurations/);
	}
});

// RFC #2884: cleanup must finish native callback destruction before the environment disappears.
test("Node and Bun exit cleanly with disposed and live native subscription wakes", async () => {
	for (const runtime of [process.execPath, bunExecutable()]) {
		await Promise.all(
			Array.from({ length: 20 }, async (_, index) => {
				const child = spawn(runtime, ["test/fixtures/task-s1-shutdown.mjs", String(index % 15)], {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: TEST_TIMEOUT_MS,
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => {
					stdout += chunk;
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code, signal) => resolve([code, signal]));
				});
				const diagnostic = `${runtime} case ${index}: signal=${signal}\n${stdout}\n${stderr}`;
				assert.equal(code, 0, diagnostic);
				assert.equal(signal, null, diagnostic);
				assert.equal(stderr, "", diagnostic);
				assert.match(stdout, /SUBSCRIPTION SHUTDOWN READY/);
			}),
		);
	}
});
