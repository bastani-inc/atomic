import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { runOwnerlessChild } from "../../packages/subagents/src/runs/foreground/ownerless-children.js";
import {
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
	type SubagentChildRecordInput,
	subagentChildTask,
	summarizeSubagentTask,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	awaitSubagentChildRestoration,
	restoreSubagentChildren,
	type SubagentChildRestoreOutcome,
	subagentChildRestoreNotices,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { reopenChildSession } from "../../packages/subagents/src/runs/foreground/subagent-child-session.js";
import { subagentSessionRoot } from "../../packages/subagents/src/shared/session-root.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-lost-children-"));
	previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function isInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== "" && !path.startsWith("..") && !path.startsWith(sep);
}

test("a parent without a session file keeps child sessions under the agent directory, stable per parent session (#4660)", () => {
	const elsewhere = mkdtempSync(join(tmpdir(), "atomic-lost-children-tmp-"));
	try {
		const root = subagentSessionRoot(null, "parent-session-1");

		assert.ok(isInside(agentDir, root), `${root} is not inside ${agentDir}`);
		assert.equal(subagentSessionRoot(null, "parent-session-1"), root);
		assert.notEqual(subagentSessionRoot(null, "parent-session-2"), root);
		assert.ok(!isInside(elsewhere, root));
	} finally {
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("a parent with a session file keeps child sessions beside it (#4660)", () => {
	assert.equal(subagentSessionRoot(join(agentDir, "sessions", "p.jsonl"), "ignored"), join(agentDir, "sessions", "p"));
});

test("a recorded child session file that is gone is reported by path, not as a store loss (#4660)", async () => {
	const missing = join(agentDir, "tmp-wiped", "run-0", "child.jsonl");
	const ctx = { sessionManager: SessionManager.inMemory("/repo") } as Pick<ExtensionContext, "sessionManager">;

	const reopened = await reopenChildSession(ctx, {
		childSessionId: "child-session",
		childSessionFile: missing,
		cwd: "/repo",
	});

	assert.ok("reason" in reopened);
	assert.ok(reopened.reason.includes(missing), reopened.reason);
	assert.ok(!reopened.reason.includes("session store"), reopened.reason);
});

test("a child recorded without a session file is still looked up in the owner's store (#4660)", async () => {
	const ctx = { sessionManager: SessionManager.inMemory("/repo") } as Pick<ExtensionContext, "sessionManager">;

	const reopened = await reopenChildSession(ctx, { childSessionId: "not-in-store", cwd: "/repo" });

	assert.ok("reason" in reopened);
	assert.match(reopened.reason, /session store/);
});

function lostRecord(overrides: Partial<SubagentChildRecord> = {}): SubagentChildRecord {
	return {
		version: 1,
		childId: "run-9:2",
		runId: "run-9",
		index: 2,
		agent: "worker",
		state: "running",
		cwd: "/repo/packages/app",
		owner: { kind: "session", sessionId: "owner" },
		intercomTarget: "impl-auth",
		childSessionId: "child-session-id",
		childSessionFile: "/tmp/atomic-subagent-session-x/run-9/run-2/child.jsonl",
		worktree: {
			repo: "/repo",
			path: "/repo-wt/run-9-2",
			branch: "atomic/run-9-2",
			baseCommit: "abc1234",
			syntheticPaths: [],
		},
		launch: { task: "Implement the\n  auth   refactor", intentTask: "Implement the\n  auth   refactor" },
		...overrides,
	};
}

function unrestorable(record: SubagentChildRecord): SubagentChildRestoreOutcome {
	return {
		kind: "unrestorable",
		childId: record.childId,
		record,
		reason: "its session file is missing",
	};
}

test("an unrestorable child's notice says how to relaunch it and where its work is (#4660)", () => {
	const [notice, ...rest] = subagentChildRestoreNotices([unrestorable(lostRecord())]);

	assert.equal(rest.length, 0);
	assert.ok(notice);
	for (const fact of [
		"worker",
		"impl-auth",
		"Implement the auth refactor",
		"run-9",
		"run-9:2",
		"/repo-wt/run-9-2",
		"atomic/run-9-2",
		"/repo/packages/app",
		"child-session-id",
		"/tmp/atomic-subagent-session-x/run-9/run-2/child.jsonl",
	])
		assert.ok(notice.includes(fact), `notice is missing ${fact}:\n${notice}`);
	assert.match(notice, /subagent\(\{ agent: "worker", task: ".*", cwd: "\/repo-wt\/run-9-2" \}\)/);
	assert.match(notice, /git -C \/repo-wt\/run-9-2 log abc1234\.\.atomic\/run-9-2/);
});

test("a lost child's notice is of one shape per what its record kept of the task (#4660)", () => {
	const noticeOf = (overrides: Partial<SubagentChildRecord>) =>
		subagentChildRestoreNotices([unrestorable(lostRecord({ worktree: undefined, ...overrides }))])[0] ?? "";

	const full = noticeOf({ launch: { task: "line one\nline two" } });
	assert.ok(full.includes('task: "line one\\nline two", cwd:'), full);
	assert.ok(full.includes("task: line one line two;"), full);

	const summary = noticeOf({ launch: undefined, task: "Implement the auth refactor" });
	assert.ok(
		summary.includes('To relaunch it: `subagent({ agent: "worker", task: "Implement the auth refactor"'),
		summary,
	);

	const cutSummary = noticeOf({ launch: undefined, task: `${"w".repeat(299)}…` });
	assert.ok(cutSummary.includes("(cut to 300 characters; the full text is in the launching call)"), cutSummary);
	assert.ok(cutSummary.includes("task: <its task>"), cutSummary);
	assert.ok(!cutSummary.includes('task: "'), cutSummary);

	const tooLong = noticeOf({ launch: { task: `${"word ".repeat(600)}\nsecond line` } });
	assert.ok(!tooLong.includes("second line"));
	assert.ok(tooLong.includes("the full text is in the launching call"), tooLong);
	assert.ok(tooLong.length < 2_500, String(tooLong.length));

	const unknown = noticeOf({ launch: undefined, task: undefined });
	assert.ok(
		unknown.includes("task: not recorded (the `subagent` call that launched run run-9 is in this session's history)"),
		unknown,
	);
	assert.ok(!unknown.includes("subagent({"), unknown);
	assert.ok(unknown.includes('with agent "worker" in "/repo/packages/app"'), unknown);
});

async function recordedFor(task: string, resumeSession?: true): Promise<SubagentChildRecordInput[]> {
	const records: SubagentChildRecordInput[] = [];
	const launch = runOwnerlessChild({
		agent: "worker",
		task,
		cwd: "/repo",
		options: { runId: "task-run", index: 0, ...(resumeSession ? { resumeSession } : {}) } as RunSyncOptions,
		recordChild: { record: (input) => records.push(input) },
		runSync: async () => ({
			agent: "worker",
			task,
			status: "ok",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		}),
	});
	await launch.result;
	return records;
}

test("a launched child's record keeps its task on one line so a lost child can be relaunched (#4660)", async () => {
	const records = await recordedFor("Implement the\n  auth refactor");

	assert.ok(records.length > 0);
	for (const record of records) assert.equal(record.task, "Implement the auth refactor");
});

test("a resumed child's record keeps no task, since its message is not its task (#4660)", async () => {
	const records = await recordedFor("also add tests", true);

	assert.ok(records.length > 0);
	for (const record of records) assert.equal(record.task, undefined);
});

test("the notice for a lost child spells out its facts, relaunch call and where to look (#4660)", () => {
	const record = lostRecord({
		task: "Implement the auth refactor",
		launch: undefined,
		worktree: {
			repo: "/repo",
			path: "/repo wt/run-9-2",
			branch: "atomic/run-9-2",
			baseCommit: "abc1234",
			syntheticPaths: [],
		},
	});
	const [notice] = subagentChildRestoreNotices([unrestorable(record)]);
	assert.equal(
		notice,
		"Background subagent `impl-auth` (worker) did not survive the restart and could not be restored: its session file is missing. It is gone: do not send it Intercom messages or wait for its result. " +
			"Facts: agent worker; task: Implement the auth refactor; run run-9, child run-9:2; cwd /repo/packages/app; worktree /repo wt/run-9-2 (branch atomic/run-9-2); session child-session-id; session file /tmp/atomic-subagent-session-x/run-9/run-2/child.jsonl. " +
			'To relaunch it: `subagent({ agent: "worker", task: "Implement the auth refactor", cwd: "/repo wt/run-9-2" })`. ' +
			"Inspect what it left behind with `git -C '/repo wt/run-9-2' status` and `git -C '/repo wt/run-9-2' log abc1234..atomic/run-9-2`; relaunching in its worktree continues from that work.",
	);
});

test("a lost child without a worktree or saved session is relaunched in its cwd from the task it was asked (#4660)", () => {
	const record = lostRecord({
		launch: { task: "expanded launch text", intentTask: "what was asked" },
		task: "a summary",
		worktree: undefined,
		childSessionId: undefined,
		childSessionFile: undefined,
	});
	const [notice] = subagentChildRestoreNotices([unrestorable(record)]);
	assert.ok(
		notice?.endsWith(
			"Facts: agent worker; task: what was asked; run run-9, child run-9:2; cwd /repo/packages/app. " +
				'To relaunch it: `subagent({ agent: "worker", task: "what was asked", cwd: "/repo/packages/app" })`. ' +
				"Inspect what it left behind in /repo/packages/app.",
		),
		notice,
	);
	const [unknown] = subagentChildRestoreNotices([unrestorable(lostRecord({ launch: undefined }))]);
	assert.match(unknown ?? "", /task: not recorded/);
});

test("a task summary is one trimmed line of at most 300 characters (#4660)", () => {
	assert.equal(summarizeSubagentTask("  fix\n\tthe   bug  "), "fix the bug");
	const exact = "x".repeat(300);
	assert.equal(summarizeSubagentTask(exact), exact);
	const cut = summarizeSubagentTask("y".repeat(301));
	assert.equal(cut, `${"y".repeat(299)}…`);
	assert.deepEqual(subagentChildTask("   ", {} as RunSyncOptions), {});
	assert.deepEqual(subagentChildTask("do it", { resumeSession: true } as RunSyncOptions), {});
	assert.deepEqual(subagentChildTask(" do it ", {} as RunSyncOptions), { task: "do it" });
});

test("a parent session id is made safe for a directory name (#4660)", () => {
	assert.equal(subagentSessionRoot(null, "a/b c:d"), join(agentDir, "subagent-sessions", "a_b_c_d"));
});

test("a message to a child recorded as gone names it and says how to relaunch it (#4660)", async () => {
	const gone = (record: SubagentChildRecord) => ({
		type: "custom" as const,
		customType: SUBAGENT_CHILD_RECORD_TYPE,
		data: { ...record, state: "terminal" as const, terminalStatus: SUBAGENT_CHILD_GONE_STATUS },
		id: record.childId,
		parentId: null,
		timestamp: new Date(0).toISOString(),
	});
	const named = lostRecord({ launch: undefined, task: "Implement the auth refactor" });
	const unnamed = lostRecord({
		childId: "run-9:3",
		index: 3,
		intercomTarget: undefined,
		childSessionId: "unnamed-session",
		launch: undefined,
		task: "Write the docs",
	});
	const entries = [gone(named), gone(unnamed)];

	const byName = await awaitSubagentChildRestoration("owner", entries, "impl-auth", 0);
	assert.ok(
		byName?.startsWith(
			"Subagent `impl-auth` did not survive the restart and is gone. The message was not sent. Facts: agent worker;",
		),
		byName,
	);
	const bySession = await awaitSubagentChildRestoration("owner", entries, "child-session-id", 0);
	assert.ok(bySession?.startsWith("Subagent `impl-auth` did not survive"), bySession);
	const unnamedBySession = await awaitSubagentChildRestoration("owner", entries, " unnamed-session ", 0);
	assert.ok(unnamedBySession?.startsWith("Subagent `unnamed-session` did not survive"), unnamedBySession);
	assert.ok(unnamedBySession?.includes("task: Write the docs"), unnamedBySession);
	assert.equal(await awaitSubagentChildRestoration("owner", entries, "someone-else", 0), undefined);
});

test("a lost child with no record keeps the plain notice (#4660)", () => {
	assert.deepEqual(subagentChildRestoreNotices([{ kind: "unrestorable", childId: "run-1:0", reason: "no record" }]), [
		"Subagent run-1:0 did not survive the restart and could not be restored: no record. It is gone: do not send it Intercom messages or wait for its result. Launch a fresh subagent if its work is still needed.",
	]);
});

test("one child whose restoration throws does not take the others' notices with it (#4660)", async () => {
	const corrupt = join(agentDir, "corrupt-child.jsonl");
	writeFileSync(corrupt, "this is not a session\n");
	const sessionManager = SessionManager.inMemory("/repo");
	const owner = { kind: "session" as const, sessionId: sessionManager.getSessionId() };
	const broken = lostRecord({
		childId: "run-9:0",
		index: 0,
		intercomTarget: "broken-child",
		childSessionFile: corrupt,
		owner,
	});
	const gone = lostRecord({ childId: "run-9:1", index: 1, intercomTarget: "gone-child", owner });
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, broken);
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, gone);

	const outcomes = await restoreSubagentChildren({} as never, { sessionManager, cwd: "/repo" } as never);

	assert.deepEqual(
		outcomes.map((outcome) => [outcome.kind, outcome.kind === "unrestorable" ? outcome.childId : ""]).sort(),
		[
			["unrestorable", "run-9:0"],
			["unrestorable", "run-9:1"],
		],
	);
	for (const outcome of outcomes) {
		assert.ok(
			outcome.kind === "unrestorable" && outcome.record === undefined,
			"not recorded as gone, so a later resume retries it",
		);
	}
	assert.equal(subagentChildRestoreNotices(outcomes).length, 2);
});

test("the inspection commands for a lost child quote a worktree path so the shell reads it literally (#4660)", () => {
	const record = lostRecord({
		worktree: {
			repo: "/repo",
			path: "/work/$team/it's `id` $(whoami)",
			branch: "atomic/run-9-2",
			baseCommit: "abc1234",
			syntheticPaths: [],
		},
	});
	const [notice] = subagentChildRestoreNotices([unrestorable(record)]);
	assert.ok(notice?.includes(`git -C '/work/$team/it'\\''s \`id\` $(whoami)' status`), notice);
});
