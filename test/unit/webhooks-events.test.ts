/**
 * The webhook event reducer (`src/extensions/webhooks/events.ts`). Issue #2345:
 * one notification per transition, main-agent outcomes told apart (finished,
 * error, user abort), main-chat questions and workflow questions on separate
 * channels, replayed history never notified, a blocked workflow reported once
 * whichever channel announces it, and nothing secret in a details excerpt.
 * Events are built in the host's own shapes so the reducer is exercised the
 * way the glue will call it.
 */

import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, test } from "vitest";
import type {
	WorkflowLifecycleEvent,
	WorkflowRootActivity,
} from "../../packages/coding-agent/src/core/extensions/workflow-events.js";
import { MAX_WEBHOOK_DEDUPE_KEYS } from "../../packages/coding-agent/src/extensions/webhooks/constants.js";
import {
	INITIAL_WEBHOOK_REDUCER_STATE,
	reduceWebhookEvent,
	seedWorkflowActivity,
	type WebhookReducerEvent,
	type WebhookReducerState,
	type WebhookReduction,
} from "../../packages/coding-agent/src/extensions/webhooks/events.js";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

/** The shape `compaction-borrowing-purity.test.ts` builds; only the fields the reducer reads vary. */
function assistant(
	text: string,
	stopReason: "stop" | "error" | "aborted" = "stop",
	errorMessage?: string,
): AgentMessage {
	return {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: NOW,
	} as AgentMessage;
}

function lifecycle(
	target: WorkflowLifecycleEvent["target"],
	over: Partial<Omit<WorkflowLifecycleEvent, "type" | "target">> = {},
): WorkflowLifecycleEvent {
	return {
		type: "workflow_lifecycle",
		eventId: "evt-1",
		cursor: { epoch: "e", revision: 1 },
		runId: "root",
		rootRunId: "root",
		ownerSessionId: "session",
		occurredAt: NOW,
		observedAt: NOW,
		delivery: "live",
		target,
		...over,
	};
}

function activity(over: Partial<WorkflowRootActivity>): WorkflowRootActivity {
	return {
		rootRunId: "root",
		ownerSessionId: "session",
		state: "working",
		reason: "executing",
		activeExecutionCount: 1,
		actionableBlockCount: 0,
		needsAttention: false,
		...over,
	};
}

/** Feeds events in order and returns every reduction, so a test can assert on any step. */
function run(
	events: readonly (WebhookReducerEvent | [WebhookReducerEvent, { idle?: boolean; now?: number }])[],
	initial: WebhookReducerState = INITIAL_WEBHOOK_REDUCER_STATE,
): WebhookReduction[] {
	const out: WebhookReduction[] = [];
	let state = initial;
	for (const entry of events) {
		const [event, meta] = Array.isArray(entry) ? entry : [entry, {}];
		const reduction = reduceWebhookEvent(state, event, { now: meta.now ?? NOW, idle: meta.idle });
		out.push(reduction);
		state = reduction.state;
	}
	return out;
}

const last = (reductions: WebhookReduction[]) => reductions[reductions.length - 1]!;
const settled = (idle: boolean): [WebhookReducerEvent, { idle: boolean }] => [{ type: "agent_settled" }, { idle }];

