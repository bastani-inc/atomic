import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultWatcher as createRawResultWatcher } from "../../packages/subagents/src/runs/background/result-watcher.js";
import { listResultClaims } from "../../packages/subagents/src/runs/background/result-file-claims.js";
import { reconcileAsyncRun } from "../../packages/subagents/src/runs/background/stale-run-reconciler.js";
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

function state(sessionId: string): SubagentState {
	return {
		baseCwd: "", currentSessionId: sessionId, asyncJobs: new Map(), subagentInProgress: false,
		foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(), cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function acknowledgeCompletion(payload: object, delivered = true): void {
	(payload as { acknowledge?: (delivered: boolean) => void }).acknowledge?.(delivered);
}

function makeWatcher(resultsDir: string, sessionId: string) {
	const delivered: object[] = [];
	const events = {
		on: () => () => {},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { delivered.push(payload); acknowledgeCompletion(payload); }
		},
	};
	return { watcher: createResultWatcher({ events }, state(sessionId), resultsDir, 60_000), delivered };
}

async function settle(): Promise<void> { await Bun.sleep(80); }

test("stale repair does not commit terminal status until its exact result payload is staged", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stale-repair-retry-"));
	roots.push(root);
	const asyncDir = path.join(root, "async");
	const blockedResults = path.join(root, "results");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(blockedResults, "not a directory");
	fs.mkdirSync(path.join(asyncDir, "events.jsonl"), { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: "stale-retry", sessionId: "session", mode: "single", state: "running", startedAt: 1, lastUpdate: 1, pid: 999999,
		steps: [{ agent: "worker", status: "running" }],
	}));
	assert.throws(() => reconcileAsyncRun(asyncDir, { resultsDir: blockedResults, now: () => 100, kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; } }));
	assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "running");
	fs.rmSync(blockedResults);
	fs.mkdirSync(blockedResults);
	const retried = reconcileAsyncRun(asyncDir, { resultsDir: blockedResults, now: () => 101, kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; } });
	assert.equal(retried.repaired, true);
	assert.equal(fs.existsSync(path.join(blockedResults, "stale-retry.json")), true);
});


test("legacy aliases without id dedupe by canonical runId", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-runid-alias-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	for (const file of ["one.json", "two.json"]) {
		fs.writeFileSync(path.join(resultsDir, file), JSON.stringify({ runId: "canonical-runid-alias", sessionId: "session", success: true }));
	}
	const { watcher, delivered } = makeWatcher(resultsDir, "session");
	watcher.primeExistingResults();
	await settle();
	assert.equal(delivered.length, 1);
	assert.deepEqual(fs.readdirSync(resultsDir), []);
	watcher.stopResultWatcher();
});

test("watcher revalidates session ownership after delayed intercom acknowledgement", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-owner-wait-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "owner-after-wait", sessionId: "session-a", intercomTarget: "parent" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let completions = 0;
	let acknowledgeIntercom: (() => void) | undefined;
	let markIntercomEmitted!: () => void;
	const intercomEmitted = new Promise<void>((resolve) => { markIntercomEmitted = resolve; });
	const runState = state("session-a");
	const events = {
		on(event: string, listener: (data: object) => void) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener); },
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				const requestId = (payload as { requestId: string }).requestId;
				acknowledgeIntercom = () => { for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true }); };
				markIntercomEmitted();
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { completions += 1; acknowledgeCompletion(payload); }
		},
	};
	const watcher = createResultWatcher({ events }, runState, resultsDir, 60_000);
	watcher.primeExistingResults();
	await intercomEmitted;
	runState.currentSessionId = "session-b";
	assert.ok(acknowledgeIntercom);
	acknowledgeIntercom();
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
	assert.equal(completions, 0);
	assert.equal(fs.existsSync(resultPath), false, "ownership is represented by the durable hidden claim");
	const claims = listResultClaims(resultsDir);
	assert.equal(claims.length, 1);
	assert.equal(fs.existsSync(claims[0]!.payloadPath), true);
	assert.equal(runState.completionSeen.size, 0);
	watcher.stopResultWatcher();
});
test("stale repair recovers a failed atomic stage rename without replaying an armed stage", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stale-stage-rename-"));
	roots.push(root);
	const asyncDir = path.join(root, "async");
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: "rename-retry", sessionId: "session", mode: "single", state: "running", startedAt: 1, lastUpdate: 1, pid: 999999,
		steps: [{ agent: "worker", status: "running" }],
	}));
	assert.throws(() => reconcileAsyncRun(asyncDir, {
		resultsDir, now: () => 100,
		kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
		publish: () => { throw new Error("publication interrupted"); },
	}));
	assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "failed");
	assert.deepEqual(fs.readdirSync(resultsDir), [".rename-retry.json.stale-repair-stage"]);
	const recovered = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 101 });
	assert.equal(recovered.repaired, true);
	assert.deepEqual(fs.readdirSync(resultsDir), ["rename-retry.json"]);
	const payload = JSON.parse(fs.readFileSync(path.join(resultsDir, "rename-retry.json"), "utf-8")) as Record<string, unknown>;
	assert.equal(payload.id, "rename-retry");
	assert.equal("result" in payload, false, "stage contains the exact public payload rather than a wrapper");
});
test("failed local completion notification remains retryable until acknowledged", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-listener-claim-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "listener-claim", sessionId: "session" }));
	let attempts = 0;
	const runState = state("session");
	const events = {
		on: () => () => {},
		emit(event: string, payload: object) {
			if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT) return;
			attempts += 1;
			if (attempts === 1) throw new Error("listener failed");
			acknowledgeCompletion(payload);
		},
	};
	const watcher = createResultWatcher({ events }, runState, resultsDir, 60_000, { deliveryRetryBaseMs: 10 });
	watcher.primeExistingResults();
	await Bun.sleep(100);
	assert.equal(attempts, 2);
	assert.equal(fs.existsSync(resultPath), false);
	assert.equal(runState.completionSeen.size, 1);
	watcher.stopResultWatcher();
});

