import assert from "node:assert/strict";
import type { DetachedToolResult, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	isReleasedChildError,
	ReleasedChildError,
	type ReleasedChildErrorCode,
} from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	bindSubagentChildHeldToolResults,
	clearSubagentChildHeldToolResults,
	createSubagentChildRecordSink,
	observeChildRecordFailure,
	readSubagentChildRecords,
	recordSubagentChildHeldToolResults,
	recordSubagentChildWakeFailure,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	subagentChildRecordFailures,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { subagentChildrenAwaitingResume } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import { heldAsArrived } from "../helpers/held-tool-results.js";

const RESULT: DetachedToolResult = {
	toolCallId: "ci-1",
	toolName: "wait_for_ci",
	result: { content: [{ type: "text", text: "green" }], details: undefined },
	isError: false,
};

function owner() {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { sessionManager } as unknown as ExtensionContext;
	const failing = { enabled: false };
	const pi = {
		appendEntry: async <T>(type: string, data?: T) => {
			if (failing.enabled) throw new Error("disk full");
			await sessionManager.appendCustomEntry(type, data);
		},
	};
	return { sessionManager, ctx, pi, failing, ownerSessionId: sessionManager.getSessionId() };
}

const launch = { runId: "run", index: 0, agent: "worker", state: "running" as const, cwd: "/repo" };

test("each released-child error carries its class, code, safe fields, hint and retryability, and survives JSON (#4326)", () => {
	const cases: Array<[ReleasedChildErrorCode, ConstructorParameters<typeof ReleasedChildError>[1], boolean, RegExp]> =
		[
			["child-record-missing", { ownerSessionId: "o-1", childId: "run:0" }, false, /session that launched it/],
			["child-unrestorable", { childId: "run:0", reason: "its model is gone" }, false, /"run:0"/],
			[
				"record-append-failed",
				{ childId: "run:0", state: "terminal", terminalStatus: "released" },
				true,
				/session store/,
			],
			["hold-failed", { childName: "subagent-worker-run-1" }, true, /Intercom is connected/],
			["wake-failed", { childId: "run:0", reason: "the store is closed" }, true, /results are kept/],
		];
	for (const [code, fields, retryable, hint] of cases) {
		const cause = new Error("lower level");
		const error = new ReleasedChildError(code, fields, { cause });
		assert.ok(error instanceof ReleasedChildError);
		assert.equal(error.name, "ReleasedChildError");
		assert.deepEqual([error.code, error.retryable, error.fields], [code, retryable, fields]);
		assert.match(error.hint, hint);
		assert.equal(error.cause, cause);
		const wire = JSON.parse(JSON.stringify(error)) as Record<string, string | boolean | object>;
		assert.deepEqual(
			[wire.name, wire.code, wire.retryable, wire.fields, wire.hint],
			["ReleasedChildError", code, retryable, fields, error.hint],
		);
		assert.ok(isReleasedChildError(wire), "a copy that crossed a boundary is still recognized");
	}
	assert.ok(!isReleasedChildError(new Error("no")));
	assert.ok(!isReleasedChildError({ name: "ReleasedChildError", code: "not-a-code" }));
	assert.ok(!isReleasedChildError(undefined));
});

test("a record that cannot be saved is counted as a typed failure, and later records still go in (#4326)", async () => {
	const { sessionManager, ctx, pi, failing } = owner();
	const sink = createSubagentChildRecordSink(pi, ctx);
	const before = subagentChildRecordFailures.count;
	failing.enabled = true;
	sink.record({ ...launch, state: "terminal", terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS });
	await sink.flushed?.();
	failing.enabled = false;
	sink.record({ ...launch, state: "terminal", terminalStatus: "ok" });
	await sink.flushed?.();

	assert.equal(subagentChildRecordFailures.count, before + 1);
	const failure = subagentChildRecordFailures.last;
	assert.ok(failure && isReleasedChildError(failure));
	assert.deepEqual(
		[failure.code, failure.fields.childId, failure.fields.state, failure.fields.terminalStatus],
		["record-append-failed", "run:0", "terminal", SUBAGENT_CHILD_RELEASED_STATUS],
	);
	assert.equal((failure.cause as Error).message, "disk full");
	assert.equal(readSubagentChildRecords(sessionManager.getEntries()).get("run:0")?.terminalStatus, "ok");
});

test("held results are written onto the latest record, never over a newer one (#4326)", async () => {
	const { sessionManager, ctx, pi, ownerSessionId } = owner();
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record(launch);
	await sink.flushed?.();

	const held = recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]);
	sink.record({ ...launch, state: "terminal", terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS });
	await Promise.all([held, sink.flushed?.()]);

	const record = readSubagentChildRecords(sessionManager.getEntries()).get("run:0");
	assert.deepEqual(
		[record?.state, record?.terminalStatus, heldAsArrived(record?.heldToolResults)],
		["terminal", SUBAGENT_CHILD_RELEASED_STATUS, [RESULT]],
		"the later released record's state survived the held-results write",
	);
	const written = sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE);
	assert.equal(written.length, 3);
});

test("holding results for a child with no record, or when the save fails, rejects with a typed error and the owner's order goes on (#4326)", async () => {
	const { pi, failing, ctx, ownerSessionId } = owner();
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record(launch);
	await sink.flushed?.();

	await assert.rejects(recordSubagentChildHeldToolResults(pi, ownerSessionId, "ghost:0", [RESULT]), (error: Error) => {
		assert.ok(isReleasedChildError(error));
		assert.deepEqual([error.code, error.fields], ["child-record-missing", { ownerSessionId, childId: "ghost:0" }]);
		return true;
	});
	failing.enabled = true;
	await assert.rejects(recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]), (error: Error) => {
		assert.ok(isReleasedChildError(error));
		assert.equal(error.code, "record-append-failed");
		assert.equal((error.cause as Error).message, "disk full");
		return true;
	});
	failing.enabled = false;
	const kept = await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]);
	assert.deepEqual(heldAsArrived(kept.heldToolResults), [RESULT]);
});

