import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultWatcher as createRawResultWatcher } from "../../packages/subagents/src/runs/background/result-watcher.js";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.js";

function createResultWatcher(...args: Parameters<typeof createRawResultWatcher>): ReturnType<typeof createRawResultWatcher> {
	const [pi, state, resultsDir, ttl, deps = {}] = args;
	return createRawResultWatcher(pi, state, resultsDir, ttl, { allowedStatusRoots: [path.dirname(resultsDir)], ...deps });
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function createState(sessionId = "session"): SubagentState {
	return {
		baseCwd: "", currentSessionId: sessionId, asyncJobs: new Map(), subagentInProgress: false,
		foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(), cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function tempResults(prefix: string): { root: string; resultsDir: string; asyncDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir);
	fs.mkdirSync(asyncDir);
	return { root, resultsDir, asyncDir };
}

function createManualTimers() {
	type Timer = { callback: () => void; delay: number; cleared: boolean; unref(): void };
	const queue: Timer[] = [];
	const setTimer = ((callback: () => void, delay = 0) => {
		const timer: Timer = { callback, delay, cleared: false, unref() {} };
		queue.push(timer);
		return timer;
	}) as unknown as typeof setTimeout;
	const clearTimer = ((timer: Timer) => { timer.cleared = true; }) as never;
	const runNext = async (delay?: number) => {
		const index = queue.findIndex((timer) => !timer.cleared && (delay === undefined || timer.delay === delay));
		assert.notEqual(index, -1, `expected a pending timer${delay === undefined ? "" : ` at ${delay}ms`}`);
		const [timer] = queue.splice(index, 1);
		timer!.callback();
		for (let i = 0; i < 12; i += 1) await Promise.resolve();
	};
	return {
		timers: { setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setTimer as typeof setInterval, clearInterval: clearTimer },
		runNext,
		pendingDelays: () => queue.filter((timer) => !timer.cleared).map((timer) => timer.delay),
	};
}

test("modern result requires its own nonempty identity to match terminal status", async () => {
	const { resultsDir, asyncDir } = tempResults("atomic-result-identity-");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run-b", state: "complete" }));
	const mismatched = path.join(resultsDir, "mismatched.json");
	const unidentified = path.join(resultsDir, "unidentified.json");
	fs.writeFileSync(mismatched, JSON.stringify({ id: "run-a", sessionId: "session", asyncDir }));
	fs.writeFileSync(unidentified, JSON.stringify({ sessionId: "session", asyncDir }));
	let delivered = 0;
	const manual = createManualTimers();
	const watcher = createResultWatcher({ events: {
		on: () => () => {},
		emit(event) { if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) delivered += 1; },
	} }, createState(), resultsDir, 60_000, { statusRecheckBaseMs: 5, timers: manual.timers });
	watcher.primeExistingResults();
	await manual.runNext(0);
	await manual.runNext(0);
	assert.deepEqual(manual.pendingDelays(), [5, 5]);
	assert.equal(delivered, 0);
	assert.equal(fs.existsSync(mismatched), true);
	assert.equal(fs.existsSync(unidentified), true);
	watcher.stopResultWatcher();
});

test("status rescans preserve exponential backoff and a late terminal status clears it", async () => {
	const { resultsDir, asyncDir } = tempResults("atomic-result-status-backoff-");
	const resultPath = path.join(resultsDir, "result.json");
	const statusPath = path.join(asyncDir, "status.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "late-terminal", sessionId: "session", asyncDir }));
	fs.writeFileSync(statusPath, JSON.stringify({ runId: "late-terminal", state: "running" }));
	let delivered = 0;
	const manual = createManualTimers();
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit(event) {
		if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) delivered += 1;
	} } }, createState(), resultsDir, 60_000, { timers: manual.timers });
	watcher.primeExistingResults();
	await manual.runNext(0);
	assert.deepEqual(manual.pendingDelays(), [250]);
	watcher.primeExistingResults();
	assert.deepEqual(manual.pendingDelays(), [250], "a rescan cannot bypass an active status recheck");
	fs.writeFileSync(statusPath, JSON.stringify({ runId: "late-terminal", state: "complete" }));
	await manual.runNext(250);
	await manual.runNext(0);
	assert.equal(delivered, 1);
	assert.equal(fs.existsSync(resultPath), false);
	assert.deepEqual(manual.pendingDelays(), []);
	watcher.stopResultWatcher();
});

