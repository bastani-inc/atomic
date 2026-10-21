import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test, vi } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type {
	CancelReceipt,
	OperationId,
	OwnerScope,
	TaskId,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { BashToolDetails } from "../../packages/coding-agent/src/core/tools/bash.js";
import { createAllTools, getDefaultToolNames } from "../../packages/coding-agent/src/core/tools/index.js";
import { sleep } from "../helpers/runtime.js";

test("kill is registered by default with only a required task ID and refuses unbound execution", async () => {
	assert.ok(getDefaultToolNames({ powerShellAvailable: false }).includes("kill"));
	assert.ok(getDefaultToolNames({ powerShellAvailable: true }).includes("kill"));
	const tool = createAllTools(process.cwd()).kill;
	assert.equal(tool.name, "kill");
	const schema = tool.parameters as { required: string[]; properties: Record<string, object> };
	assert.deepEqual(schema.required, ["id"]);
	assert.deepEqual(Object.keys(schema.properties), ["id"]);
	assert.equal(Value.Check(tool.parameters, { id: "task-1-1-1" }), true);
	assert.equal(Value.Check(tool.parameters, {}), false);
	assert.equal(Value.Check(tool.parameters, { id: 123 }), false);
	await assert.rejects(tool.execute("kill-unbound", { id: "task-1-1-1" }), /task owner/i);
});

function host(kind: OwnerScope["kind"] = "session") {
	const sessionId = crypto.randomUUID();
	return new AgentTaskHost({
		scope:
			kind === "session"
				? { kind, sessionId }
				: { kind, sessionId, runId: "run", stageId: "stage", stageAttemptId: crypto.randomUUID() },
		tasks: { wait: { kind: "automatic", commandBudgetMs: 0 } },
		authorizeLaunch() {},
	});
}

function tools(owner: AgentTaskHost) {
	return createAllTools(process.cwd(), {
		bash: { taskOwner: owner.ownerBinding },
		powershell: { taskOwner: owner.ownerBinding },
		kill: { taskOwner: () => owner.ownerBinding },
	});
}

async function settled(owner: AgentTaskHost, id: TaskId) {
	const watch = owner.watchOwnerTasks();
	assert.ok(watch.ok);
	try {
		const deadline = Date.now() + 5000;
		for (;;) {
			watch.value.drain();
			const task = watch.value.snapshot.tasks.find((entry) => entry.ref.taskId === id);
			assert.ok(task);
			if (task.execution.kind === "settled" && task.cleanup.kind === "reaped") return task;
			assert.ok(Date.now() < deadline, JSON.stringify(task));
			await sleep(10);
		}
	} finally {
		watch.value.dispose();
	}
}

for (const kind of ["session", "workflow-stage"] as const) {
	for (const mode of ["background", "automatic"] as const) {
		for (const shell of process.platform === "win32" ? (["bash", "powershell"] as const) : (["bash"] as const)) {
			test(`registered kill cancels ${mode} ${shell} for ${kind}, retains output and repeats honestly`, async () => {
				const owner = host(kind);
				const registered = tools(owner);
				try {
					const tool = registered[shell];
					assert.ok(tool, `${shell} must be available on this test platform`);
					const launched = await tool.execute("launch", {
						command:
							shell === "powershell"
								? 'Write-Output "retained-kill-output"; Start-Sleep -Seconds 60'
								: 'printf "retained-kill-output\\n"; sleep 60',
						...(mode === "background" ? { wait: { kind: "background" } } : {}),
					});
					const observation = (launched.details as BashToolDetails).observation;
					assert.ok(observation?.kind === "yielded");
					const id = observation.taskId;
					const lease = owner.resolveTask(id);
					assert.ok(lease.ok);
					const deadline = Date.now() + 5000;
					for (;;) {
						const output = await owner.ownerBinding.supervisor.readTaskOutput(lease.value, {
							start: "0",
							maximumBytes: 8192,
						});
						assert.ok(output.ok);
						if (
							Buffer.concat(output.value.chunks.map((chunk) => chunk.bytes))
								.toString()
								.includes("retained-kill-output")
						)
							break;
						assert.ok(Date.now() < deadline, "shell ready output");
						await sleep(10);
					}
					const first = await registered.kill.execute("stop", { id });
					assert.equal((first.details as CancelReceipt).taskId, id);
					const terminal = await settled(owner, id);
					assert.ok(terminal.execution.kind === "settled");
					assert.equal(terminal.execution.result.kind, "cancelled");
					assert.equal(terminal.wasBackground, true);
					const repeated = await registered.kill.execute("repeat", { id });
					assert.equal((repeated.details as CancelReceipt).decision, (first.details as CancelReceipt).decision);
					assert.deepEqual((repeated.details as CancelReceipt).execution, terminal.execution);
					const output = await owner.ownerBinding.supervisor.readTaskOutput(lease.value, {
						start: "0",
						maximumBytes: 8192,
					});
					assert.ok(output.ok);
					assert.match(
						Buffer.concat(output.value.chunks.map((chunk) => chunk.bytes)).toString(),
						/retained-kill-output/,
					);
				} finally {
					assert.ok((await owner.close("session-close")).ok);
				}
			});
		}
	}
}

test("registered kill rejects malformed, unknown, foreign and agent IDs without cancellation", async () => {
	const owner = host();
	const foreign = host();
	const registered = tools(owner);
	const started = await foreign.startAgentTask(
		{ kind: "agent", agent: "worker", task: "test" },
		crypto.randomUUID() as OperationId,
		() => ({ result: new Promise(() => {}), cleanup: Promise.resolve({ kind: "reaped" }) }),
	);
	const agent = await owner.startAgentTask(
		{ kind: "agent", agent: "worker", task: "test" },
		crypto.randomUUID() as OperationId,
		() => ({ result: new Promise(() => {}), cleanup: Promise.resolve({ kind: "reaped" }) }),
	);
	assert.ok(started.ok && agent.ok);
	const cancel = vi.spyOn(owner.ownerBinding.supervisor, "cancelTask");
	try {
		for (const id of ["", "not-a-task", "task-999999-999999-999999", " task-1-1-1 ", started.value.taskId]) {
			await assert.rejects(registered.kill.execute("invalid", { id }));
		}
		await assert.rejects(registered.kill.execute("agent", { id: agent.value.taskId }), /only supports shell/);
		assert.equal(cancel.mock.calls.length, 0);
	} finally {
		cancel.mockRestore();
		assert.ok((await owner.close("session-close")).ok);
		assert.ok((await foreign.close("session-close")).ok);
	}
});

test("kill preserves natural completion and the winner of concurrent completion/cancellation", async () => {
	const owner = host();
	const registered = tools(owner);
	try {
		for (const finishFirst of [true, false]) {
			const launch = await registered.bash.execute("quick", {
				command: "printf original-result",
				wait: { kind: "background" },
			});
			const observation = (launch.details as BashToolDetails).observation;
			assert.ok(observation?.kind === "yielded");
			const id = observation.taskId;
			const original = finishFirst ? await settled(owner, id) : undefined;
			const results = await Promise.all([
				registered.kill.execute("race-a", { id }),
				registered.kill.execute("race-b", { id }),
			]);
			const final = await settled(owner, id);
			assert.ok(final.execution.kind === "settled");
			if (original) {
				assert.equal((results[0].details as CancelReceipt).decision, "already-settled");
				assert.deepEqual(final.execution, original.execution);
				assert.equal(final.execution.result.kind, "completed");
			}
			const repeated = await registered.kill.execute("final", { id });
			assert.deepEqual((repeated.details as CancelReceipt).execution, final.execution);
			assert.equal((repeated.details as CancelReceipt).cleanup.kind, "reaped");
		}
	} finally {
		assert.ok((await owner.close("session-close")).ok);
	}
});

test("kill reports cancellation rejection, thrown failures and current cleanup failure without inventing success", async () => {
	const owner = host();
	const registered = tools(owner);
	try {
		const launch = await registered.bash.execute("launch-failures", {
			command: "sleep 60",
			wait: { kind: "background" },
		});
		const observation = (launch.details as BashToolDetails).observation;
		assert.ok(observation?.kind === "yielded");
		const id = observation.taskId;
		const supervisor = owner.ownerBinding.supervisor;
		const cancel = vi.spyOn(supervisor, "cancelTask");
		try {
			cancel.mockResolvedValueOnce({ ok: false, error: { code: "CleanupFailed", message: "termination denied" } });
			await assert.rejects(registered.kill.execute("rejected", { id }), (error: Error & { code?: string }) => {
				assert.equal(error.code, "CleanupFailed");
				assert.equal(error.message, `CleanupFailed: Could not stop task "${id}": termination denied`);
				return true;
			});
			cancel.mockRejectedValueOnce(new Error("native cancellation unavailable"));
			await assert.rejects(registered.kill.execute("throws", { id }), /native cancellation unavailable/);
		} finally {
			cancel.mockRestore();
		}
		await registered.kill.execute("real-cancel", { id });
		await settled(owner, id);
		const failure = {
			kind: "failed" as const,
			resources: [{ resource: "process", code: "Denied", message: "cleanup denied" }],
		};
		const receipt: CancelReceipt = {
			taskId: id,
			decision: "cancellation-requested",
			execution: { kind: "cancelling", cause: "user" },
			cleanup: failure,
		};
		const failureSpy = vi.spyOn(supervisor, "cancelTask").mockResolvedValue({ ok: true, value: receipt });
		try {
			const result = await registered.kill.execute("cleanup-failure", { id });
			assert.equal((result as typeof result & { isError?: boolean }).isError, true);
			assert.equal(result.details, receipt);
			assert.match(JSON.stringify(result.content), /cleanup denied/);
		} finally {
			failureSpy.mockRestore();
		}
	} finally {
		assert.ok((await owner.close("session-close")).ok);
	}
});

test.runIf(process.platform !== "win32")(
	"kill terminates a real shell and its descendant before cleanup is reaped",
	async () => {
		const owner = host();
		const registered = tools(owner);
		try {
			const launch = await registered.bash.execute("descendants", {
				command: 'sleep 60 & child=$!; printf "%s %s\\n" "$$" "$child"; wait',
				wait: { kind: "background" },
			});
			const observation = (launch.details as BashToolDetails).observation;
			assert.ok(observation?.kind === "yielded");
			const id = observation.taskId;
			const task = owner.resolveTask(id);
			assert.ok(task.ok);
			const deadline = Date.now() + 5000;
			let pids: number[] = [];
			while (pids.length !== 2) {
				const page = await owner.ownerBinding.supervisor.readTaskOutput(task.value, {
					start: "0",
					maximumBytes: 1024,
				});
				assert.ok(page.ok);
				const text = Buffer.concat(page.value.chunks.map((chunk) => chunk.bytes)).toString();
				if (/^\d+ \d+\n$/.test(text)) pids = text.trim().split(" ").map(Number);
				else {
					assert.ok(Date.now() < deadline, "descendant ready output");
					await sleep(10);
				}
			}
			for (const pid of pids) assert.equal(process.kill(pid, 0), true);
			await registered.kill.execute("kill-descendants", { id });
			await settled(owner, id);
			for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		} finally {
			assert.ok((await owner.close("session-close")).ok);
		}
	},
);

test("kill resolves the live owner and cannot cancel a foreign shell after owner replacement", async () => {
	const original = host();
	const replacement = host("workflow-stage");
	let current = original;
	const registered = createAllTools(process.cwd(), {
		bash: { taskOwner: original.ownerBinding },
		kill: { taskOwner: () => current.ownerBinding },
	});
	try {
		const launch = await registered.bash.execute("original-owner", {
			command: "sleep 60",
			wait: { kind: "background" },
		});
		const observation = (launch.details as BashToolDetails).observation;
		assert.ok(observation?.kind === "yielded");
		const id = observation.taskId;
		current = replacement;
		await assert.rejects(registered.kill.execute("foreign-shell", { id }));
		const watch = original.watchOwnerTasks();
		assert.ok(watch.ok);
		assert.equal(watch.value.snapshot.tasks.find((task) => task.ref.taskId === id)?.execution.kind, "running");
		watch.value.dispose();
		current = original;
		await registered.kill.execute("original-kill", { id });
		await settled(original, id);
	} finally {
		assert.ok((await original.close("session-close")).ok);
		assert.ok((await replacement.close("stage-close")).ok);
	}
});
