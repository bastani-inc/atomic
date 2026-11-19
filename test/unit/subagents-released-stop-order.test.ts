import assert from "node:assert/strict";
import { test } from "vitest";
import {
	beginReleasedChildStop,
	isReleasedChildStopPending,
	openReleasedChildRelaunch,
	setReleasedChildWakeActive,
	settleReleasedChildRelaunch,
} from "../../packages/subagents/src/runs/foreground/released-child-resume.js";
import { isRelaunchableChildRecord } from "../../packages/subagents/src/runs/foreground/released-children.js";
import { observeSubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	recordSubagentChildStatus,
	recordSubagentChildStop,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

let next = 0;
function child(fields: Partial<SubagentChildRecord>): SubagentChildRecord {
	next += 1;
	const runId = `stop-order-${next}`;
	return {
		version: 1,
		childId: `${runId}:0`,
		runId,
		index: 0,
		agent: "worker",
		state: "terminal",
		cwd: "/repo",
		owner: { kind: "session", sessionId: `stop-order-owner-${next}` },
		...fields,
	};
}

function appended() {
	const records: SubagentChildRecord[] = [];
	const pi = {
		async appendEntry<T>(_type: string, data?: T): Promise<void> {
			records.push(data as SubagentChildRecord);
		},
	};
	return { records, pi };
}

test("a wake may relaunch only a released child or one that ended on its own (#4845)", () => {
	const relaunchable = (fields: Partial<SubagentChildRecord>) => isRelaunchableChildRecord(child(fields));
	assert.equal(relaunchable({ terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS }), true);
	assert.equal(relaunchable({ terminalStatus: "ok" }), true);
	assert.equal(relaunchable({ terminalStatus: "error" }), true);
	for (const stopped of ["paused", "quit"]) assert.equal(relaunchable({ terminalStatus: stopped }), false, stopped);
	for (const ended of ["killed", SUBAGENT_CHILD_GONE_STATUS])
		assert.equal(relaunchable({ terminalStatus: ended }), false, ended);
	assert.equal(relaunchable({ state: "running", terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS }), false);
	assert.equal(isRelaunchableChildRecord(undefined), false);
});

test("a wake key stays stopped until every pause or quit of it in flight has ended (#4845)", () => {
	const key = "subagents/stop-order:pending";
	const pause = beginReleasedChildStop(key);
	const quit = beginReleasedChildStop(key);
	assert.equal(isReleasedChildStopPending(key), true);
	pause.end();
	assert.equal(isReleasedChildStopPending(key), true, "the quit is still in flight");
	quit.end();
	assert.equal(isReleasedChildStopPending(key), false, "a later wake is not suppressed");
});

test("a stop waits for its child's active wake to relaunch it or decide not to, each relaunch in turn (#4845)", async () => {
	const key = "subagents/stop-order:waking";
	const idle = beginReleasedChildStop(key);
	await idle.decided;
	idle.end();

	setReleasedChildWakeActive(key, true);
	let decided = false;
	const first = beginReleasedChildStop(key);
	void first.decided.then(() => {
		decided = true;
	});
	await Promise.resolve();
	assert.equal(decided, false, "it waits while the wake has not decided");
	settleReleasedChildRelaunch(key);
	await first.decided;
	first.end();

	openReleasedChildRelaunch(key);
	let again = false;
	const second = beginReleasedChildStop(key);
	void second.decided.then(() => {
		again = true;
	});
	await Promise.resolve();
	assert.equal(again, false, "a second relaunch in the same wake is waited for too");
	setReleasedChildWakeActive(key, false);
	await second.decided;
	second.end();
	openReleasedChildRelaunch(key);
	const after = beginReleasedChildStop(key);
	await after.decided;
	after.end();
});

test("pause and quit record over the child's latest record, and only a released child or a paused one being quit (#4845)", async () => {
	const held = [
		{ toolCallId: "ci-1", toolName: "wait_for_ci", result: { content: [], details: undefined }, isError: false },
	];
	const cases: Array<[string | undefined, SubagentChildRecord["state"], "paused" | "quit", string | undefined]> = [
		[SUBAGENT_CHILD_RELEASED_STATUS, "terminal", "paused", "paused"],
		[SUBAGENT_CHILD_RELEASED_STATUS, "terminal", "quit", "quit"],
		["paused", "terminal", "quit", "quit"],
		["paused", "terminal", "paused", undefined],
		["ok", "terminal", "paused", undefined],
		["ok", "terminal", "quit", undefined],
		[undefined, "running", "paused", undefined],
	];
	for (const [before, state, status, written] of cases) {
		const snapshot = child({
			state,
			...(before === undefined ? {} : { terminalStatus: before }),
			heldToolResults: [],
		});
		// The latest record holds a result the caller's copy does not.
		observeSubagentChildRecord({ ...snapshot, heldToolResults: held });
		const { pi, records } = appended();
		const latest = await recordSubagentChildStop(pi, snapshot, status);
		const label = `${before ?? state} → ${status}`;
		assert.equal(latest.terminalStatus, written ?? before, label);
		assert.equal(latest.state, state, label);
		assert.deepEqual(latest.heldToolResults, held, label);
		assert.deepEqual(
			records.map((record) => record.terminalStatus),
			written === undefined ? [] : [written],
			label,
		);
	}
});

test("a status write changes only the status of the child's latest record, never writing the caller's copy back (#4845)", async () => {
	const held = [
		{ toolCallId: "ci-1", toolName: "wait_for_ci", result: { content: [], details: undefined }, isError: false },
	];
	const snapshot = child({ terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS, heldToolResults: [] });
	observeSubagentChildRecord({ ...snapshot, heldToolResults: held });
	const { pi, records } = appended();
	await recordSubagentChildStatus(pi, snapshot, "quit");
	assert.equal(records.length, 1);
	assert.equal(records[0]?.terminalStatus, "quit");
	assert.deepEqual(records[0]?.heldToolResults, held);

	const unindexed = child({ state: "running" });
	const fresh = appended();
	await recordSubagentChildStatus(fresh.pi, unindexed, "paused");
	assert.deepEqual(
		[fresh.records[0]?.childId, fresh.records[0]?.state, fresh.records[0]?.terminalStatus],
		[unindexed.childId, "terminal", "paused"],
		"a child the index has no record of is written from the record given",
	);
});