test("status rechecks clear when the result disappears or the watcher stops", async () => {
	const { resultsDir, asyncDir } = tempResults("atomic-result-status-cleanup-");
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "cleanup", sessionId: "session", asyncDir }));
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "cleanup", state: "running" }));
	const manual = createManualTimers();
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, { timers: manual.timers });
	watcher.primeExistingResults();
	await manual.runNext(0);
	fs.unlinkSync(resultPath);
	await manual.runNext(250);
	assert.deepEqual(manual.pendingDelays(), []);
	fs.writeFileSync(resultPath, JSON.stringify({ id: "cleanup", sessionId: "session", asyncDir }));
	watcher.primeExistingResults();
	await manual.runNext(0);
	assert.deepEqual(manual.pendingDelays(), [250]);
	watcher.stopResultWatcher();
	assert.deepEqual(manual.pendingDelays(), []);
});

test("explicit negative local acknowledgement retries while synchronous observation remains compatible", async () => {
	const { resultsDir } = tempResults("atomic-result-local-ack-");
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "local-ack", sessionId: "session" }));
	let attempts = 0;
	const manual = createManualTimers();
	const watcher = createResultWatcher({ events: {
		on: () => () => {},
		emit(event, payload) {
			if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT) return;
			attempts += 1;
			if (attempts === 1) (payload as { acknowledge(delivered: boolean): void }).acknowledge(false);
			// The second observation intentionally does not acknowledge: legacy observers
			// count successful synchronous emission as delivery.
		},
	} }, createState(), resultsDir, 60_000, { deliveryRetryBaseMs: 10, timers: manual.timers });
	watcher.primeExistingResults();
	await manual.runNext(0);
	assert.deepEqual(manual.pendingDelays(), [10]);
	await manual.runNext(10);
	await manual.runNext(0);
	assert.equal(attempts, 2);
	assert.equal(fs.existsSync(resultPath), false);
	watcher.stopResultWatcher();
});

test("queued watcher errors cannot resurrect a stopped watcher", () => {
	const { resultsDir } = tempResults("atomic-result-stop-");
	let starts = 0;
	let queuedError: ((error: Error) => void) | undefined;
	const safeWatch = ((_dir: string, _listener: (event: string, file: string | Buffer | null) => void, onError: (error: Error) => void) => {
		starts += 1;
		queuedError = onError;
		return { close() {}, unref() {} };
	}) as never;
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, { safeWatch });
	watcher.startResultWatcher();
	assert.equal(starts, 1);
	watcher.stopResultWatcher();
	queuedError?.(new Error("queued failure"));
	assert.equal(starts, 1);
});

test("an error queued by a retired native watcher cannot close its replacement", () => {
	const { resultsDir } = tempResults("atomic-result-watcher-replacement-");
	const errors: Array<(error: Error) => void> = [];
	const handles: Array<{ closed: boolean; close(): void; unref(): void }> = [];
	const safeWatch = ((_dir: string, _listener: (event: string, file: string | Buffer | null) => void, onError: (error: Error) => void) => {
		errors.push(onError);
		const handle = { closed: false, close() { this.closed = true; }, unref() {} };
		handles.push(handle);
		return handle;
	}) as never;
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, { safeWatch });
	watcher.startResultWatcher();
	watcher.stopResultWatcher();
	watcher.startResultWatcher();
	assert.equal(handles.length, 2);
	errors[0]?.(new Error("retired watcher failure"));
	assert.equal(handles[1]?.closed, false);
	watcher.stopResultWatcher();
});

