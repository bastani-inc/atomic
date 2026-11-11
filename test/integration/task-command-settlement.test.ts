import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as native from "@bastani/atomic-natives";
import { test } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSupervisor, type WaitLease } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { sleep } from "../helpers/runtime.js";

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
const operation = () => randomUUID() as C.OperationId;
async function eventually(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!check() && Date.now() < deadline) await sleep(5);
	assert.ok(check(), "trusted host must receive the command settlement");
}
function harness(scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() }) {
	const supervisor = new TaskSupervisor();
	const settlements: Array<{ ref: C.NativeTaskRef; receipt: C.SettlementReceipt }> = [];
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		onTaskSettled(ref, receipt) {
			settlements.push({ ref, receipt });
		},
		createRunner() {
			throw new Error("command must not launch an agent runner");
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const actor = new native.TaskSupervisor();
	const nativeOwner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
	const journal = value(actor.watchOwnerTasks(nativeOwner, () => {}));
	return { supervisor, scope, host, owner, actor, nativeOwner, journal, settlements };
}

test.runIf(process.platform !== "win32")(
	"background command notifies its trusted host once with the native terminal receipt without another observation or execution",
	async () => {
		const h = harness();
		const intent: C.CommandIntent = {
			kind: "command",
			command: "read line; printf '%s' \"$line\"",
			terminal: { kind: "pipe" },
		};
		const op = operation();
		try {
			const task = value(await h.supervisor.startCommandTask(h.owner, intent, op));
			const ref = h.supervisor.taskReference(task);
			const input = value(h.supervisor.taskStdin(task));
			const watch = value(h.supervisor.watchOwnerTasks(h.owner));
			assert.deepEqual(watch.snapshot.tasks[0].observation, { kind: "background", reason: "not-observed" });
			assert.equal(value(await h.supervisor.initialObservation(task, { kind: "background" })).kind, "yielded");
			watch.drain();
			assert.deepEqual(watch.snapshot.tasks[0].observation, { kind: "background", reason: "explicit" });
			assert.equal(watch.snapshot.tasks[0].wasBackground, true);
			assert.equal(h.settlements.length, 0);
			value(
				await h.supervisor.writeTaskInput(input, operation(), {
					kind: "bytes",
					bytes: new TextEncoder().encode("done\n"),
				}),
			);
			await eventually(() => h.settlements.length === 1);
			watch.drain();
			assert.equal(
				watch.snapshot.tasks[0].wasBackground,
				true,
				"settlement keeps authoritative background membership",
			);
			const events = value(h.actor.drainOwnerTasks(h.journal.lease)).events;
			const terminal = events.find((event) => event.payload.kind === "task-settled");
			assert.ok(terminal?.payload.kind === "task-settled");
			assert.deepEqual(h.settlements, [
				{
					ref,
					receipt: {
						taskId: ref.taskId,
						cursor: terminal.cursor,
						completionId: terminal.payload.completionId,
						result: terminal.payload.result,
					},
				},
			]);
			assert.equal(h.settlements[0].receipt.result.kind, "completed");
			assert.equal(events.filter((event) => event.payload.kind === "wait-started").length, 1);
			const peer = new TaskSupervisor();
			assert.equal(value(peer.openTaskOwner(h.host, h.scope)), h.owner);
			assert.equal(value(await peer.startCommandTask(h.owner, intent, op)), task);
			watch.drain();
			watch.dispose();
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			assert.equal(h.settlements.length, 1);
			const later = value(h.actor.drainOwnerTasks(h.journal.lease)).events;
			assert.equal(
				later.some((event) => event.payload.kind === "task-admitted" || event.payload.kind === "task-started"),
				false,
			);
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
	},
);

test.runIf(process.platform !== "win32").each(["user", "owner-close", "execution-timeout"] as const)(
	"command cancellation (%s) delivers its retained native receipt once, including after owner closure",
	async (cause) => {
		const h = harness();
		try {
			const task = value(
				await h.supervisor.startCommandTask(
					h.owner,
					{
						kind: "command",
						command: "read line",
						terminal: { kind: "pipe" },
						...(cause === "execution-timeout" ? { executionTimeoutMs: 25 } : {}),
					},
					operation(),
				),
			);
			const ref = h.supervisor.taskReference(task);
			const nativeTask = value(h.actor.lookupTask(h.nativeOwner, ref.taskId));
			if (cause !== "execution-timeout") {
				assert.deepEqual(h.actor.taskSettlement(nativeTask), {
					ok: false,
					error: { code: "TaskNotSettled", message: "TaskNotSettled" },
				});
				value(await h.supervisor.initialObservation(task, { kind: "background" }));
				if (cause === "user") value(await h.supervisor.cancelTask(task, cause));
				else value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			}
			await eventually(() => h.settlements.length === 1);
			const receipt = value(h.actor.taskSettlement(nativeTask));
			assert.equal(receipt.result.kind, "cancelled");
			assert.equal(receipt.result.kind === "cancelled" && receipt.result.cause, cause);
			// The host's receipt also names the close or the timeout, which the native receipt does not carry (#4639).
			const named =
				cause === "owner-close"
					? { ownerClose: "session-close" }
					: cause === "execution-timeout"
						? { executionTimeoutMs: 25 }
						: {};
			assert.deepEqual(h.settlements, [{ ref, receipt: { ...receipt, result: { ...receipt.result, ...named } } }]);
			const terminal = value(h.actor.drainOwnerTasks(h.journal.lease)).events.find(
				(event) => event.payload.kind === "task-settled",
			);
			assert.ok(terminal?.payload.kind === "task-settled");
			assert.deepEqual(receipt.cursor, terminal.cursor);
			assert.equal(receipt.completionId, terminal.payload.completionId);
			assert.deepEqual(receipt.result, terminal.payload.result);
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			value(await h.supervisor.cancelTask(task, "shutdown"));
			assert.deepEqual(value(h.actor.taskSettlement(nativeTask)), receipt);
			assert.equal(h.settlements.length, 1);
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
	},
);

test.runIf(process.platform !== "win32").each(["session-close", "stage-close", "app-shutdown"] as const)(
	"a command cancelled by its owner's %s names that close in its settlement, its wait, its close and kill receipts (#4639)",
	async (closeCause) => {
		const h = harness();
		try {
			const task = value(
				await h.supervisor.startCommandTask(
					h.owner,
					{ kind: "command", command: "read line", terminal: { kind: "pipe" } },
					operation(),
				),
			);
			const waiting = h.supervisor.initialObservation(task, { kind: "foreground", budgetMs: 60_000 });
			const closed = value(await h.supervisor.closeTaskOwner(h.owner, closeCause));
			await eventually(() => h.settlements.length === 1);
			const settled = h.settlements[0]!.receipt.result;
			assert.deepEqual(
				settled.kind === "cancelled" ? { cause: settled.cause, ownerClose: settled.ownerClose } : settled,
				{ cause: "owner-close", ownerClose: closeCause },
			);
			const waited = value(await waiting);
			assert.deepEqual(waited, {
				kind: "settled",
				taskId: h.supervisor.taskReference(task).taskId,
				result: settled,
			});
			assert.deepEqual(closed.tasks[0]!.execution, { kind: "settled", result: settled });
			const killed = value(await h.supervisor.cancelTask(task, "user"));
			assert.deepEqual(killed.execution, { kind: "settled", result: settled });
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
	},
);

test.runIf(process.platform !== "win32")(
	"a command its execution timeout stops names the timeout in its settlement, its wait and its owner's record (#4639)",
	async () => {
		const h = harness();
		try {
			const task = value(
				await h.supervisor.startCommandTask(
					h.owner,
					{ kind: "command", command: "read line", terminal: { kind: "pipe" }, executionTimeoutMs: 300 },
					operation(),
				),
			);
			let registered: WaitLease | undefined;
			const waiting = h.supervisor.waitForTaskId(
				h.owner,
				h.supervisor.taskReference(task).taskId,
				10_000,
				(wait) => {
					registered = wait;
				},
			);
			assert.ok(registered);
			const yielded = value(h.supervisor.yieldTaskWait(registered, "explicit"));
			assert.deepEqual(
				{ kind: yielded.kind, taskId: yielded.taskId },
				{ kind: "yielded", taskId: h.supervisor.taskReference(task).taskId },
			);
			assert.equal(value(await waiting).kind, "yielded");
			const foreground = value(await h.supervisor.foregroundTask(task, 10_000));
			const observed = value(await h.supervisor.initialObservation(task, { kind: "foreground", budgetMs: 10_000 }));
			assert.deepEqual(foreground, observed);
			const timedOut = { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 300 };
			assert.ok(observed.kind === "settled");
			assert.deepEqual({ ...observed.result, output: undefined }, { ...timedOut, output: undefined });
			await eventually(() => h.settlements.length === 1);
			assert.deepEqual(h.settlements[0]!.receipt.result, observed.result);
			const watch = value(h.supervisor.watchOwnerTasks(h.owner));
			assert.deepEqual(watch.snapshot.tasks[0]!.execution, { kind: "settled", result: observed.result });
			watch.dispose();
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
	},
);

test.runIf(process.platform !== "win32")(
	"a command its user stopped names no owner close or timeout, also once its owner has closed (#4639)",
	async () => {
		const h = harness();
		try {
			const task = value(
				await h.supervisor.startCommandTask(
					h.owner,
					{ kind: "command", command: "read line", terminal: { kind: "pipe" }, executionTimeoutMs: 60_000 },
					operation(),
				),
			);
			value(await h.supervisor.cancelTask(task, "user"));
			await eventually(() => h.settlements.length === 1);
			const { output, ...stopped } = h.settlements[0]!.receipt.result as Extract<
				C.TaskResult,
				{ kind: "cancelled" }
			>;
			assert.deepEqual(stopped, { kind: "cancelled", cause: "user" });
			value(await h.supervisor.closeTaskOwner(h.owner, "stage-close"));
			const killed = value(await h.supervisor.cancelTask(task, "user"));
			assert.deepEqual(killed.execution, { kind: "settled", result: h.settlements[0]!.receipt.result });
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
	},
);

test.runIf(process.platform !== "win32")(
	"a command launch tells its host whether its owner's session or a subagent child launched it (#4639)",
	async () => {
		const supervisor = new TaskSupervisor();
		const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
		const origins: string[] = [];
		const host = supervisor.bindHostSession({
			scope,
			authorizeLaunch() {},
			authorizeCommandLaunch(_intent, origin) {
				origins.push(origin);
			},
			createRunner() {
				throw new Error("command must not launch an agent runner");
			},
		});
		const owner = value(supervisor.openTaskOwner(host, scope));
		const intent: C.CommandIntent = { kind: "command", command: "true", terminal: { kind: "pipe" } };
		try {
			value(await supervisor.startCommandTask(owner, intent, operation()));
			value(await supervisor.startCommandTask(owner, intent, operation(), undefined, "subagent-child"));
			assert.deepEqual(origins, ["owner", "subagent-child"]);
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);

test.runIf(process.platform !== "win32")(
	"admitted command setup failure notifies the host even when no facade task lease is returned",
	async () => {
		const h = harness();
		const intent: C.CommandIntent = {
			kind: "command",
			command: "printf never",
			terminal: { kind: "pipe" },
			cwd: `/nonexistent-atomic-command-${randomUUID()}`,
		};
		const op = operation();
		try {
			const failed = await h.supervisor.startCommandTask(h.owner, intent, op);
			assert.equal(!failed.ok && failed.error.code, "SpawnFailed");
			await eventually(() => h.settlements.length === 1);
			const { ref, receipt } = h.settlements[0];
			assert.equal(receipt.result.kind === "failed" && receipt.result.code, "SpawnFailed");
			const nativeTask = value(h.actor.lookupTask(h.nativeOwner, ref.taskId));
			assert.deepEqual(value(h.actor.taskSettlement(nativeTask)), receipt);
			const events = value(h.actor.drainOwnerTasks(h.journal.lease)).events;
			const terminal = events.find((event) => event.payload.kind === "task-settled");
			assert.ok(terminal?.payload.kind === "task-settled");
			assert.deepEqual(receipt.cursor, terminal.cursor);
			assert.equal(receipt.completionId, terminal.payload.completionId);
			assert.deepEqual(receipt.result, terminal.payload.result);
			assert.deepEqual(await h.supervisor.startCommandTask(h.owner, intent, op), failed);
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			assert.equal(h.settlements.length, 1);
			assert.equal(events.filter((event) => event.payload.kind === "task-admitted").length, 1);
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
	},
);

// Block JS delivery while the real command worker settles and reaps; no fake timer or event is involved.
function nativeSettlementWhileJsPaused(
	h: Pick<ReturnType<typeof harness>, "actor" | "nativeOwner">,
	task: native.TaskLease,
): native.SettlementReceipt {
	const ref = value(h.actor.taskReference(task));
	const pause = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const probe = value(h.actor.watchOwnerTasks(h.nativeOwner, () => {}));
		h.actor.disposeSubscription(probe.lease);
		const record = probe.snapshot.tasks.find((record) => record.ref.taskId === ref.taskId);
		if (record?.execution.kind === "settled" && record.cleanup.kind === "reaped")
			return value(h.actor.taskSettlement(task));
		Atomics.wait(pause, 0, 0, 5);
	}
	throw new Error("native command must settle while JS delivery is paused");
}

test.runIf(process.platform !== "win32").each(["completed", "cancelled"] as const)(
	"%s command receipt survives journal reset with no surviving settlement event or later command event",
	async (resultKind) => {
		const h = harness();
		const noise = value(
			h.actor.startAgentTask(h.nativeOwner, { kind: "agent", agent: "noise", task: "evict journal" }, operation()),
		);
		const runner = value(h.actor.claimTaskRunner(noise));
		try {
			const task = value(
				await h.supervisor.startCommandTask(
					h.owner,
					{
						kind: "command",
						command: "read line; printf '%s' \"$line\"",
						terminal: { kind: "pipe" },
					},
					operation(),
				),
			);
			const ref = h.supervisor.taskReference(task);
			const nativeTask = value(h.actor.lookupTask(h.nativeOwner, ref.taskId));
			value(await h.supervisor.initialObservation(task, { kind: "background" }));
			const released =
				resultKind === "cancelled"
					? h.supervisor.cancelTask(task, "user")
					: h.supervisor.writeTaskInput(value(h.supervisor.taskStdin(task)), operation(), {
							kind: "bytes",
							bytes: new TextEncoder().encode("done\n"),
						});
			const receipt = nativeSettlementWhileJsPaused(h, nativeTask);
			assert.equal(receipt.result.kind, resultKind);
			value(
				h.actor.reportTaskActivity(runner, {
					reportId: "evict-terminal",
					change: { kind: "action", tool: "noise", text: "x".repeat(128 * 1024) },
				}),
			);
			const reset = value(h.actor.drainOwnerTasks(h.journal.lease));
			assert.equal(reset.reset, true);
			assert.deepEqual(reset.events, []);
			assert.ok(reset.snapshot);
			assert.ok(BigInt(reset.snapshot.cursor.sequence) > BigInt(receipt.cursor.sequence));
			assert.equal(h.settlements.length, 0, "no JS callback can run before the journal is evicted");
			assert.ok((await released).ok);
			await eventually(() => h.settlements.length === 1);
			assert.deepEqual(h.settlements, [{ ref, receipt }]);
			assert.deepEqual(value(h.actor.taskSettlement(nativeTask)), receipt);
			assert.deepEqual(value(h.actor.drainOwnerTasks(h.journal.lease)).events, []);
		} finally {
			value(h.actor.reportRunnerOutcome(runner, { kind: "failed", code: "fixture", message: "done" }));
			value(h.actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			h.actor.disposeSubscription(h.journal.lease);
		}
		// Owner reconciliation also delivers the journal-noise agent's real teardown outcome.
		assert.equal(h.settlements.length, 2);
		assert.deepEqual(h.settlements[1], {
			ref: value(h.actor.taskReference(noise)),
			receipt: value(h.actor.taskSettlement(noise)),
		});
	},
);

test.runIf(process.platform !== "win32")(
	"host binding recovers an already-settled command from the initial snapshot without another event",
	async () => {
		const actor = new native.TaskSupervisor();
		const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
		const nativeOwner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
		const task = value(
			await actor.startCommandTask(
				nativeOwner,
				{ kind: "command", command: "printf ready", terminal: { kind: "pipe" } },
				operation(),
			),
		);
		const receipt = nativeSettlementWhileJsPaused({ actor, nativeOwner }, task);
		const h = harness(scope);
		try {
			await eventually(() => h.settlements.length === 1);
			assert.deepEqual(h.settlements, [{ ref: value(actor.taskReference(task)), receipt }]);
			assert.deepEqual(value(actor.drainOwnerTasks(h.journal.lease)).events, []);
			assert.equal(value(new TaskSupervisor().openTaskOwner(h.host, scope)), h.owner);
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			assert.equal(h.settlements.length, 1);
		} finally {
			value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
			actor.disposeSubscription(h.journal.lease);
		}
	},
);
