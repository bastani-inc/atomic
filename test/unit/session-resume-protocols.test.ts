import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { sessionResumeOf } from "../../packages/coding-agent/src/core/storage/session/session-resume.ts";
import { pendingTaskCompletionIntents } from "../../packages/coding-agent/src/core/tasks/completion.ts";
import { unconsumedIntercomInbox } from "../../packages/intercom/durable-inbox.ts";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.ts";
import { ReplyTracker, restorePendingInboundAsks } from "../../packages/intercom/reply-tracker.ts";

const timestamp = "2026-11-16T00:00:00.000Z";
function session() {
	const entries: SessionEntry[] = [];
	const custom = (customType: string, data: object) => {
		const entry = {
			type: "custom" as const,
			customType,
			data,
			id: `e${entries.length}`,
			parentId: entries.at(-1)?.id ?? null,
			timestamp,
		};
		entries.push(entry);
		return entry.id;
	};
	const card = (id: string, customType: string, details: object, extra: object = {}) => {
		entries.push({
			type: "custom_message",
			id,
			parentId: entries.at(-1)?.id ?? null,
			timestamp,
			customType,
			content: "card".repeat(500),
			display: true,
			details,
			...extra,
		} as SessionEntry);
	};
	const resume = () => {
		entries.push({
			type: "compaction",
			id: "boundary",
			parentId: entries.at(-1)?.id ?? null,
			timestamp,
			summary: "summary",
			firstKeptEntryId: null,
			tokensBefore: 100,
			details: { strategy: "verbatim-lines" },
		});
		return sessionResumeOf({ id: "s", version: 4, createdAt: timestamp, cwd: "/p" }, entries);
	};
	return { entries, custom, card, resume };
}

test("resume retains open deliveries and removes settled cards while preserving admission keys (#5249)", () => {
	const s = session();
	s.custom("task-completion-intent", { completionId: "closed" });
	s.card("closed-card", "task-completion", {}, { stageAdmissionKey: "closed" });
	s.custom("task-completion-ack", { completionId: "closed" });
	s.custom("task-completion-intent", { completionId: "open" });
	s.card("open-card", "task-completion", {}, { stageAdmissionKey: "open" });
	s.card("closed-protected", "task-heartbeat", {}, { protectedReconciliation: { delivery: "followUp" } });
	s.card("reconciled", "atomic:protected-streaming-reconciliation", { protectedReconciliationOf: "closed-protected" });
	s.card("open-protected", "task-heartbeat", {}, { protectedReconciliation: { delivery: "followUp" } });
	s.card(
		"admitted",
		"intercom_message",
		{ message: { id: "message-1" } },
		{ stageAdmissionKey: "intercom:message-1" },
	);
	const resume = s.resume();
	const kept = resume.state.map((held) => held.entry);
	assert.equal(
		kept.some(
			(entry) =>
				entry.id === "closed-card" ||
				entry.id === "closed-protected" ||
				entry.id === "reconciled" ||
				entry.id === "admitted",
		),
		false,
	);
	assert.equal(
		kept.some((entry) => entry.id === "open-card"),
		true,
	);
	assert.equal(
		kept.some((entry) => entry.id === "open-protected"),
		true,
	);
	assert.deepEqual(
		pendingTaskCompletionIntents({ getEntries: () => kept }),
		pendingTaskCompletionIntents({ getEntries: () => s.entries }),
	);
	assert.deepEqual(resume.recovery.admissionKeys, ["closed", "open", "intercom:message-1"]);
	assert.deepEqual(resume.recovery.intercomDeliveredIds, ["message-1"]);
	const delivery = new InboundMessageAdmission();
	delivery.restore(
		kept,
		resume.recovery.admissionKeys.filter((key) => key.startsWith("intercom:")).map((key) => key.slice(9)),
	);
	assert.equal(delivery.admit({ id: "from" } as never, { id: "message-1" } as never).kind, "duplicate");
});

