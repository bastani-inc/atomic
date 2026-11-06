import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createSubscriberReports,
	type DeliveredReport,
} from "../../packages/workflows/src/engine/primitives/subscriber-report.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const RUN_ID = "51515151-5151-4515-8515-000000004311";
const REPORT = 'Report from event child "ci#1/e1" (event e1):\n\ne1 matters';

type SessionEvent = { readonly type: string; readonly message?: unknown };

/** A subscriber's retained session, reopened after a resume: it either is in a turn or idle when a report arrives. */
function retainedSession(
	streaming: boolean,
	turn: () => Promise<unknown> = async () => (streaming ? "steer" : "prompt"),
) {
	const listeners = new Set<(event: SessionEvent) => void>();
	const handle = {
		runId: RUN_ID,
		stageId: "watcher-id",
		stageName: "watcher",
		status: "completed",
		sessionId: "watcher-session",
		sessionFile: undefined,
		isStreaming: streaming,
		messages: [],
		ensureAttached: async () => {},
		prompt: async () => {},
		steer: async () => {},
		followUp: async () => {},
		pause: async () => {},
		resume: async () => undefined,
		sendUserMessage: turn,
		subscribe: (listener: (event: SessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		handle: handle as unknown as StageControlHandle,
		listeners,
		emit: (event: SessionEvent) => {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

const replayedWatcher = {
	id: "watcher-id",
	name: "watcher",
	status: "completed",
	replayed: true,
	sessionId: "watcher-session",
	parentIds: [],
	toolEvents: [],
} as unknown as StageSnapshot;

async function deliverTo(handle: StageControlHandle): Promise<DeliveredReport> {
	const registry = createStageControlRegistry();
	registry.register(handle);
	const reports = createSubscriberReports(RUN_ID, { registry }, { cleanupFailed: () => {}, turnFailed: () => {} });
	return await reports.deliver({
		subscriber: { name: "watcher", sendUserMessage: async () => {} },
		live: undefined,
		stage: replayedWatcher,
		subscriptionId: `${RUN_ID}/ci#1`,
		message: REPORT,
	});
}

function watchSettled(promise: Promise<unknown>): () => boolean {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	return () => settled;
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a report queued into a subscriber's running turn counts as saved only when that turn ends (#4311)", async () => {
	const session = retainedSession(true);
	const { saved } = await deliverTo(session.handle);
	const isSaved = watchSettled(saved);
	const notYet: SessionEvent[] = [
		{ type: "message_end", message: { role: "user", content: "a rewritten report" } },
		{ type: "agent_start" },
		{ type: "message_update" },
		{ type: "turn_end" },
	];
	for (const event of notYet) {
		session.emit(event);
		await flush();
		assert.equal(isSaved(), false, JSON.stringify(event));
	}
	assert.equal(session.listeners.size, 1);
	session.emit({ type: "agent_end" });
	await flush();
	assert.equal(isSaved(), true);
	assert.equal(session.listeners.size, 0);
});

test("a report to an idle subscriber counts as saved once the turn it started ends, and stops watching (#4311)", async () => {
	const session = retainedSession(false);
	const { saved } = await deliverTo(session.handle);
	await saved;
	assert.equal(session.listeners.size, 0);
});

test("a report that starts an idle subscriber's turn counts as saved once that turn saved its first user message (#4311)", async () => {
	const session = retainedSession(false, () => new Promise(() => {}));
	const delivery = deliverTo(session.handle);
	await flush();
	session.emit({ type: "message_end", message: { role: "user" } });
	session.emit({ type: "agent_start" });
	const { saved } = await delivery;
	const isSaved = watchSettled(saved);
	for (const event of [
		{ type: "message_end", message: { role: "assistant" } },
		{ type: "message_update", message: { role: "user" } },
	]) {
		session.emit(event);
		await flush();
		assert.equal(isSaved(), false, JSON.stringify(event));
	}
	session.emit({ type: "message_end", message: { role: "user" } });
	await flush();
	assert.equal(isSaved(), true);
	assert.equal(session.listeners.size, 0);
});

test("a report to a subscriber that is not a stage of the run is saved as soon as it is sent (#4311)", async () => {
	const sent: string[] = [];
	const reports = createSubscriberReports(
		RUN_ID,
		{ registry: createStageControlRegistry() },
		{ cleanupFailed: () => {}, turnFailed: () => {} },
	);
	const delivered = await reports.deliver({
		subscriber: {
			name: "plain",
			sendUserMessage: async (text) => {
				sent.push(text);
			},
		},
		live: undefined,
		stage: undefined,
		subscriptionId: `${RUN_ID}/ci#1`,
		message: REPORT,
	});
	assert.ok(delivered.saved instanceof Promise);
	await delivered.saved;
	assert.deepEqual(sent, [REPORT]);
});
