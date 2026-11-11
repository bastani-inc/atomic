import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import * as native from "@bastani/atomic-natives";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";

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
async function bounded<T>(promise: Promise<T>): Promise<T> {
	const OBSERVATION_LIMIT_MS = 2000;
	let timer!: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("NaN fixture lifecycle did not finish")), OBSERVATION_LIMIT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const unhandled: string[] = [];
const onUnhandled = (error: Error) => unhandled.push(String(error));
process.on("unhandledRejection", onUnhandled);
const intent: C.AgentIntent = { kind: "agent", agent: "fake", task: "NaN budget" };
const terminal: C.TaskResult = { kind: "failed", code: "fixture", message: "settled normally" };

// RFC #2884: wait for actual native timer outcomes and JS turns, not a fixed sleep.
// Keep NaN observers alive throughout these scheduler turns so abort-before-poll
// cannot make a successful child exit alone look like non-panicking scheduling.
async function timerTurns(wait: (budget: number) => Promise<C.WaitOutcome | native.WaitOutcome>): Promise<void> {
	for (const budget of [0, -0, 0.5, Number.MIN_VALUE, -1, -Infinity, 0, 0]) {
		const outcome = await bounded(wait(budget));
		assert.equal(outcome.kind === "yielded" && outcome.reason, "elapsed");
		await setImmediate();
	}
}