test("a retired restart timer cannot replace or disarm the current watcher lifecycle", () => {
	const { resultsDir } = tempResults("atomic-result-restart-owner-");
	const errors: Array<(error: Error) => void> = [];
	const timerCallbacks: Array<() => void> = [];
	let starts = 0;
	const safeWatch = ((_dir: string, _listener: (event: string, file: string | Buffer | null) => void, onError: (error: Error) => void) => {
		starts += 1;
		errors.push(onError);
		return { close() {}, unref() {} };
	}) as never;
	const setTimer = ((callback: () => void) => {
		timerCallbacks.push(callback);
		return { unref() {} };
	}) as never;
	const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, createState(), resultsDir, 60_000, {
		safeWatch,
		timers: { setTimeout: setTimer, clearTimeout: (() => {}) as never, setInterval: setTimer, clearInterval: (() => {}) as never },
	});
	watcher.startResultWatcher();
	errors[0]?.(new Error("first failure"));
	watcher.stopResultWatcher();
	watcher.startResultWatcher();
	errors[1]?.(new Error("replacement failure"));
	assert.equal(starts, 2);
	timerCallbacks[0]?.();
	assert.equal(starts, 2, "a queued timer from the retired lifecycle must be inert");
	watcher.stopResultWatcher();
});

test("prime and rescan activity cannot bypass delivery backoff", async () => {
	const { resultsDir } = tempResults("atomic-result-backoff-gate-");
	fs.writeFileSync(path.join(resultsDir, "result.json"), JSON.stringify({ id: "backoff", sessionId: "session", intercomTarget: "missing" }));
	const listeners = new Map<string, Set<(payload: object) => void>>();
	let attempts = 0;
	const events = {
		on(event: string, listener: (payload: object) => void) {
			const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event !== SUBAGENT_RESULT_INTERCOM_EVENT) return;
			attempts += 1;
			const requestId = (payload as { requestId: string }).requestId;
			for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: false });
		},
	};
	const manual = createManualTimers();
	const watcher = createResultWatcher({ events }, createState(), resultsDir, 60_000, { deliveryRetryBaseMs: 500, timers: manual.timers });
	watcher.primeExistingResults();
	await manual.runNext(0);
	assert.equal(attempts, 1);
	assert.deepEqual(manual.pendingDelays(), [500]);
	for (let i = 0; i < 5; i += 1) watcher.primeExistingResults();
	assert.deepEqual(manual.pendingDelays(), [500], "rescans must not bypass the pending retry");
	await manual.runNext(500);
	assert.equal(attempts, 1);
	await manual.runNext(0);
	assert.equal(attempts, 2);
	watcher.stopResultWatcher();
});

test("permanently partial delivery exhausts and quarantines without replaying the successful phase", async () => {
	const { resultsDir } = tempResults("atomic-result-quarantine-");
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "quarantine", sessionId: "session", intercomTarget: "parent" }));
	const listeners = new Map<string, Set<(payload: object) => void>>();
	let intercomAttempts = 0;
	let localAttempts = 0;
	const events = {
		on(event: string, listener: (payload: object) => void) {
			const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				intercomAttempts += 1;
				const requestId = (payload as { requestId: string }).requestId;
				for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true });
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) {
				localAttempts += 1;
				(payload as { acknowledge(delivered: boolean): void }).acknowledge(false);
			}
		},
	};
	const manual = createManualTimers();
	const watcher = createResultWatcher({ events }, createState(), resultsDir, 60_000, {
		deliveryRetryBaseMs: 5,
		maxNoProgressFailures: 2,
		timers: manual.timers,
	});
	watcher.primeExistingResults();
	await manual.runNext(0);
	await manual.runNext(5);
	await manual.runNext(0);
	await manual.runNext(10);
	await manual.runNext(0);
	assert.equal(intercomAttempts, 1);
	assert.equal(localAttempts, 3);
	assert.equal(fs.existsSync(resultPath), false);
	const quarantined = fs.readdirSync(path.join(resultsDir, ".undelivered"));
	assert.equal(quarantined.length, 1);
	assert.match(quarantined[0]!, /^result-[0-9a-f-]+\.json$/);
	watcher.stopResultWatcher();
});

