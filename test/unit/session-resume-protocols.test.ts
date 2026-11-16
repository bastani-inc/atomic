import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { sessionResumeOf } from "../../packages/coding-agent/src/core/storage/session/session-resume.ts";
import { pendingTaskCompletionIntents } from "../../packages/coding-agent/src/core/tasks/completion.ts";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.ts";
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
	assert.deepEqual(resume.recovery.admissionKeys, ["closed", "open", "intercom:message-1"]);
	assert.deepEqual(resume.recovery.intercomDeliveredIds, ["message-1"]);
	const delivery = new InboundMessageAdmission();
	delivery.restore(
		kept,
		resume.recovery.admissionKeys.filter((key) => key.startsWith("intercom:")).map((key) => key.slice(9)),
	);
	assert.equal(delivery.admit({ id: "from" } as never, { id: "message-1" } as never).kind, "duplicate");
});

test("resume keeps only contributors to a child's latest merged record without rewriting its entries (#5249)", () => {
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
		false,
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
	assert.deepEqual(
		scanInFlightRuns(resume.state.map((e) => e.entry) as Parameters<typeof scanInFlightRuns>[0]),
		scanInFlightRuns(s.entries as Parameters<typeof scanInFlightRuns>[0]),
	);
	assert.equal(
		resume.state.some(({ entry }) => entry.type === "custom" && (entry.data as { runId?: string })?.runId === "done"),
		false,
	);
});
