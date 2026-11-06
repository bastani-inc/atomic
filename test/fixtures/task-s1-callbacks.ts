import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as native from "@bastani/atomic-natives";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSubscription } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { sleep } from "../helpers/runtime.js";

type Thrown = object | string | number | boolean | bigint | symbol | null | undefined;
function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
async function eventually(check: () => boolean) {
	const deadline = Date.now() + 1000;
	while (!check() && Date.now() < deadline) await sleep(5);
	assert.ok(check(), "automatic callback reconciliation must converge without further activity");
}
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const cases: Array<{ thrown: Thrown; message: string }> = [
	{ thrown: Object.create(null), message: "Unprintable JavaScript rejection" },
	{ thrown: " raw callback \r\n ", message: " raw callback \r\n " },
	{ thrown: new Error(" raw error \n "), message: " raw error \n " },
	{ thrown: "", message: "" },
	{ thrown: null, message: "null" },
	{ thrown: undefined, message: "undefined" },
	{ thrown: Symbol("raw"), message: "Symbol(raw)" },
	{ thrown: 0.5, message: "0.5" },
	{ thrown: 0n, message: "0" },
	{ thrown: false, message: "false" },
	{ thrown: {}, message: "[object Object]" },
	{ thrown: { toString() { throw new Error("format trap"); } }, message: "Unprintable JavaScript rejection" },
	{ thrown: { [Symbol.toPrimitive]() { throw new Error("primitive trap"); } }, message: "Unprintable JavaScript rejection" },
	{ thrown: revoked.proxy, message: "Unprintable JavaScript rejection" },
	{ thrown: Object.defineProperty(new Error(), "message", { get() { throw new Error("message trap"); } }), message: "Unprintable JavaScript rejection" },
];
const faults: Thrown[] = [];
const onFault = (reason: Thrown) => {
	faults.push(reason);
	console.error("Unhandled callback failure", reason);
	process.exitCode = 1;
};
process.on("uncaughtException", onFault);
process.on("unhandledRejection", onFault);
let count = 0;
// RFC #2884: exercise the real direct call, native TSFN wake and independently rearmed fallback timer.
try {
for (const path of ["direct", "native-wake", "fallback-timer"] as const) {
	if (process.argv[2] && process.argv[2] !== path) continue;
	for (const { thrown, message } of cases) {
		const actor = new native.TaskSupervisor();
		const scope: native.OwnerScope = { kind: "session", sessionId: randomUUID() };
		const owner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
		const task = value(actor.startAgentTask(owner, { kind: "agent", agent: "", task: "" }, ""));
		const runner = value(actor.claimTaskRunner(task));
		let drains = 0;
		let wakes = 0;
		let callbackCalls = 0;
		let nativeReconciliations = 0;
		let inNativeWake = false;
		const drain = actor.drainOwnerTasks.bind(actor);
		actor.drainOwnerTasks = (lease) => { drains++; return drain(lease); };
		let watch!: TaskSubscription;
		let iterator!: AsyncIterator<C.NativeEvent>;
		let first!: Promise<IteratorResult<C.NativeEvent>>;
		const initialize = () => {
			watch = new TaskSubscription(actor, initial, { routerSelections: new Map(), requestedModels: new Map(), launchHeartbeats: new Map() }, () => {});
			watch.onReconcile = () => {
				callbackCalls++;
				if (inNativeWake) nativeReconciliations++;
				throw thrown;
			};
			iterator = watch.events[Symbol.asyncIterator]();
			first = iterator.next();
		};
		let seedNative = path === "native-wake";
		const initial = value(actor.watchOwnerTasks(owner, (hint) => {
			wakes++;
			if (path !== "native-wake") return; // Simulates a lost hint, not a lost journal fact.
			if (seedNative) {
				seedNative = false;
				// RFC #2884: arm the fallback only after this real native wake has arrived.
				// Otherwise a faster poll may consume the sole event before native scheduling.
				initialize();
				// Keep a second authentic delta queued for the native-path assertion.
				value(actor.reportTaskActivity(runner, { reportId: "in-wake", change: { kind: "action", tool: "", text: "native" } }));
			}
			inNativeWake = true;
			try { watch.wake(hint); } finally { inNativeWake = false; }
		}));
		if (path !== "native-wake") initialize();
		try {
			value(actor.reportTaskActivity(runner, { reportId: "first", change: { kind: "action", tool: "", text: " \r\n " } }));
			if (path === "direct") assert.doesNotThrow(() => watch.drain());
			await eventually(() => callbackCalls > 0 && watch.failure !== undefined);
			assert.ok(watch.failure instanceof Error);
			assert.equal(watch.failure.message, message);
			assert.equal((await first).done, false, "callback error must not strand authentic deltas");
			if (path === "native-wake") {
				await eventually(() => nativeReconciliations > 0);
				assert.ok(wakes > 0);
				assert.equal((await iterator.next()).done, false);
			}
			const firstCalls = callbackCalls;
			const notification = iterator.next();
			// A final oversized terminal report evicts itself: only the snapshot/reset can notify.
			const result: native.TaskResult = { kind: "failed", code: "final", message: "x".repeat(2 * 1024 * 1024) };
			const terminal = value(actor.reportTaskOutcome(runner, { reportId: "last", result }));
			if (path === "direct") assert.doesNotThrow(() => watch.drain());
			await eventually(() => callbackCalls > firstCalls && watch.snapshot.tasks[0].execution.kind === "settled");
			assert.deepEqual(await notification, { done: true, value: undefined });
			assert.equal(watch.failure?.message, message);
			assert.deepEqual(watch.snapshot.tasks[0].execution, { kind: "settled", result });
			assert.deepEqual(watch.cursor, terminal.cursor);
			assert.deepEqual(await iterator.next(), { done: true, value: undefined });
			const fresh = value(actor.watchOwnerTasks(owner, () => {}));
			try { assert.deepEqual(watch.snapshot, fresh.snapshot); } finally { actor.disposeSubscription(fresh.lease); }
			// Notification was proved before cleanup or later activity. The same iterable resumes afterwards.
			iterator = watch.events[Symbol.asyncIterator]();
			const cleanup = iterator.next();
			value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
			if (path === "direct") watch.drain();
			await eventually(() => watch.snapshot.tasks[0].cleanup.kind === "reaped");
			const delta = await cleanup;
			assert.equal(delta.done, false);
			if (!delta.done) assert.equal(delta.value.payload.kind, "cleanup-changed");
			assert.deepEqual(faults, [], "no unhandled exception or rejection");
			count++;
		} finally {
			watch?.dispose();
			const stopped = drains;
			await sleep(60); // Observe more than two existing 25-ms fallback intervals after disposal.
			assert.equal(drains, stopped, "disposed subscription retains no poll");
			value(actor.cancelTask(task, "user"));
			value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
			value(await actor.closeTaskOwner(owner, "session-close"));
		}
	}
}
} finally {
	process.off("uncaughtException", onFault);
	process.off("unhandledRejection", onFault);
}
assert.deepEqual(faults, []);
console.log(`CALLBACK FAILURES CONTAINED ${count} direct/native-wake/fallback-timer cases`);