test("resume keeps child insertion order and merged state without rewriting its entries (#5249)", () => {
	const s = session();
	const first = s.custom("subagent-child", {
		version: 1,
		runId: "run",
		index: 0,
		agent: "worker",
		cwd: "/p",
		childId: "child",
		state: "running",
		task: "original",
		owner: { sessionId: "s" },
	});
	s.custom("subagent-child", {
		version: 1,
		runId: "run",
		index: 0,
		agent: "worker",
		cwd: "/p",
		childId: "child",
		state: "running",
		task: "new",
		owner: { sessionId: "s" },
	});
	const latest = s.custom("subagent-child", {
		version: 1,
		runId: "run",
		index: 0,
		agent: "worker",
		cwd: "/p",
		childId: "child",
		state: "terminal",
		owner: { sessionId: "s" },
	});
	const resume = s.resume();
	const kept = resume.state.map((held) => held.entry);
	const merge = (entries: SessionEntry[]) =>
		Object.assign(
			{},
			...entries
				.filter((entry) => entry.type === "custom" && entry.customType === "subagent-child")
				.map((entry) => (entry.type === "custom" ? entry.data : {})),
		);
	assert.deepEqual(merge(kept), merge(s.entries));
	assert.equal(
		kept.some((e) => e.id === first),
		true,
	);
	assert.equal(
		kept.some((e) => e.id === latest),
		true,
	);
	for (const entry of kept)
		assert.equal(
			entry,
			s.entries.find((e) => e.id === entry.id),
		);
});

test("resume preserves parked tasks whose entry id is an unusual valid string (#5249)", () => {
	const s = session();
	s.custom("workflow-stage-parked-tasks", { attemptId: "attempt", tasks: [{ ownerId: "owner", taskId: "task" }] });
	s.entries[0]!.id = "__proto__";
	const resumed = s.resume();
	assert.equal(
		resumed.state.some((held) => held.entry.id === "__proto__"),
		true,
	);
});

test("resume reduces pooled delivery receipts to their op ids (#5249)", () => {
	const s = session();
	s.custom("atomic-pooled-delivery-op", { op: "first" });
	s.custom("atomic-pooled-delivery-op", { op: 7 });
	s.custom("atomic-pooled-delivery-op", { op: "second" });
	s.custom("atomic-pooled-delivery-op", { op: "first" });
	const resume = s.resume();
	assert.deepEqual(resume.recovery.deliveryOpIds, ["first", "second"]);
	assert.equal(
		resume.state.some(({ entry }) => entry.type === "custom" && entry.customType === "atomic-pooled-delivery-op"),
		false,
	);
});

test("intercom ask and inbox restores return the same result from a tail-resumed session as from a whole read (#5249)", () => {
	const s = session();
	const from = { id: "peer", cwd: "/p", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
	const message = (id: string, extra: object = {}) => ({ id, timestamp: 1, content: { text: id }, ...extra });
	s.custom("intercom_session_identity", { sessionId: "s", intercomSessionId: "intercom-s" });
	s.card("answered-card", "intercom_message", { from, message: message("ask-answered", { expectsReply: true }) });
	s.custom("intercom_sent", { message: message("reply", { replyTo: "ask-answered" }) });
	s.card("open-card", "intercom_message", { from, message: message("ask-open", { expectsReply: true }) });
	s.custom("intercom_inbox", { message: message("inbox-consumed"), from, receivedAt: 4 });
	s.card("consumed-card", "intercom_message", { from, message: message("inbox-consumed") });
	s.custom("intercom_inbox", { message: message("inbox-handled"), from, receivedAt: 5 });
	s.custom("intercom_inbox_handled", { messageId: "inbox-handled" });
	s.custom("intercom_inbox", { message: message("inbox-open"), from, receivedAt: 6 });
	const resume = s.resume();
	const branch = [...resume.state.filter((held) => held.onBranch), ...resume.branch]
		.sort((a, b) => a.seq - b.seq)
		.map((held) => held.entry);
	assert.ok(branch.length < s.entries.length);
	const whole = new ReplyTracker();
	restorePendingInboundAsks(whole, s.entries, "s");
	const resumed = new ReplyTracker();
	restorePendingInboundAsks(resumed, branch, "s");
	assert.deepEqual(
		whole.listPending().map((context) => context.message.id),
		["ask-open"],
	);
	assert.deepEqual(resumed.listPending(), whole.listPending());
	assert.deepEqual(
		unconsumedIntercomInbox(s.entries).map((record) => record.message.id),
		["inbox-open"],
	);
	assert.deepEqual(unconsumedIntercomInbox(branch), unconsumedIntercomInbox(s.entries));
});
