/**
 * A subagent task records the model its launch asked for beside the model it ran on, and its completion notice says
 * when they differ, so a parent is never told a child ran on the model it asked for when it did not (#4188).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import {
	formatTaskCompletion,
	ranOnModelLine,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { formatTaskHeartbeatStatus } from "../../packages/coding-agent/src/core/tasks/heartbeat-notice.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";

const REQUESTED = "account-a/argon:high";

async function settledTask(ranOn: string) {
	const fixture = taskFixture();
	const lease = taskValue(
		await fixture.supervisor.startAgentTask(
			fixture.owner,
			{ kind: "agent", agent: "worker", task: "Review the diff", requestedModel: REQUESTED },
			randomUUID() as C.OperationId,
		),
	);
	taskValue(await fixture.supervisor.initialObservation(lease, { kind: "background" }));
	fixture.store.drain();
	taskValue(
		fixture.runners[0].context.reportActivity({
			reportId: "model",
			change: { kind: "model", model: ranOn, thinking: "high" },
		}),
	);
	await fixture.settle();
	const task = fixture.store.tasks[0];
	const envelope = {
		completionId: "completion",
		ownerId: task.ref.ownerId,
		taskId: task.ref.taskId,
		terminalSequence: "1" as C.Sequence,
		result: { kind: "completed" as const, output: task.output },
		display: false as const,
	};
	return { fixture, task, envelope };
}

test("a subagent that ran on a fallback model records the requested model and its notice names both", async () => {
	const { fixture, task, envelope } = await settledTask("account-b/opus");
	try {
		assert.equal(task.requestedModel, REQUESTED);
		assert.equal(task.model, "account-b/opus");
		const text = formatTaskCompletion(envelope, task, "review findings");
		// Both models show as their raw ID and level, the way every model label reads (#4269).
		assert.match(text, /^Model: ran on account-b\/opus {2}high, not the requested account-a\/argon {2}high\.$/m);
		assert.equal(taskCompletionNotice(envelope, task).requestedModel, REQUESTED);
	} finally {
		await fixture.dispose();
	}
});

test("a subagent that ran on the requested model gets no model line", async () => {
	const { fixture, task, envelope } = await settledTask("account-a/argon");
	try {
		assert.doesNotMatch(formatTaskCompletion(envelope, task, "review findings"), /^Model:/m);
	} finally {
		await fixture.dispose();
	}
});

test("a running subagent's heartbeat status names the model it runs on and the one its launch asked for", () => {
	const status = (model: string) =>
		formatTaskHeartbeatStatus({
			taskId: "task-1",
			kind: "agent",
			title: "Review the diff",
			agentName: "worker",
			model,
			thinking: "high",
			requestedModel: REQUESTED,
			elapsedMs: 60_000,
			intervalMs: 300_000,
		});
	assert.match(status("account-b/opus"), /model account-b\/opus {2}high, not the requested account-a\/argon {2}high/);
	assert.doesNotMatch(status("account-a/argon"), /not the requested/);
});

test("a model whose own ID ends in a level word keeps it whole, with its level after it (#4269)", () => {
	// Only the configured request is a `provider/id[:level]` reference; the model a task ran on is a resolved ID.
	assert.equal(
		ranOnModelLine({ kind: "agent", model: "account-b/opus:high", thinking: "low", requestedModel: REQUESTED }),
		"Model: ran on account-b/opus:high  low, not the requested account-a/argon  high.",
	);
});
