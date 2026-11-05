import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { test } from "vitest";
import {
	type RunEventChannel,
	runEventChannel,
	type WorkflowRunEvent,
} from "../../packages/workflows/src/runs/foreground/run-event-channel.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const SESSION_EVENTS = 5000;
const runStart: WorkflowRunEvent = { type: "run_start", run: { id: "run" } as RunSnapshot };
const stageStart: WorkflowRunEvent = { type: "stage_start", runId: "run", stage: { id: "stage" } as StageSnapshot };
const stageEnd: WorkflowRunEvent = { type: "stage_end", runId: "run", stage: { id: "stage" } as StageSnapshot };
const runEnd: WorkflowRunEvent = { type: "run_end", runId: "run", status: "completed" };
const session = (index: number): WorkflowRunEvent => ({
	type: "stage_session_event",
	runId: "run",
	stageId: `stage-${index}`,
	event: { type: "agent_start" } as AgentSessionEvent,
});

function pushRun(channel: RunEventChannel): void {
	channel.push(runStart);
	channel.push(stageStart);
	for (let index = 0; index < SESSION_EVENTS; index++) channel.push(session(index));
	channel.push(stageEnd);
	channel.push(runEnd);
}

async function readAll(iterator: AsyncIterator<WorkflowRunEvent>): Promise<WorkflowRunEvent[]> {
	const read: WorkflowRunEvent[] = [];
	for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) read.push(next.value);
	return read;
}

test("a run nobody reads holds only its lifecycle events, however many session events it emits (#4321)", async () => {
	const channel = runEventChannel();
	pushRun(channel);
	channel.end();
	assert.equal(channel.held(), 4);
	assert.deepEqual(await readAll(channel.events[Symbol.asyncIterator]()), [runStart, stageStart, stageEnd, runEnd]);
	assert.equal(channel.held(), 0);
});

test("an attached reader receives every event in order and nothing stays held once read (#4321)", async () => {
	const channel = runEventChannel();
	channel.push(runStart);
	const iterator = channel.events[Symbol.asyncIterator]();
	assert.deepEqual(await iterator.next(), { done: false, value: runStart });
	pushRun(channel);
	assert.equal(channel.held(), SESSION_EVENTS + 4, "an attached reader is queued every event until it reads them");
	channel.end();
	const read = await readAll(iterator);
	assert.deepEqual(read, [
		runStart,
		stageStart,
		...Array.from({ length: SESSION_EVENTS }, (_, index) => session(index)),
		stageEnd,
		runEnd,
	]);
	assert.equal(channel.held(), 0);
});

test("a reader that stops early detaches, and nothing is held for the events after it (#4321)", async () => {
	const channel = runEventChannel();
	channel.push(runStart);
	const iterator = channel.events[Symbol.asyncIterator]();
	await iterator.next();
	await iterator.return?.();
	pushRun(channel);
	assert.equal(channel.held(), 0);
	const failure = new Error("run failed after its reader left");
	channel.end(failure);
	const again = channel.events[Symbol.asyncIterator]();
	await assert.rejects(again.next(), (error: Error) => error === failure, "only the run's outcome is left to read");
});

test("a run that fails ends its reader with the failure after the events before it (#4321)", async () => {
	const channel = runEventChannel();
	const failure = new Error("run exploded");
	channel.push(runStart);
	channel.end(failure);
	channel.push(runEnd);
	const iterator = channel.events[Symbol.asyncIterator]();
	assert.deepEqual(await iterator.next(), { done: false, value: runStart });
	await assert.rejects(iterator.next(), (error: Error) => error === failure);
});