describe("main agent", () => {
	test("agent_end records the loop; the next idle settle emits agent_finished once, with the response as details", () => {
		const steps = run([
			{ type: "agent_start" },
			{ type: "agent_end", messages: [assistant("All done.")] },
			settled(true),
			settled(true),
		]);
		assert.deepEqual(steps[2]?.notifications, [
			{
				key: `agent_finished:${NOW}`,
				context: { event: "agent_finished", outcome: "completed", details: "All done." },
			},
		]);
		assert.deepEqual(steps[3]?.notifications, [], "a second settle has nothing left to report");
	});

	test("an error loop is agent_stopped with outcome error and the error text, credentials redacted", () => {
		const steps = run([
			{
				type: "agent_end",
				messages: [assistant("", "error", "provider refused: Authorization: Bearer sk-secret-token")],
			},
			settled(true),
		]);
		const [notice] = last(steps).notifications;
		assert.equal(notice?.context.event, "agent_stopped");
		assert.equal(notice?.context.outcome, "error");
		assert.ok(notice?.context.details?.startsWith("provider refused"), notice?.context.details);
		assert.ok(
			!notice?.context.details?.includes("sk-secret-token"),
			"the token must not survive into a notification",
		);
	});

	test("a user abort is agent_stopped with outcome aborted, so a template can tell it from an error", () => {
		const steps = run([{ type: "agent_end", messages: [assistant("partial answer", "aborted")] }, settled(true)]);
		assert.deepEqual(last(steps).notifications, [
			{
				key: `agent_stopped:${NOW}`,
				context: { event: "agent_stopped", outcome: "aborted", details: "partial answer" },
			},
		]);
	});

	test("a settle that is not an idle boundary is waited out; the boundary settle emits", () => {
		const steps = run([{ type: "agent_end", messages: [assistant("nested")] }, settled(false), settled(true)]);
		assert.deepEqual(steps[1]?.notifications, []);
		assert.equal(steps[2]?.notifications.length, 1);
	});

	test("agent_start clears a recorded loop, and a loop with no assistant message records nothing", () => {
		const cleared = run([{ type: "agent_end", messages: [assistant("x")] }, { type: "agent_start" }, settled(true)]);
		assert.deepEqual(last(cleared).notifications, []);
		const empty = run([{ type: "agent_end", messages: [] }, settled(true)]);
		assert.deepEqual(last(empty).notifications, []);
	});

	test("the final assistant message decides, not an earlier one, and the details omit an empty response", () => {
		const steps = run([
			{ type: "agent_end", messages: [assistant("first", "error", "boom"), assistant("", "stop")] },
			settled(true),
		]);
		assert.deepEqual(last(steps).notifications, [
			{ key: `agent_finished:${NOW}`, context: { event: "agent_finished", outcome: "completed" } },
		]);
	});
});

