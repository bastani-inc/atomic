import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { SessionKeyDigests } from "../../packages/coding-agent/src/core/storage/session/key-digests.js";
import { sessionResumeOf } from "../../packages/coding-agent/src/core/storage/session/session-resume.ts";
import { pendingTaskCompletionIntents } from "../../packages/coding-agent/src/core/tasks/completion.ts";
import { unconsumedIntercomInbox } from "../../packages/intercom/durable-inbox.ts";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.ts";
import { OutboundAsks } from "../../packages/intercom/outbound-asks.ts";
import { ReplyTracker, restorePendingInboundAsks } from "../../packages/intercom/reply-tracker.ts";
import { scanInFlightRuns } from "../../packages/workflows/src/shared/persistence-restore.ts";

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
	const keys = new SessionKeyDigests(resume.recovery.admissionDigests);
	for (const key of ["closed", "open", "intercom:message-1"]) assert.ok(keys.has(key));
	assert.equal(keys.has("not-admitted"), false);
	assert.deepEqual(resume.recovery.intercomDeliveredIds, ["message-1"]);
	const delivery = new InboundMessageAdmission();
	delivery.restore(kept, [], keys);
	assert.equal(delivery.admit({ id: "from" } as never, { id: "message-1" } as never).kind, "duplicate");
});

test("admission recovery uses a fixed-size digest per delivery rather than retaining the original key (#5554)", () => {
	const s = session();
	const count = 128;
	for (let i = 0; i < count; i++)
		s.card(`card-${i}`, "already-admitted", {}, { stageAdmissionKey: `private-prefix:${"界".repeat(128)}:${i}` });
	const recovery = s.resume().recovery;
	assert.ok(!JSON.stringify(recovery).includes("private-prefix:"), "raw admission keys were retained on resume");
	assert.equal(Buffer.from(recovery.admissionDigests, "base64").byteLength, count * 16);
});

test("synchronous admission distinguishes the original key from Unicode replacement text after a clear (#5554)", () => {
	const s = session();
	s.card("admitted", "already-admitted", {}, { stageAdmissionKey: "job:\ud800" });
	const keys = new SessionKeyDigests(s.resume().recovery.admissionDigests);
	assert.equal(keys.has("job:\ud800"), true);
	assert.equal(keys.has("job:\ufffd"), false);
});

test("a cleared window does not retain workflow inputs or completed stage outputs to find its open runs (#5554)", () => {
	const s = session();
	for (const runId of ["active", "ended"]) {
		s.custom("workflow.run.start", { runId, name: runId, ts: 1, inputs: { text: "expensive input".repeat(8000) } });
		for (let n = 0; n < 12; n++) {
			s.custom("workflow.stage.start", { runId, stageId: `s${n}` });
			s.custom("workflow.stage.end", { runId, stageId: `s${n}`, output: "expensive output".repeat(8000) });
		}
	}
	s.custom("workflow.run.end", { runId: "ended" });
	const restored = s.resume();
	assert.equal(
		restored.state.some(({ entry }) => entry.type === "custom" && entry.customType.startsWith("workflow.")),
		false,
		"workflow payloads are resident before recovery asks for them",
	);
	assert.deepEqual(Object.values(restored.recovery.workflowStarts ?? {}), [1]);
});

test("an empty reply tag on ordinary Intercom sends does not retain every consumed message after a clear (#5554)", () => {
	const from = { id: "peer", cwd: "/p", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
	for (const hasMatchingAsk of [false, true]) {
		const s = session();
		for (let i = 0; i < 30; i++) {
			const message = { id: `msg-${i}`, timestamp: i, replyTo: "", content: { text: "normal send".repeat(500) } };
			s.custom("intercom_inbox", { from, message, receivedAt: i });
			s.card(`received-${i}`, "intercom_message", { from, message });
		}
		if (hasMatchingAsk)
			s.custom("intercom_ask", {
				askId: "",
				sessionId: "s",
				to: "peer",
				recipientId: "peer",
				question: "historic ask",
				askedAt: 0,
			});
		const kept = s.resume().state.map((x) => x.entry);
		if (!hasMatchingAsk)
			assert.equal(kept.length, 0, "ordinary sends kept all their bodies under an empty reply tag");
		const state = (entries: SessionEntry[]) =>
			new OutboundAsks({ entries: () => entries, sessionId: () => "s", append: async () => {} }).find("")?.state;
		assert.equal(state(kept), state(s.entries));
		assert.equal(state(kept), hasMatchingAsk ? "answered" : undefined);
	}
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

test("resume keeps in-flight workflow runs but drops completed workflow lifecycles (#5249)", () => {
	const s = session();
	for (const runId of ["done", "live"]) {
		s.custom("workflow.run.start", { runId, name: runId, inputs: {}, ts: 1 });
		s.custom("workflow.stage.start", { runId, stageId: `${runId}-stage` });
	}
	s.custom("workflow.run.end", { runId: "done" });
	const resume = s.resume();
	const ids = Object.values(resume.recovery.workflowStarts ?? {}).map(
		(seq) => (s.entries[seq - 1] as { data: { runId: string } }).data.runId,
	);
	assert.deepEqual(
		ids,
		scanInFlightRuns(s.entries as Parameters<typeof scanInFlightRuns>[0]).map((run) => run.runId),
	);
	assert.equal(
		resume.state.some(({ entry }) => entry.type === "custom" && (entry.data as { runId?: string })?.runId === "done"),
		false,
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
