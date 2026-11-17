import assert from "node:assert/strict";
import { test } from "vitest";
import type { HostSessionPickerRow } from "../src/core/extensions/ui-types.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { resolveResumeTarget, workflowResumeSession } from "../src/modes/interactive/resume-catalog.ts";

const sessionId = "12345678-1111-4111-8111-111111111111";
const runId = "a876b321-2222-4222-8222-222222222222";

function session(id: string, path = `/sessions/${id}.jsonl`): SessionInfo {
	return {
		path,
		id,
		cwd: "/project",
		created: new Date(10),
		modified: new Date(20),
		messageCount: 2,
		firstMessage: "Session objective",
		allMessagesText: "Session objective",
	};
}

function workflow(id = runId): HostSessionPickerRow {
	return {
		path: `workflow-durable:${id}`,
		id,
		cwd: "Durable",
		createdAt: 30,
		modifiedAt: 40,
		messageCount: 3,
		firstMessage: "Run objective",
		title: "shipping · Fix the benchmark",
		detail: "paused · stage 2/3 implement · 1h ago · 4m · $0.20",
	};
}

test("converts workflow catalog rows without losing their two-line presentation (#5256)", () => {
	const row = workflowResumeSession(workflow());
	assert.equal(row.resumeKind, "workflow");
	assert.equal(row.id, runId);
	assert.equal(row.title, "shipping · Fix the benchmark");
	assert.equal(row.detail, "paused · stage 2/3 implement · 1h ago · 4m · $0.20");
	assert.equal(row.created.getTime(), 30);
	assert.equal(row.modified.getTime(), 40);
	assert.equal(row.allMessagesText, "Run objective");
});

test("direct resume resolves session and workflow identifiers from both catalogs (#5256)", () => {
	const chat = session(sessionId);
	const run = workflowResumeSession(workflow());
	for (const id of [sessionId, sessionId.slice(0, 8)]) {
		assert.deepEqual(resolveResumeTarget(id, [chat, run]), { kind: "session", session: chat });
	}
	for (const id of [runId, runId.slice(0, 8), runId.slice(0, 8).toUpperCase()]) {
		assert.deepEqual(resolveResumeTarget(id, [chat, run]), { kind: "workflow", session: run });
	}
});

test("direct resume refuses ambiguity between a session and a workflow (#5256)", () => {
	const chat = session(sessionId);
	const run = workflowResumeSession(workflow("12345678-2222-4222-8222-222222222222"));
	assert.deepEqual(resolveResumeTarget("12345678", [chat, run]), { kind: "ambiguous", matches: [chat, run] });
	assert.deepEqual(resolveResumeTarget(sessionId, [chat, run]), { kind: "session", session: chat });
});

test("direct resume does not accept workflow flags or unsupported truncated run identifiers (#5256)", () => {
	const run = workflowResumeSession(workflow());
	assert.deepEqual(resolveResumeTarget(`${runId} --accept-entry-changes`, [run]), { kind: "invalid" });
	assert.deepEqual(resolveResumeTarget(runId.slice(0, 12), [run]), { kind: "invalid" });
	assert.deepEqual(resolveResumeTarget("ffffffff", [run]), { kind: "not_found" });
});