test("identical result aliases coalesce while completed conflicting aliases are quarantined", async () => {
	const { resultsDir } = tempResults("atomic-result-alias-signatures-");
	const state = createState();
	const manual = createManualTimers();
	let deliveries = 0;
	const events = { on: () => () => {}, emit(event: string) { if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) deliveries += 1; } };
	const identical = { id: "alias-id", runId: "alias-run", sessionId: "session", summary: "same" };
	fs.writeFileSync(path.join(resultsDir, "one.json"), JSON.stringify(identical));
	fs.writeFileSync(path.join(resultsDir, "two.json"), JSON.stringify(identical));
	const watcher = createResultWatcher({ events }, state, resultsDir, 60_000, { timers: manual.timers });
	watcher.primeExistingResults();
	await manual.runNext(0);
	await manual.runNext(0);
	assert.equal(deliveries, 1);
	assert.deepEqual(fs.readdirSync(resultsDir), []);

	fs.writeFileSync(path.join(resultsDir, "summary-conflict.json"), JSON.stringify({ ...identical, summary: "different" }));
	watcher.primeExistingResults();
	await manual.runNext(0);
	fs.writeFileSync(path.join(resultsDir, "result-conflict.json"), JSON.stringify({
		...identical,
		results: [{ agent: "worker", output: "different result", success: true }],
	}));
	watcher.primeExistingResults();
	await manual.runNext(0);
	assert.equal(deliveries, 1);
	const retained = fs.readdirSync(path.join(resultsDir, ".undelivered"));
	assert.equal(retained.length, 2);
	const retainedContents = retained.map((file) => fs.readFileSync(path.join(resultsDir, ".undelivered", file), "utf-8")).join("\n");
	assert.match(retainedContents, /different/);
	assert.match(retainedContents, /different result/);
	watcher.stopResultWatcher();
});

test("in-flight aliases with different targets or payloads never join another watcher claim", async () => {
	const { resultsDir } = tempResults("atomic-result-inflight-signatures-");
	const manual = createManualTimers();
	const listeners = new Map<string, Set<(payload: object) => void>>();
	let requestId = "";
	let sends = 0;
	const events = {
		on(event: string, listener: (payload: object) => void) {
			const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) { sends += 1; requestId = (payload as { requestId: string }).requestId; }
		},
	};
	const original = { id: "inflight-id", runId: "inflight-run", sessionId: "session", summary: "one", intercomTarget: "parent-a" };
	fs.writeFileSync(path.join(resultsDir, "original.json"), JSON.stringify(original));
	const first = createResultWatcher({ events }, createState(), resultsDir, 60_000, { timers: manual.timers, intercomTimeoutMs: 10_000 });
	first.primeExistingResults();
	await manual.runNext(0);
	assert.equal(sends, 1);

	fs.writeFileSync(path.join(resultsDir, "payload-conflict.json"), JSON.stringify({ ...original, summary: "two" }));
	fs.writeFileSync(path.join(resultsDir, "target-conflict.json"), JSON.stringify({ ...original, intercomTarget: "parent-b" }));
	const replacement = createResultWatcher({ events }, createState(), resultsDir, 60_000, { timers: manual.timers });
	replacement.primeExistingResults();
	await manual.runNext(0);
	await manual.runNext(0);
	await manual.runNext(0);
	const retained = fs.readdirSync(path.join(resultsDir, ".undelivered"));
	assert.equal(retained.length, 2);
	assert.equal(sends, 1, "conflicting aliases never enter the active delivery phases");
	for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true });
	for (let index = 0; index < 10; index += 1) await Promise.resolve();
	first.stopResultWatcher();
	replacement.stopResultWatcher();
});