test("held results are added beside those already held, and only the ids a run took are cleared, in the owner's order (#4326)", async () => {
	const { sessionManager, ctx, pi, ownerSessionId } = owner();
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record(launch);
	await sink.flushed?.();
	const later: DetachedToolResult = { ...RESULT, toolCallId: "deploy-2" };
	const written = () =>
		sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE).length;

	await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]);
	await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT, later]);
	assert.deepEqual(
		heldAsArrived(readSubagentChildRecords(sessionManager.getEntries()).get("run:0")?.heldToolResults),
		[RESULT, later],
	);

	const before = written();
	await clearSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", ["unheld-9"]);
	assert.equal(written(), before, "clearing ids it does not hold writes nothing");
	await clearSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", ["ci-1"]);
	assert.deepEqual(
		heldAsArrived(readSubagentChildRecords(sessionManager.getEntries()).get("run:0")?.heldToolResults),
		[later],
	);
	assert.equal(written(), before + 1);
});

test("a result for a later call a provider gave the same id is held beside an earlier one a wake bound to its call, and outlives that one's release (#3274)", async () => {
	const { sessionManager, ctx, pi, ownerSessionId } = owner();
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record(launch);
	await sink.flushed?.();
	const latest = () => readSubagentChildRecords(sessionManager.getEntries()).get("run:0");
	const later: DetachedToolResult = {
		...RESULT,
		result: { content: [{ type: "text", text: "run 8 passed" }], details: undefined },
	};

	await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]);
	const earlier = latest()?.heldToolResults?.[0]?.heldSeq;
	assert.ok(earlier !== undefined);
	// A wake read the child's transcript back for it and gave it to a run.
	await bindSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", new Map([[earlier, "call-entry-7"]]));
	await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [later]);
	await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [later]);
	assert.deepEqual(heldAsArrived(latest()?.heldToolResults), [RESULT, later], "the later call's result, once");

	// The run that was given the earlier result saved it.
	await clearSubagentChildHeldToolResults(
		pi,
		ownerSessionId,
		"run:0",
		["ci-1"],
		new Map([["ci-1", ["call-entry-7"]]]),
	);
	assert.deepEqual(heldAsArrived(latest()?.heldToolResults), [later]);
});

test("a wake that fails with no reason of its own shows its code and hint once in status (#5551)", async () => {
	const { ctx, pi, failing, ownerSessionId } = owner();
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record({
		...launch,
		state: "terminal",
		terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
		waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }],
	});
	await sink.flushed?.();
	// The wake could not hold the result that woke it: the session store refused the write once.
	failing.enabled = true;
	const failure = await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]).then(
		() => assert.fail("the write was refused"),
		(error: ReleasedChildError) => error,
	);
	failing.enabled = false;
	await recordSubagentChildWakeFailure(pi, ownerSessionId, "run:0", [RESULT], failure);

	const status = subagentChildrenAwaitingResume(ctx).join("\n");
	assert.equal(status.split("(record-append-failed)").length - 1, 1, status);
	assert.equal(status.split(failure.hint).length - 1, 1, status);
});

test("a wake failure that crossed a JSON boundary shows its code and hint once in status, with or without its subject (#5551)", async () => {
	for (const keepSubject of [true, false]) {
		const { ctx, pi, failing, ownerSessionId } = owner();
		const sink = createSubagentChildRecordSink(pi, ctx);
		sink.record({
			...launch,
			state: "terminal",
			terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
			waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }],
		});
		await sink.flushed?.();
		failing.enabled = true;
		const failure = await recordSubagentChildHeldToolResults(pi, ownerSessionId, "run:0", [RESULT]).then(
			() => assert.fail("the write was refused"),
			(error: ReleasedChildError) => error,
		);
		failing.enabled = false;
		// The copy another realm or process sees; an older copy carries no subject of its own.
		const copy = JSON.parse(JSON.stringify(failure)) as Record<string, unknown>;
		if (!keepSubject) delete copy.subject;
		assert.ok(isReleasedChildError(copy));
		await recordSubagentChildWakeFailure(pi, ownerSessionId, "run:0", [RESULT], copy);

		const status = subagentChildrenAwaitingResume(ctx).join("\n");
		assert.equal(status.split("(record-append-failed)").length - 1, 1, status);
		assert.equal(status.split(failure.hint).length - 1, 1, status);
		assert.ok(status.includes(`Its last wake failed: ${failure.message}`), status);
	}
});

test("a failure that knows a subagent only by its Intercom name names it so in status, never as undefined (#5551)", async () => {
	const { ctx, ownerSessionId } = owner();
	observeChildRecordFailure(
		ownerSessionId,
		new ReleasedChildError("wake-failed", {
			childName: "subagent-worker-run-1",
			reason: "its record could not be read",
		}),
	);

	const status = subagentChildrenAwaitingResume(ctx).join("\n");
	assert.equal(
		status,
		`Waking subagent subagent-worker-run-1 failed: its record could not be read (wake-failed). Its results are kept: resume it with { action: "resume", id: "subagent-worker-run-1", message? } to try again.`,
	);
});
