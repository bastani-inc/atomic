import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { waitingUntilSettled } from "../src/core/agent-session-tasks.js";
import type { OperationId, TaskId, WaitId, WaitOutcome, YieldReason } from "../src/core/tasks/contracts.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import type { SupervisedCommandOwner } from "../src/core/tools/bash-pty-native.js";
import { createHarness } from "./suite/harness.js";

vi.mock("../src/utils/shell.js", async (importOriginal) => {
	const shell = await importOriginal<typeof import("../src/utils/shell.js")>();
	return { ...shell, isPowerShellAvailable: () => true };
});

const launchShell = process.platform === "win32" ? "powershell" : "bash";
const blockedCommand = {
	powershell: "$value = [Console]::ReadLine(); Write-Output 'tests passed'; exit 7",
	bash: "read value; printf 'tests passed'; exit 7",
};

function yielded(reason: YieldReason): WaitOutcome {
	return { kind: "yielded", taskId: "t-1" as TaskId, waitId: "w" as WaitId, reason };
}

function countingOwner(outcomes: WaitOutcome[]) {
	const budgets: Array<number | undefined> = [];
	const owner = {
		supervisor: {},
		owner: {},
		waitForTask: async (_taskId: TaskId, budgetMs?: number) => {
			budgets.push(budgetMs);
			const next = outcomes.shift();
			assert.ok(next, "no more waits were expected");
			return { ok: true as const, value: next };
		},
	} as unknown as SupervisedCommandOwner;
	return { owner, budgets };
}

test("a shell wait without a budget in a session that may detach waits through elapsed yields until its task settles (#4326)", async () => {
	const settled: WaitOutcome = {
		kind: "settled",
		taskId: "t-1" as TaskId,
		result: { kind: "exited", exitCode: 0 } as never,
	};
	const { owner, budgets } = countingOwner([yielded("elapsed"), yielded("elapsed"), settled]);

	const observed = await waitingUntilSettled(owner, true).waitForTask?.("t-1" as TaskId);

	assert.deepEqual(observed, { ok: true, value: settled });
	assert.deepEqual(budgets, [undefined, undefined, undefined]);
});

test("a shell wait still returns at once when it yields for a message, has a budget, or the session cannot detach (#4326)", async () => {
	const byMessage = countingOwner([yielded("intercom-coordination")]);
	assert.deepEqual(await waitingUntilSettled(byMessage.owner, true).waitForTask?.("t-1" as TaskId), {
		ok: true,
		value: yielded("intercom-coordination"),
	});
	const budgeted = countingOwner([yielded("elapsed")]);
	await waitingUntilSettled(budgeted.owner, true).waitForTask?.("t-1" as TaskId, 500);
	const noPolicy = countingOwner([yielded("elapsed")]);
	await waitingUntilSettled(noPolicy.owner, false).waitForTask?.("t-1" as TaskId);

	assert.deepEqual([byMessage.budgets, budgeted.budgets, noPolicy.budgets], [[undefined], [500], [undefined]]);
});

test("only a shell wait without a budget may detach; commands and budgeted waits never do (#4326)", () => {
	const detachable = createBashToolDefinition(process.cwd()).detachable;
	assert.equal(typeof detachable, "function");
	const decide = detachable as (args: object) => boolean;

	assert.deepEqual(
		[
			decide({ action: "wait", id: "t-1" }),
			decide({ action: "wait", id: "t-1", budgetMs: 0 }),
			decide({ command: "make test" }),
		],
		[true, false, false],
	);
});

test("a model's shell wait detaches under a release policy and its result arrives once the task finishes (#4326)", async () => {
	const harness = await createHarness({
		settings: { bashInterceptor: { enabled: false } },
		initialActiveToolNames: ["bash", "powershell"],
	});
	const { session } = harness;
	try {
		const shell = session.agent.state.tools.find((item) => item.name === launchShell);
		assert.ok(shell);
		const launched = await shell.execute("launch", {
			command: blockedCommand[launchShell],
			wait: { kind: "background" },
			timeout: 20,
		});
		const taskId = (launched.details as { observation: { taskId: TaskId } }).observation.taskId;
		session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(launchShell, { action: "wait", id: taskId }, { id: "w-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("noted"),
		]);

		await session.prompt("wait for the tests");
		const [detached] = session.takeDetachedToolCalls();
		assert.equal(detached?.toolCallId, "w-1");

		const host = session.getAgentTaskHost();
		const task = host.resolveTask(taskId);
		assert.ok(task.ok);
		const input = host.ownerBinding.supervisor.taskStdin(task.value);
		assert.ok(input.ok);
		const written = await host.ownerBinding.supervisor.writeTaskInput(
			input.value,
			crypto.randomUUID() as OperationId,
			{
				kind: "bytes",
				bytes: Buffer.from("ready\n"),
			},
		);
		assert.ok(written.ok);
		const result = await detached.result;

		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.result.content), /tests passed/);
		assert.equal((result.result.details as { exitCode?: number }).exitCode, 7);
	} finally {
		await harness.cleanup();
	}
});

test("a session's own shell task owner, and a subagent child's owner in its parent, both wait until settled under a policy (#4326)", async () => {
	const harness = await createHarness({ settings: { bashInterceptor: { enabled: false } } });
	try {
		const internal = harness.session as unknown as AgentSessionInternalSurface;
		const settled: WaitOutcome = {
			kind: "settled",
			taskId: "t-1" as TaskId,
			result: { kind: "exited", exitCode: 0 } as never,
		};
		const { supervisor } = harness.session.getAgentTaskHost().ownerBinding;
		const ownOutcomes = [yielded("elapsed"), yielded("elapsed"), settled];
		let ownWaits = 0;
		supervisor.waitForTaskId = async () => {
			ownWaits += 1;
			const next = ownOutcomes.shift();
			assert.ok(next);
			return { ok: true, value: next };
		};
		harness.session.setToolDetachment({ afterMs: 60_000 });
		await internal._getCommandTaskOwner()?.waitForTask?.("t-1" as TaskId);

		const child = countingOwner([yielded("elapsed"), settled]);
		Object.assign(internal, {
			_subagentPolicy: { depth: 1 },
			_parentCommandTaskOwner: { bind: () => child.owner, unbind() {} },
		});
		await internal._getCommandTaskOwner()?.waitForTask?.("t-1" as TaskId);

		assert.deepEqual([ownWaits, child.budgets.length], [3, 2]);
	} finally {
		Object.assign(harness.session as unknown as AgentSessionInternalSurface, {
			_subagentPolicy: undefined,
			_parentCommandTaskOwner: undefined,
		});
		await harness.cleanup();
	}
});
