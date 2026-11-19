import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type {
	Cleanup,
	OperationId,
	SettlementReceipt,
	TaskResult,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";

const intent = { kind: "agent" as const, agent: "worker", task: "Work" };
const operation = () => randomUUID() as OperationId;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function host() {
	return new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
}

// RFC #2884: yield is observation only; replay retains the original execution and signal.
test("agent host starts once, resolves within owner, and cancels original execution after yield", async () => {
	const owner = host();
	const other = host();
	const result = deferred<TaskResult>();
	const cleanup = deferred<Cleanup>();
	let signal: AbortSignal | undefined;
	let starts = 0;
	const op = operation();
	const started = await owner.startAgentTask(intent, op, (context) => {
		starts++;
		signal = context.signal;
		assert.equal(
			context.reportActivity({ reportId: "action", change: { kind: "action", tool: "read", text: "Working" } }).ok,
			true,
		);
		return { result: result.promise, cleanup: cleanup.promise };
	});
	assert.ok(started.ok);
	const id = started.value.taskId;
	const before = owner.watchOwnerTasks();
	assert.ok(before.ok);
	const originalRef = before.value.snapshot.tasks[0].ref;
	before.value.dispose();
	const observation = await owner.observeAgentLaunch(id);
	assert.ok(observation.ok);
	assert.equal(observation.value.kind, "yielded");
	const after = owner.watchOwnerTasks();
	assert.ok(after.ok);
	assert.deepEqual(after.value.snapshot.tasks[0].ref, originalRef);
	assert.equal(after.value.snapshot.tasks[0].execution.kind, "running");
	after.value.dispose();
	const replay = await owner.startAgentTask(intent, op, () => {
		throw new Error("second execution");
	});
	assert.deepEqual(replay, started);
	assert.equal(starts, 1);
	assert.equal(signal?.aborted, false);
	assert.equal(other.resolveTask(id).ok, false);
	assert.equal((await other.waitForTask(id, 0)).ok, false);
	const cancelled = await owner.cancelTask(id, "user");
	assert.ok(cancelled.ok);
	assert.notEqual(cancelled.value.cleanup.kind, "reaped");
	assert.equal(signal?.aborted, true);
	assert.equal(signal?.reason, "user");
	cleanup.resolve({ kind: "reaped" });
	// Cancellation cleanup must not depend on the deliberately unresolved result.
	assert.equal((await owner.close("session-close")).ok, true);
	assert.equal((await other.close("session-close")).ok, true);
});

// RFC #2884: a natural terminal result still arrives from the promise supplied before yielding.
test("yielded agent observes the original result without another start", async () => {
	const owner = host();
	const result = deferred<TaskResult>();
	const cleanup = deferred<Cleanup>();
	const started = await owner.startAgentTask(intent, operation(), () => ({
		result: result.promise,
		cleanup: cleanup.promise,
	}));
	assert.ok(started.ok);
	await owner.observeAgentLaunch(started.value.taskId);
	const terminal: TaskResult = { kind: "failed", code: "Expected", message: "Original result" };
	result.resolve(terminal);
	const waited = await owner.waitForTask(started.value.taskId);
	assert.deepEqual(waited, { ok: true, value: { kind: "settled", taskId: started.value.taskId, result: terminal } });
	cleanup.resolve({ kind: "reaped" });
	assert.equal((await owner.close("session-close")).ok, true);
});

// RFC #2884: trusted adapter never bypasses the existing launch guard.
test("launch refusal precedes admission and runner setup", async () => {
	const owner = new AgentTaskHost({
		scope: { kind: "session", sessionId: randomUUID() },
		authorizeLaunch() {
			throw new Error("delegation refused");
		},
	});
	await assert.rejects(
		owner.startAgentTask(intent, operation(), () => {
			throw new Error("runner reached");
		}),
		/delegation refused/,
	);
	const watch = owner.watchOwnerTasks();
	assert.ok(watch.ok);
	assert.equal(watch.value.snapshot.tasks.length, 0);
	watch.value.dispose();
	await owner.close("session-close");
});

// RFC #2884: repeated live host binding converges without losing per-launch dispatch context.
test("same-scope hosts dispatch each original launch factory", async () => {
	const binding = { scope: { kind: "session" as const, sessionId: randomUUID() }, authorizeLaunch() {} };
	const first = new AgentTaskHost(binding);
	const second = new AgentTaskHost(binding);
	let starts = 0;
	const runner = () => {
		starts++;
		return {
			result: Promise.resolve<TaskResult>({ kind: "failed", code: "Done", message: "done" }),
			cleanup: Promise.resolve<Cleanup>({ kind: "reaped" }),
		};
	};
	const launches = await Promise.all([
		first.startAgentTask(intent, operation(), runner),
		second.startAgentTask(intent, operation(), runner),
	]);
	assert.equal(starts, 2);
	for (const launched of launches) {
		assert.ok(launched.ok);
		assert.equal(first.resolveTask(launched.value.taskId).ok, true);
		assert.equal(second.resolveTask(launched.value.taskId).ok, true);
	}
	assert.equal((await first.close("session-close")).ok, true);
});

test("an agent launch a JavaScript caller still asks to observe in the foreground runs in the background", async () => {
	const owner = new AgentTaskHost({
		scope: { kind: "session", sessionId: randomUUID() },
		// A foreground observation that is still honoured would hold this test until it times out.
		tasks: { wait: { kind: "until-settled" } },
		authorizeLaunch() {},
	});
	const result = deferred<TaskResult>();
	try {
		const started = await owner.startAgentTask(intent, operation(), () => ({
			result: result.promise,
			cleanup: result.promise.then(() => ({ kind: "reaped" as const })),
		}));
		assert.ok(started.ok);
		const untyped: unknown = { kind: "foreground" };
		const observed = await owner.observeAgentLaunch(started.value.taskId, untyped as { kind: "background" });
		assert.ok(observed.ok && observed.value.kind === "yielded");
		assert.equal(observed.value.reason, "default-background");
	} finally {
		result.resolve({ kind: "cancelled", cause: "user" });
		await owner.close("session-close");
	}
});

for (const [label, policy, reason] of [
	["explicit background", { kind: "background" }, "explicit"],
	["default background", undefined, "default-background"],
] satisfies Array<[string, { readonly kind: "background" } | undefined, string]>) {
	test(`${label} releases observation while the same subagent completes later`, async () => {
		const settled = deferred<SettlementReceipt>();
		const owner = new AgentTaskHost({
			scope: { kind: "session", sessionId: randomUUID() },
			tasks: { wait: { kind: "automatic", agentBudgetMs: 1 } },
			authorizeLaunch() {},
			onTaskSettled: (_ref, receipt) => settled.resolve(receipt),
		});
		const result = deferred<TaskResult>();
		let starts = 0;
		let signal: AbortSignal | undefined;
		try {
			const started = await owner.startAgentTask(intent, operation(), (context) => {
				starts++;
				signal = context.signal;
				return { result: result.promise, cleanup: result.promise.then(() => ({ kind: "reaped" as const })) };
			});
			assert.ok(started.ok);
			const observed = await owner.observeAgentLaunch(started.value.taskId, policy);
			assert.ok(observed.ok && observed.value.kind === "yielded");
			assert.equal(observed.value.reason, reason);
			assert.equal(observed.value.taskId, started.value.taskId);
			assert.equal(signal?.aborted, false);
			const watch = owner.watchOwnerTasks();
			assert.ok(watch.ok);
			try {
				assert.equal(watch.value.snapshot.tasks[0].execution.kind, "running");
				assert.equal(watch.value.snapshot.tasks[0].wasBackground, true);
			} finally {
				watch.value.dispose();
			}
			const output = {
				ownerId: owner.ownerBinding.supervisor.taskReference(started.value.lease).ownerId,
				taskId: started.value.taskId,
				artifactId: "result",
				byteCount: "0",
				omittedRanges: [],
			};
			const terminal: TaskResult = { kind: "completed", output };
			result.resolve(terminal);
			const receipt = await settled.promise;
			assert.equal(receipt.taskId, started.value.taskId);
			assert.deepEqual(receipt.result, terminal);
			assert.deepEqual(await owner.waitForTask(started.value.taskId), {
				ok: true,
				value: { kind: "settled", taskId: started.value.taskId, result: terminal },
			});
			assert.equal(starts, 1);
		} finally {
			result.resolve({ kind: "cancelled", cause: "user" });
			assert.ok((await owner.close("session-close")).ok);
		}
	});
}

test("queued agent cancellation notifies once without dispatching a child", async () => {
	const receipts: SettlementReceipt[] = [];
	const owner = new AgentTaskHost({
		scope: { kind: "session", sessionId: randomUUID() },
		authorizeLaunch() {},
		onTaskSettled: (_ref, receipt) => receipts.push(receipt),
	});
	let dispatch: (() => Promise<void>) | undefined;
	let starts = 0;
	try {
		const started = await owner.startAgentTask(
			intent,
			operation(),
			() => {
				starts++;
				throw new Error("cancelled queued child must not start");
			},
			(run) => {
				dispatch = run;
			},
		);
		assert.ok(started.ok);
		assert.ok((await owner.observeAgentLaunch(started.value.taskId)).ok);
		assert.ok((await owner.cancelTask(started.value.taskId, "user")).ok);
		assert.ok(dispatch);
		await dispatch();
		await vi.waitFor(() => assert.equal(receipts.length, 1));
		assert.equal(receipts[0].taskId, started.value.taskId);
		assert.deepEqual(receipts[0].result, { kind: "cancelled", cause: "user" });
		assert.ok((await owner.cancelTask(started.value.taskId, "shutdown")).ok);
		assert.ok((await owner.close("session-close")).ok);
		assert.equal(receipts.length, 1);
		assert.equal(starts, 0);
	} finally {
		await owner.close("session-close");
	}
});

test.each(["completed", "failed", "cancelled"] as const)(
	"runner %s outcome is delivered once and survives a later stop",
	async (kind) => {
		const receipts: SettlementReceipt[] = [];
		const owner = new AgentTaskHost({
			scope: { kind: "session", sessionId: randomUUID() },
			authorizeLaunch() {},
			onTaskSettled: (_ref, receipt) => receipts.push(receipt),
		});
		const result = deferred<TaskResult>();
		try {
			const started = await owner.startAgentTask(intent, operation(), () => ({
				result: result.promise,
				cleanup: Promise.resolve({ kind: "reaped" }),
			}));
			assert.ok(started.ok);
			assert.ok((await owner.observeAgentLaunch(started.value.taskId)).ok);
			const terminal: TaskResult =
				kind === "completed"
					? {
							kind,
							output: {
								ownerId: owner.ownerBinding.supervisor.taskReference(started.value.lease).ownerId,
								taskId: started.value.taskId,
								artifactId: "test-output",
								byteCount: "0",
								omittedRanges: [],
							},
						}
					: kind === "failed"
						? { kind, code: "TaskFailed", message: "Original failure" }
						: { kind, cause: "parent-handoff" };
			result.resolve(terminal);
			await owner.waitForTask(started.value.taskId);
			await vi.waitFor(() => assert.equal(receipts.length, 1));
			const original = receipts[0];
			assert.equal(original.taskId, started.value.taskId);
			assert.deepEqual(original.result, terminal);
			const cancelled = await owner.cancelTask(started.value.taskId, "user");
			assert.ok(cancelled.ok);
			assert.equal(cancelled.value.decision, "already-settled");
			assert.deepEqual(await owner.waitForTask(started.value.taskId), {
				ok: true,
				value: { kind: "settled", taskId: started.value.taskId, result: terminal },
			});
			// Closure drains the owner snapshot too, exercising both delivery paths.
			assert.ok((await owner.close("session-close")).ok);
			assert.deepEqual(receipts, [original]);
		} finally {
			await owner.close("session-close");
		}
	},
);

test("owner message yields all host waits, not other owners or independent SDK observations", async () => {
	const owner = host();
	const other = host();
	const result = deferred<TaskResult>();
	const terminal: TaskResult = { kind: "failed", code: "Expected", message: "Original execution finished" };
	const runner = () => ({ result: result.promise, cleanup: Promise.resolve<Cleanup>({ kind: "reaped" }) });
	try {
		const first = await owner.startAgentTask(intent, operation(), runner);
		const second = await other.startAgentTask(intent, operation(), runner);
		assert.ok(first.ok && second.ok);
		await owner.observeAgentLaunch(first.value.taskId);
		const explicit = owner.waitForTask(first.value.taskId);
		const again = owner.waitForTask(first.value.taskId);
		const { supervisor } = owner.ownerBinding;
		let independentFinished = false;
		const independent = Promise.all([
			other.waitForTask(second.value.taskId),
			supervisor.waitForTask(first.value.lease),
		]).then((outcomes) => {
			independentFinished = true;
			return outcomes;
		});
		owner.yieldTaskWaits("intercom-coordination");
		for (const outcome of await Promise.all([explicit, again])) {
			assert.ok(outcome.ok && outcome.value.kind === "yielded");
			assert.equal(outcome.value.reason, "intercom-coordination");
			assert.equal(outcome.value.taskId, first.value.taskId);
			assert.equal(supervisor.findWait(outcome.value.waitId), undefined);
		}
		assert.equal(independentFinished, false);
		// No stale wait remains subscribed to subsequent owner messages.
		const yieldWait = vi.spyOn(supervisor, "yieldTaskWait");
		owner.yieldTaskWaits("input-needed");
		assert.equal(yieldWait.mock.calls.length, 0);
		yieldWait.mockRestore();
		// A new observation is not interrupted by an old message.
		const next = owner.waitForTask(first.value.taskId);
		result.resolve(terminal);
		for (const outcome of [await next, ...(await independent)]) {
			assert.ok(outcome.ok && outcome.value.kind === "settled");
			assert.deepEqual(outcome.value.result, terminal);
		}
	} finally {
		result.resolve(terminal);
		await owner.close("session-close");
		await other.close("session-close");
	}
});

test.each(["elapsed", "settled", "owner-close"] as const)(
	"%s explicit wait releases its owner-message registration",
	async (ending) => {
		const owner = host();
		const result = deferred<TaskResult>();
		try {
			const started = await owner.startAgentTask(intent, operation(), () => ({
				result: result.promise,
				cleanup: Promise.resolve({ kind: "reaped" }),
			}));
			assert.ok(started.ok);
			await owner.observeAgentLaunch(started.value.taskId);
			const waiting = owner.waitForTask(started.value.taskId, ending === "elapsed" ? 0 : 60_000);
			if (ending === "settled") result.resolve({ kind: "failed", code: "Expected", message: "done" });
			if (ending === "owner-close") await owner.close("session-close");
			assert.ok((await waiting).ok);
			const yieldWait = vi.spyOn(owner.ownerBinding.supervisor, "yieldTaskWait");
			owner.yieldTaskWaits("input-needed");
			assert.equal(yieldWait.mock.calls.length, 0);
			yieldWait.mockRestore();
		} finally {
			result.resolve({ kind: "cancelled", cause: "user" });
			await owner.close("session-close");
		}
	},
);
