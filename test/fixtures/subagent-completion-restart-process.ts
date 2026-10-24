import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

// #3908: one process lifetime of a parent session. Each run is a fresh native environment;
// the second run reopens the session history the first one persisted.
const { values } = parseArgs({
	options: { root: { type: "string" }, dir: { type: "string" }, file: { type: "string" } },
	strict: true,
});
const { root, dir, file } = values;
if (!root || !dir) throw new Error("Provide --root <cwd> --dir <session-dir> [--file <session-file>]");

const manager = file ? await SessionManager.open(file, dir, root) : await SessionManager.create(root, dir);
const harness = await createHarness({ sessionManager: manager });
harness.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("parent saw notice")));
try {
	const host = harness.session.getAgentTaskHost();
	const gates: PromiseWithResolvers<TaskResult>[] = [];
	const taskIds: string[] = [];
	for (let index = 0; index < 3; index++) {
		const gate = Promise.withResolvers<TaskResult>();
		gates.push(gate);
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: `restart ${index}` },
			`restart-${index}` as OperationId,
			() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
		);
		assert.ok(started.ok);
		taskIds.push(started.value.taskId);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
	}
	for (const gate of gates) gate.resolve({ kind: "failed", code: "fixture", message: "restart done" });
	await Promise.all(taskIds.map((taskId) => host.waitForTask(taskId as never)));

	const notices = () =>
		harness
			.eventsOfType("message_end")
			.flatMap(({ message }) =>
				message.role === "custom" && message.customType === "task-completion"
					? [message.details as { taskId: string; completionId: string }]
					: [],
			);
	const deadline = Date.now() + 5_000;
	while (taskIds.some((taskId) => !notices().some((notice) => notice.taskId === taskId))) {
		if (Date.now() > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	// Let any duplicate delivery surface, and the parent finish its notice turns, before reporting.
	await new Promise((resolve) => setTimeout(resolve, 50));
	while (harness.session.isStreaming && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	await new Promise((resolve) => setTimeout(resolve, 50));
	process.stdout.write(
		`RESTART RESULT ${JSON.stringify({ sessionFile: manager.getSessionFile(), taskIds, notices: notices() })}\n`,
	);
} finally {
	await harness.cleanup();
}
