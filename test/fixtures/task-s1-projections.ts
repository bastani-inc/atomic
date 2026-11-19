import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as native from "@bastani/atomic-natives";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { sleep } from "../helpers/runtime.js";

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
function fixture() {
	const actor = new native.TaskSupervisor();
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const host = supervisor.bindHostSession({ scope, authorizeLaunch() {}, createRunner() { throw new Error("native fixture"); } });
	const owner = value(supervisor.openTaskOwner(host, scope));
	const nativeOwner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
	const task = value(actor.startAgentTask(nativeOwner, { kind: "agent", agent: "", task: " \n " }, ""));
	const runner = value(actor.claimTaskRunner(task));
	const watch = value(supervisor.watchOwnerTasks(owner));
	return { actor, supervisor, owner, nativeOwner, task, runner, watch };
}

// RFC #2884: compare the entire event-reduced projection and fresh native snapshot at one cursor.
async function attentionProjection() {
	for (const scenario of ["settlement", "owner-close", "cleanup-failed"]) {
		const h = fixture();
		// A new watch is refused once closing starts. Keep an evicted native observer for
		// an authoritative reset snapshot at that cursor instead (no invented read door).
		const recovery = value(h.actor.watchOwnerTasks(h.nativeOwner, () => {}));
		value(h.actor.reportTaskActivity(h.runner, { reportId: "evict", change: { kind: "action", tool: "", text: "x".repeat(128 * 1024) } }));
		h.watch.drain();
		const attention: C.Attention = { kind: "input-needed", requestId: "", prompt: " \n ", route: { sessionId: "", promptId: "" } };
		const failure: C.Cleanup = { kind: "failed", resources: [{ resource: "", code: "", message: " \n " }, { resource: "", code: "", message: " \n " }] };
		function consistent(expected: C.Attention) {
			h.watch.drain();
			const fresh = value(h.supervisor.watchOwnerTasks(h.owner));
			assert.deepEqual(h.watch.cursor, fresh.cursor);
			assert.deepEqual(h.watch.snapshot, fresh.snapshot, scenario);
			assert.deepEqual(h.watch.snapshot.tasks[0].attention, expected);
			fresh.dispose();
		}
		try {
			// An older native producer reports a stage attempt. Both the event and fresh SDK projections ignore it.
			const legacy = { ...attention, route: { ...attention.route, stageAttemptId: "old-attempt" } };
			value(h.actor.reportTaskActivity(h.runner, { reportId: "", change: { kind: "attention-set", attention: legacy } }));
			consistent(attention);
			if (scenario === "cleanup-failed") value(h.actor.acknowledgeTaskCleanup(h.runner, failure));
			const cancelled = h.actor.cancelTask(h.task, "user");
			if (scenario === "cleanup-failed") assert.equal(!cancelled.ok && cancelled.error.code, "CleanupFailed");
			else value(cancelled);
			consistent(attention);
			if (scenario === "settlement") {
				value(h.actor.acknowledgeTaskCleanup(h.runner, { kind: "reaped" }));
				consistent({ kind: "none" });
			} else {
				const closing = h.actor.closeTaskOwner(h.nativeOwner, "session-close");
				h.watch.drain();
				const reset = value(h.actor.drainOwnerTasks(recovery.lease));
				assert.equal(reset.reset, true);
				assert.deepEqual(h.watch.cursor, reset.cursor);
				assert.deepEqual(h.watch.snapshot, reset.snapshot);
				assert.deepEqual(h.watch.snapshot.tasks[0].attention, { kind: "none" });
				if (scenario === "cleanup-failed") {
					assert.deepEqual(h.watch.snapshot.tasks[0].cleanup, failure);
					const refused = await closing;
					assert.equal(!refused.ok && refused.error.code, "CleanupFailed");
				}
				value(h.actor.acknowledgeTaskCleanup(h.runner, { kind: "reaped" }));
				if (scenario !== "cleanup-failed") value(await closing);
			}
		} finally {
			h.actor.cancelTask(h.task, "user");
			value(h.actor.acknowledgeTaskCleanup(h.runner, { kind: "reaped" }));
			value(await h.actor.closeTaskOwner(h.nativeOwner, "session-close"));
			h.watch.drain();
			h.actor.disposeSubscription(recovery.lease);
			assert.equal(h.watch.snapshot.state, "closed");
			h.watch.dispose();
		}
	}
	console.log("ATTENTION PROJECTIONS CONSISTENT 3 scenarios");
}