describe("main-chat questions", () => {
	test("a ui_prompt is agent_needs_input carrying its title, keyed per prompt; ui_prompt_end cancels the open one", () => {
		const steps = run([
			{ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom", title: "Proceed with the migration?" },
			{ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
			{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select" },
		]);
		assert.deepEqual(steps[0]?.notifications, [
			{
				key: "agent_needs_input:1",
				context: { event: "agent_needs_input", outcome: "needs_input", details: "Proceed with the migration?" },
			},
		]);
		assert.deepEqual(steps[1]?.cancels, ["agent_needs_input:1"]);
		assert.deepEqual(steps[2]?.notifications, [
			{ key: "agent_needs_input:2", context: { event: "agent_needs_input", outcome: "needs_input" } },
		]);
	});

	test("the /trust selector is not a question for the user's attention", () => {
		const steps = run([
			{ type: "ui_prompt_start", reason: "project_trust", kind: "select" },
			{ type: "ui_prompt_end", reason: "project_trust", kind: "select" },
		]);
		assert.deepEqual(steps[0]?.notifications, []);
		assert.deepEqual(steps[1]?.cancels, []);
	});
});

describe("workflow lifecycle", () => {
	const runTarget = (
		status: "completed" | "failed" | "blocked" | "paused",
		previousStatus: "running" | "completed" = "running",
	) => ({ kind: "run", runId: "root", previousStatus, status }) as const;

	test("the root run's live transition to completed, failed or blocked is one notification each", () => {
		for (const [status, event, outcome] of [
			["completed", "workflow_completed", "completed"],
			["failed", "workflow_failed", "failed"],
			["blocked", "workflow_blocked", "blocked"],
		] as const) {
			const steps = run([lifecycle(runTarget(status))]);
			assert.deepEqual(last(steps).notifications, [
				{ key: `${event}:root:${NOW}`, context: { event, outcome, runId: "root" } },
			]);
		}
	});

	test("the same event twice, a replayed event, a child run, a non-transition, and a pause all stay silent", () => {
		const completed = lifecycle(runTarget("completed"));
		const twice = run([completed, completed]);
		assert.equal(twice[1]?.notifications.length, 0, "a duplicate key is never produced again");
		assert.deepEqual(last(run([lifecycle(runTarget("completed"), { delivery: "replay" })])).notifications, []);
		assert.deepEqual(
			last(run([lifecycle({ kind: "run", runId: "child", previousStatus: "running", status: "failed" })]))
				.notifications,
			[],
		);
		assert.deepEqual(last(run([lifecycle(runTarget("completed", "completed"))])).notifications, []);
		assert.deepEqual(last(run([lifecycle(runTarget("paused"))])).notifications, []);
		assert.deepEqual(
			last(run([lifecycle({ kind: "stage", runId: "root", stageId: "s", stageName: "s", status: "failed" })]))
				.notifications,
			[],
		);
	});

	test("a prompt opened on any run under the root is workflow_needs_input keyed by prompt; answered or cancelled cancels it", () => {
		const opened = lifecycle(
			{ kind: "prompt", runId: "child", promptId: "p-7", status: "opened" },
			{ runId: "child" },
		);
		const steps = run([
			opened,
			lifecycle({ kind: "prompt", runId: "child", promptId: "p-7", status: "answered" }, { runId: "child" }),
			lifecycle({ kind: "prompt", runId: "child", promptId: "p-8", status: "cancelled" }, { runId: "child" }),
		]);
		assert.deepEqual(steps[0]?.notifications, [
			{
				key: "workflow_needs_input:p-7",
				context: { event: "workflow_needs_input", outcome: "needs_input", runId: "root" },
			},
		]);
		assert.deepEqual(steps[1]?.cancels, ["workflow_needs_input:p-7"]);
		assert.deepEqual(steps[2]?.cancels, ["workflow_needs_input:p-8"]);
		assert.deepEqual(last(run([{ ...opened, delivery: "replay" }])).notifications, []);
	});
});

describe("workflow activity", () => {
	const changed = (over: Partial<WorkflowRootActivity>): WebhookReducerEvent => ({
		type: "workflow_activity_changed",
		cursor: { epoch: "e", revision: 1 },
		root: activity(over),
	});
	const blocked = { state: "blocked", reason: "manual_intervention" } as const;

	test("entering blocked/manual_intervention notifies once; staying there does not; awaiting_input is the prompt channel's job", () => {
		const steps = run([
			changed({}),
			changed(blocked),
			changed(blocked),
			changed({ state: "blocked", reason: "awaiting_input" }),
		]);
		assert.deepEqual(steps[0]?.notifications, []);
		assert.deepEqual(steps[1]?.notifications, [
			{
				key: `workflow_blocked:root:${NOW}`,
				context: { event: "workflow_blocked", outcome: "blocked", runId: "root" },
			},
		]);
		assert.deepEqual(steps[2]?.notifications, []);
		assert.deepEqual(steps[3]?.notifications, []);
	});

	test("a baseline snapshot is remembered, never notified: a root already blocked at seed time stays silent until it leaves and returns", () => {
		const seeded = seedWorkflowActivity(INITIAL_WEBHOOK_REDUCER_STATE, [activity(blocked)]);
		const steps = run([changed(blocked), changed({}), [changed(blocked), { now: NOW + 1 }]], seeded);
		assert.deepEqual(steps[0]?.notifications, []);
		assert.deepEqual(
			steps[2]?.notifications.map((n) => n.key),
			[`workflow_blocked:root:${NOW + 1}`],
		);
	});

	test("a second block of the same root is a second transition, keyed by its own time", () => {
		const steps = run([changed(blocked), changed({}), [changed(blocked), { now: NOW + 5 }]]);
		assert.deepEqual(
			steps.flatMap((s) => s.notifications.map((n) => n.key)),
			[`workflow_blocked:root:${NOW}`, `workflow_blocked:root:${NOW + 5}`],
		);
	});
});

describe("dedupe memory", () => {
	test("remembers at most MAX_WEBHOOK_DEDUPE_KEYS keys, dropping the oldest", () => {
		const events: WebhookReducerEvent[] = [];
		for (let i = 0; i < MAX_WEBHOOK_DEDUPE_KEYS + 5; i += 1) {
			events.push({ type: "ui_prompt_start", reason: "ui_prompt", kind: "input" });
		}
		const final = last(run(events)).state;
		assert.equal(final.delivered.length, MAX_WEBHOOK_DEDUPE_KEYS);
		assert.equal(final.delivered[0], "agent_needs_input:6");
		assert.equal(final.delivered[final.delivered.length - 1], `agent_needs_input:${MAX_WEBHOOK_DEDUPE_KEYS + 5}`);
	});
});