test("acknowledged intercom remains idempotent while local notification retries", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-side-effects-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "async");
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "side-effects", state: "complete" }));
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "side-effects", sessionId: "session", asyncDir, intercomTarget: "parent" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let intercomAttempts = 0;
	let completionAttempts = 0;
	const runState = state("session");
	const events = {
		on(event: string, listener: (data: object) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				intercomAttempts += 1;
				const requestId = (payload as { requestId: string }).requestId;
				for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true });
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) {
				completionAttempts += 1;
				if (completionAttempts === 1) throw new Error("completion listener failed");
				acknowledgeCompletion(payload);
			}
		},
	};
	const firstWatcher = createResultWatcher({ events }, runState, resultsDir, 5, { deliveryRetryBaseMs: 500 });
	firstWatcher.primeExistingResults();
	await Bun.sleep(80);
	assert.equal(intercomAttempts, 1);
	assert.equal(completionAttempts, 1);
	firstWatcher.stopResultWatcher();
	const replacement = createResultWatcher({ events }, state("session"), resultsDir, 5, { deliveryRetryBaseMs: 20 });
	replacement.primeExistingResults();
	await Bun.sleep(100);
	assert.equal(intercomAttempts, 1, "a completed Intercom phase must survive TTL and watcher replacement");
	assert.equal(completionAttempts, 2);
	assert.equal(fs.existsSync(resultPath), false);
	assert.equal(runState.completionSeen.size, 0, "the retired watcher must not finalize the replacement's delivery");
	replacement.stopResultWatcher();
});

test("a delayed successful Intercom phase is checkpointed after watcher retirement", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-retired-phase-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultPath = path.join(resultsDir, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ id: "retired-phase", sessionId: "session", intercomTarget: "parent" }));
	const listeners = new Map<string, Set<(data: object) => void>>();
	let intercomAttempts = 0;
	let localAttempts = 0;
	let acknowledgeIntercom: (() => void) | undefined;
	let markIntercomEmitted!: () => void;
	const intercomEmitted = new Promise<void>((resolve) => { markIntercomEmitted = resolve; });
	let markLocalDelivered!: () => void;
	const localDelivered = new Promise<void>((resolve) => { markLocalDelivered = resolve; });
	const events = {
		on(event: string, listener: (data: object) => void) {
			const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return () => set.delete(listener);
		},
		emit(event: string, payload: object) {
			if (event === SUBAGENT_RESULT_INTERCOM_EVENT) {
				intercomAttempts += 1;
				const requestId = (payload as { requestId: string }).requestId;
				acknowledgeIntercom = () => { for (const listener of listeners.get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT) ?? []) listener({ requestId, delivered: true }); };
				markIntercomEmitted();
			}
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { localAttempts += 1; acknowledgeCompletion(payload); markLocalDelivered(); }
		},
	};
	const first = createResultWatcher({ events }, state("session"), resultsDir, 5, { intercomTimeoutMs: 100 });
	first.primeExistingResults();
	await intercomEmitted;
	first.stopResultWatcher();
	assert.ok(acknowledgeIntercom);
	acknowledgeIntercom();
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
	const replacement = createResultWatcher({ events }, state("session"), resultsDir, 5, { intercomTimeoutMs: 100 });
	replacement.primeExistingResults();
	await localDelivered;
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
	assert.equal(intercomAttempts, 1, "successful remote delivery must not replay after TTL and watcher replacement");
	assert.equal(localAttempts, 1);
	assert.equal(fs.existsSync(resultPath), false);
	assert.equal(listResultClaims(resultsDir).length, 0);
	replacement.stopResultWatcher();
});
