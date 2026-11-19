import assert from "node:assert/strict";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { taskPanelState } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindTaskResumer } from "../../packages/coding-agent/src/core/tasks/task-resumer.js";
import { taskBoardState } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { TaskNavigation } from "../../packages/coding-agent/src/modes/interactive/components/task-navigation.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

function harness(initial: TaskRecord) {
	let current = initial;
	const cancelled: string[] = [];
	const dismissed: string[] = [];
	const navigation = new TaskNavigation(new KeybindingsManager(), {
		inspect() {},
		openChat() {},
		transcript() {},
		armStop() {},
		cancel: (task) => cancelled.push(task.ref.taskId),
		dismiss: (task) => dismissed.push(task.ref.taskId),
		input() {},
		stdinAvailable: () => false,
		openQuestion() {},
		currentTask: () => current,
	});
	navigation.update([initial]);
	navigation.open();
	return {
		navigation,
		cancelled,
		dismissed,
		settle() {
			current = {
				...current,
				execution: { kind: "settled", result: { kind: "completed", output: current.output } },
			};
			return current;
		},
	};
}

test("a confirming stop reads the current task before cancelling it (#5224)", () => {
	const h = harness(taskRecord("finished-between-keys"));
	h.navigation.handleInput("x", "tasks");
	h.settle();
	h.navigation.handleInput("x", "tasks");
	assert.deepEqual(h.cancelled, []);
	assert.deepEqual(h.dismissed, []);
});

test("a task that settled after its last paint is not dismissed by x until its result is painted (#5224)", () => {
	const running = taskRecord("finished-after-paint");
	const h = harness(running);
	h.navigation.paint([running]);
	const settled = h.settle();
	h.navigation.update([settled]);
	h.navigation.handleInput("x", "tasks");
	h.navigation.handleInput("x", "tasks");
	assert.deepEqual(h.cancelled, []);
	assert.deepEqual(h.dismissed, []);
	h.navigation.paint([settled]);
	h.navigation.handleInput("x", "tasks");
	assert.deepEqual(h.dismissed, [running.ref.taskId]);
});

test("a clipped peek preserves the last painted task state before a stop key (#5224)", () => {
	const running = taskRecord("clipped-before-finish");
	const h = harness(running);
	h.navigation.paint([running]);
	h.navigation.paint([]);
	const settled = h.settle();
	h.navigation.update([settled]);
	h.navigation.handleInput("x", "tasks");
	assert.deepEqual(h.cancelled, []);
	assert.deepEqual(h.dismissed, []);
	assert.equal(h.navigation.finishedWhileArmed?.ref.taskId, running.ref.taskId);
});

test("a pending stop confirmation cannot dismiss a different finished task (#5224)", () => {
	const running = taskRecord("departing");
	const other = taskRecord("finished-other");
	other.execution = { kind: "settled", result: { kind: "completed", output: other.output } };
	const dismissed: string[] = [];
	const navigation = new TaskNavigation(new KeybindingsManager(), {
		inspect() {},
		openChat() {},
		transcript() {},
		armStop() {},
		cancel() {},
		dismiss: (task) => dismissed.push(task.ref.taskId),
		input() {},
		stdinAvailable: () => false,
		openQuestion() {},
	});
	navigation.update([running, other]);
	navigation.open(running.ref.taskId);
	navigation.paint([running, other]);
	navigation.handleInput("x", "tasks");
	navigation.update([other]);
	navigation.handleInput("x", "tasks");
	assert.deepEqual(dismissed, []);
	navigation.handleInput("x", "tasks");
	assert.deepEqual(dismissed, [other.ref.taskId]);
});

test("x x on a subagent released while it waits stops it with confirmation, never dismisses it", () => {
	const released = taskRecord("released-waiting");
	released.execution = {
		kind: "settled",
		result: {
			kind: "cancelled",
			cause: "pause",
			released: { waitingOn: [{ toolCallId: "toolu_1", toolName: "bash" }] },
		},
	};
	const h = harness(released);
	h.navigation.paint([released]);
	h.navigation.handleInput("x", "tasks");
	assert.deepEqual(h.cancelled, [], "the first press only arms the stop");
	assert.deepEqual(h.dismissed, []);
	h.navigation.handleInput("x", "tasks");
	assert.deepEqual(h.cancelled, ["released-waiting"]);
	assert.deepEqual(h.dismissed, []);
});

test("a released subagent that was stopped no longer waits: its row is stopped and x dismisses it", async () => {
	const fixture = taskFixture();
	const lease = await fixture.start();
	const { taskId } = fixture.supervisor.taskReference(lease);
	const unbind = bindTaskResumer(fixture.supervisor, {
		readOnlyReason: () => undefined,
		resume: async () => ({ ok: true }),
		isStopped: (id) => id === taskId,
	});
	try {
		fixture.runners[0].result.resolve({
			kind: "cancelled",
			cause: "pause",
			released: { waitingOn: [{ toolCallId: "toolu_1", toolName: "bash" }] },
		});
		assert.equal(taskValue(await fixture.supervisor.waitForTask(lease)).kind, "settled");
		fixture.store.drain();
		const released = fixture.store.getTask(taskId)!;
		assert.equal(taskBoardState(released), "stopped");
		assert.equal(taskPanelState(released), "stopped");
		const h = harness(released);
		h.navigation.paint([released]);
		h.navigation.handleInput("x", "tasks");
		assert.deepEqual(h.cancelled, []);
		assert.deepEqual(h.dismissed, [taskId]);
	} finally {
		unbind();
		await fixture.dispose();
	}
});