// RFC #2884: a reset ends an iterator epoch, not the subscription or owner.
async function overflowProjection() {
	for (const scenario of ["local-overflow", "native-reset", "oversized-final"]) {
		const h = fixture();
		// Only the contracted fields; neither drain nor onReconcile can wake this consumer.
		const subscription: Pick<typeof h.watch, "lease" | "snapshot" | "cursor" | "events" | "dispose"> = h.watch;
		const iterator = subscription.events[Symbol.asyncIterator]();
		const pending = iterator.next();
		const count = scenario === "local-overflow" ? 100 : scenario === "native-reset" ? 1500 : 0;
		const result: C.TaskResult = { kind: "failed", code: "", message: scenario === "oversized-final" ? "x".repeat(2 * 1024 * 1024) : "" };
		try {
			for (let i = 0; i < count; i++) value(h.actor.reportTaskActivity(h.runner, { reportId: String(i), change: { kind: "metrics", toolCount: i } }));
			value(h.actor.reportTaskOutcome(h.runner, { reportId: "final", result }));
			const observed = await Promise.race([pending, sleep(500).then(() => "asleep" as const)]);
			assert.notEqual(observed, "asleep", `${scenario}: pending next must observe the final reconciliation without later activity`);
			assert.deepEqual(observed, { done: true, value: undefined });
			assert.deepEqual(subscription.snapshot.tasks[0].execution, { kind: "settled", result });
			assert.equal(subscription.snapshot.tasks[0].cleanup.kind, "active");
			assert.equal(subscription.snapshot.state, "open");
			const fresh = value(h.supervisor.watchOwnerTasks(h.owner));
			assert.deepEqual(subscription.cursor, fresh.cursor);
			assert.deepEqual(subscription.snapshot, fresh.snapshot);
			fresh.dispose();
			assert.deepEqual(await iterator.next(), { done: true, value: undefined }, "ended epoch stays ended");
			// Only after proving final-state delivery, resume from the same iterable. Every
			// retained delta must be authentic, ordered and strictly after the reset cursor.
			const resumed = subscription.events[Symbol.asyncIterator]();
			const next = resumed.next();
			await iterator.return?.(); // an ended epoch cannot dispose its live successor
			const nativeWatch = value(h.actor.watchOwnerTasks(h.nativeOwner, () => {}));
			const atReset = subscription.cursor;
			value(h.actor.acknowledgeTaskCleanup(h.runner, { kind: "reaped" }));
			const authentic = value(h.actor.drainOwnerTasks(nativeWatch.lease)).events;
			const delivered = await Promise.race([next, sleep(500).then(() => "asleep" as const)]);
			assert.notEqual(delivered, "asleep");
			assert.deepEqual(delivered, { done: false, value: authentic[0] });
			assert.ok(BigInt(authentic[0].cursor.sequence) > BigInt(atReset.sequence));
			h.actor.disposeSubscription(nativeWatch.lease);
			value(await h.actor.closeTaskOwner(h.nativeOwner, "session-close"));
			let previous = BigInt(authentic[0].cursor.sequence);
			let retained = 0;
			for await (const event of subscription.events) {
				assert.equal(event.schemaVersion, 1);
				assert.ok(BigInt(event.cursor.sequence) > previous);
				previous = BigInt(event.cursor.sequence);
				assert.ok(++retained <= 64);
			}
			assert.equal(subscription.snapshot.state, "closed");
		} finally {
			subscription.dispose();
			value(h.actor.acknowledgeTaskCleanup(h.runner, { kind: "reaped" }));
			value(await h.actor.closeTaskOwner(h.nativeOwner, "session-close"));
		}
	}
	console.log("ITERATOR RECONCILIATION OBSERVED 3 scenarios");
}

if (process.argv[2] === "attention") await attentionProjection();
else if (process.argv[2] === "overflow") await overflowProjection();
else throw new Error("select a projection scenario");