// RFC #2884: both direct native registration doors accept NaN; lifecycle wins later.
async function nativeScenario(foreground: boolean): Promise<void> {
	const supervisor = new native.TaskSupervisor();
	const scope: native.OwnerScope = { kind: "session", sessionId: `native-nan-${foreground}` };
	const host = supervisor.bindHostSession(scope);
	const owner = value(supervisor.openTaskOwner(host, scope));
	const task = value(supervisor.startAgentTask(owner, intent, "operation"));
	const runner = value(supervisor.claimTaskRunner(task));
	const reference = value(supervisor.taskReference(task));
	const register = (target: native.TaskLease, budget: number) =>
		value(foreground ? supervisor.foregroundTask(target, host, budget) : supervisor.waitForTask(target, budget));
	const leases = Array.from({ length: 3 }, () => register(task, NaN));
	const observations = leases.map((lease) => supervisor.observeTaskWait(lease));
	let finished = 0;
	for (const observation of observations) void observation.then(() => finished++);
	const wide = [2 ** 32, Number.MAX_VALUE, Infinity].map((budget) => register(task, budget));
	await timerTurns(async (budget) => value(await supervisor.observeTaskWait(register(task, budget))));
	const snapshot = () => {
		const watch = value(supervisor.watchOwnerTasks(owner, () => {}));
		supervisor.disposeSubscription(watch.lease);
		return watch.snapshot;
	};
	assert.equal(finished, 0, "NaN has no elapsed deadline under the existing comparison");
	for (const lease of [leases[0], ...wide]) {
		const yielded = value(supervisor.yieldTaskWait(lease, "explicit"));
		assert.equal(yielded.kind === "yielded" && yielded.reason, "explicit");
		assert.deepEqual(value(await bounded(supervisor.observeTaskWait(lease))), yielded);
	}
	value(supervisor.disposeTaskWait(leases[1]));
	const disposed = await bounded(observations[1]);
	assert.equal(!disposed.ok && disposed.error.code, "ObserverCancelled");
	assert.deepEqual(supervisor.yieldTaskWait(leases[1], "explicit"), disposed);
	assert.deepEqual(value(supervisor.taskReference(task)), reference);
	assert.equal(snapshot().tasks[0].execution.kind, "running");
	value(supervisor.reportTaskOutcome(runner, { reportId: "terminal", result: terminal }));
	assert.deepEqual(value(await bounded(observations[2])), { kind: "settled", taskId: reference.taskId, result: terminal });
	value(supervisor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
	const sibling = value(supervisor.startAgentTask(owner, intent, "close-operation"));
	const siblingRunner = value(supervisor.claimTaskRunner(sibling));
	const closingWait = supervisor.observeTaskWait(register(sibling, NaN));
	await timerTurns(async (budget) => value(await supervisor.observeTaskWait(register(sibling, budget))));
	const closed = supervisor.closeTaskOwner(owner, "session-close");
	value(supervisor.acknowledgeTaskCleanup(siblingRunner, { kind: "reaped" }));
	const cancelled = value(await bounded(closingWait));
	assert.deepEqual(cancelled.kind === "settled" && cancelled.result, { kind: "cancelled", cause: "owner-close" });
	const receipt = value(await bounded(closed));
	assert.equal(receipt.state, "closed");
	assert.equal(receipt.tasks.length, 2);
	assert.ok(receipt.tasks.every((record) => record.cleanup.kind === "reaped"));
}

type Door = "wait" | "foreground" | "foreground-first";
// RFC #2884: configuration and each per-call door share native scheduling, not new input validation.
async function facadeScenario(door: Door, configured: boolean): Promise<void> {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: `facade-nan-${door}-${configured}` };
	const results: Array<ReturnType<typeof deferred<C.TaskResult>>> = [];
	const cleanups: Array<ReturnType<typeof deferred<C.Cleanup>>> = [];
	const configuration: C.TaskWaitConfiguration = { kind: "automatic", agentBudgetMs: configured ? NaN : 0 };
	const host = supervisor.bindHostSession({
		scope,
		tasks: { wait: configuration },
		authorizeLaunch() {},
		createRunner(context) {
			const result = deferred<C.TaskResult>();
			const cleanup = deferred<C.Cleanup>();
			results.push(result);
			cleanups.push(cleanup);
			context.signal.addEventListener("abort", () => cleanup.resolve({ kind: "reaped" }), { once: true });
			return { result: result.promise, cleanup: cleanup.promise };
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const task = value(await bounded(supervisor.startAgentTask(owner, intent, "operation" as C.OperationId)));
	const reference = supervisor.taskReference(task);
	const watch = value(supervisor.watchOwnerTasks(owner));
	const observe = (
		target: typeof task,
		budget: number | undefined,
	): Promise<C.Result<C.WaitOutcome, C.WaitError | C.ForegroundError>> =>
		door === "wait"
			? supervisor.waitForTask(target, budget, host)
			: door === "foreground"
				? supervisor.foregroundTask(target, budget)
				: supervisor.initialObservation(target, { kind: "foreground", budgetMs: budget });
	const register = (target: typeof task, budget: number | undefined) => {
		const observation = observe(target, budget);
		watch.drain();
		const designated = watch.snapshot.tasks.find((record) => record.ref.taskId === supervisor.taskReference(target).taskId)?.observation;
		assert.equal(designated?.kind, "foreground");
		if (designated?.kind !== "foreground") throw new Error("missing synchronous wait registration");
		const lease = supervisor.findWait(designated.waitId);
		assert.ok(lease);
		return { observation, lease };
	};
	try {
		assert.equal(results.length, 1);
		assert.equal(watch.snapshot.tasks[0].execution.kind, "running");
		const background = value(await bounded(supervisor.initialObservation(task)));
		assert.equal(background.kind === "yielded" && background.reason, "default-background");
		const explicit = value(await bounded(supervisor.initialObservation(task, { kind: "background" })));
		assert.equal(explicit.kind === "yielded" && explicit.reason, "explicit");
		const pending = Array.from({ length: 3 }, () => register(task, configured ? undefined : NaN));
		let finished = 0;
		for (const wait of pending) void wait.observation.then(() => finished++);
		// Explicit finite overrides take priority even over configured NaN, on this same door.
		await timerTurns(async (budget) => value(await observe(task, budget)));
		assert.equal(finished, 0);
		const yielded = value(supervisor.yieldTaskWait(pending[0].lease, "explicit"));
		assert.equal(yielded.kind === "yielded" && yielded.reason, "explicit");
		assert.deepEqual(value(await bounded(pending[0].observation)), yielded);
		value(supervisor.disposeTaskWait(pending[1].lease));
		const disposed = await bounded(pending[1].observation);
		assert.equal(!disposed.ok && disposed.error.code, "ObserverCancelled");
		assert.deepEqual(supervisor.yieldTaskWait(pending[1].lease, "explicit"), disposed);
		watch.drain();
		assert.equal(watch.snapshot.tasks[0].execution.kind, "running");
		assert.deepEqual(supervisor.taskReference(task), reference);
		assert.equal(results.length, 1);
		results[0].resolve(terminal);
		assert.deepEqual(value(await bounded(pending[2].observation)), { kind: "settled", taskId: reference.taskId, result: terminal });
		cleanups[0].resolve({ kind: "reaped" });
		const sibling = value(await supervisor.startAgentTask(owner, intent, "close-operation" as C.OperationId));
		const closingWait = register(sibling, configured ? undefined : NaN);
		await timerTurns(async (budget) => value(await observe(sibling, budget)));
		const closed = supervisor.closeTaskOwner(owner, "session-close");
		const cancelled = value(await bounded(closingWait.observation));
		assert.deepEqual(cancelled.kind === "settled" && cancelled.result, {
			kind: "cancelled",
			cause: "owner-close",
			ownerClose: "session-close",
		});
		assert.equal(value(await bounded(closed)).state, "closed");
		watch.drain();
		assert.ok(watch.snapshot.tasks.every((record) => record.cleanup.kind === "reaped"));
		assert.equal(results.length, 2);
		assert.ok(Object.is(configuration.agentBudgetMs, configured ? NaN : 0), "configuration is not rewritten");
	} finally {
		watch.dispose();
		value(await bounded(supervisor.closeTaskOwner(owner, "session-close")));
	}
}

await nativeScenario(false);
await nativeScenario(true);
for (const door of ["wait", "foreground", "foreground-first"] as const) {
	for (const configured of [false, true]) await facadeScenario(door, configured);
}
await setImmediate();
assert.deepEqual(unhandled, []);
process.off("unhandledRejection", onUnhandled);
console.log("NAN BUDGET LIFECYCLE VERIFIED 2 native doors 6 facade configurations; native timers executed");
