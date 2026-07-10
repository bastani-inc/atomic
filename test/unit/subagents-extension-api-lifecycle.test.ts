import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { beginApiLifecycle } from "../../packages/subagents/src/extension/api-lifecycle.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";
import { createResultWatcher } from "../../packages/subagents/src/runs/background/result-watcher.js";
import { buildSlashInitialResult, getSlashRenderableSnapshot } from "../../packages/subagents/src/slash/slash-live-state.js";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../packages/subagents/src/runs/shared/pi-args.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../packages/subagents/src/shared/types.js";

class TestEventBus {
	private readonly handlers = new Map<string, Set<(payload: object) => void>>();

	constructor(private readonly ineffectiveUnsubscribe = false) {}

	on(event: string, handler: (payload: object) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set<(payload: object) => void>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => {
			if (!this.ineffectiveUnsubscribe) handlers.delete(handler);
		};
	}

	emit(event: string, payload: object): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
	}

	count(event: string): number {
		return this.handlers.get(event)?.size ?? 0;
	}

	totalCount(): number {
		return [...this.handlers.values()].reduce((total, handlers) => total + handlers.size, 0);
	}
}

interface TestApi {
	pi: ExtensionAPI;
	events: TestEventBus;
	messages: Array<{ customType?: string; content: string }>;
}

function makeApi(ineffectiveUnsubscribe = false): TestApi {
	const events = new TestEventBus(ineffectiveUnsubscribe);
	const messages: TestApi["messages"] = [];
	const pi = {
		events,
		sendMessage(message: { customType?: string; content: string }) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, events, messages };
}

interface ExtensionHarness extends TestApi {
	shutdownHandlers: Array<() => void>;
}

function makeExtensionHarness(): ExtensionHarness {
	const base = makeApi();
	const shutdownHandlers: Array<() => void> = [];
	Object.assign(base.pi, {
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	});
	return { ...base, shutdownHandlers };
}

function makeState(sessionId: string): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});


test("full extension wiring keeps parent handlers alive across stage shutdown and reload", () => {
	const priorChild = process.env[SUBAGENT_CHILD_ENV];
	const priorFanout = process.env[SUBAGENT_FANOUT_CHILD_ENV];
	delete process.env[SUBAGENT_CHILD_ENV];
	delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
	try {
		const parent = makeExtensionHarness();
		const stage = makeExtensionHarness();
		registerSubagentExtension(parent.pi);
		registerSubagentExtension(stage.pi);
		assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "parent owns tracker and notify handlers");
		assert.equal(stage.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "stage owns independent handlers");
		const parentSlash = buildSlashInitialResult("shared-request", { agent: "worker", task: "parent task" }, parent.pi);
		buildSlashInitialResult("shared-request", { agent: "worker", task: "stage task" }, stage.pi);

		stage.shutdownHandlers[0]?.();
		assert.equal(stage.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 0);
		assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "stage shutdown must preserve parent handlers");
		assert.equal(
			getSlashRenderableSnapshot(parentSlash, parent.pi).result.details.results[0]?.task,
			"parent task",
			"stage shutdown must preserve the parent slash snapshot store",
		);

		registerSubagentExtension(parent.pi);
		assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "same-API reload replaces rather than duplicates handlers");
		parent.shutdownHandlers[0]?.();
		assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "stale shutdown cannot tear down the replacement");
		parent.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "full-extension-result",
			agent: "worker",
			success: true,
			summary: "done",
			timestamp: Date.now(),
		});
		assert.equal(parent.messages.length, 1);
		parent.shutdownHandlers[1]?.();
		assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 0);
	} finally {
		if (priorChild === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = priorChild;
		if (priorFanout === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
		else process.env[SUBAGENT_FANOUT_CHILD_ENV] = priorFanout;
	}
});
describe("subagent ExtensionAPI lifecycle ownership", () => {
	test("concurrent stage shutdown preserves the parent watcher and notification path", async () => {
		const parent = makeApi();
		const stage = makeApi();
		const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-parent-results-"));
		const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stage-results-"));
		tempRoots.push(parentRoot, stageRoot);

		let parentWatchListener: ((event: fs.WatchEventType, file: string | null) => void) | undefined;
		let parentWatcherClosed = false;
		let stageWatcherClosed = false;
		const parentWatcher = createResultWatcher(parent.pi, makeState("parent-session"), parentRoot, 60_000, {
			safeWatch: (_watchPath, listener) => {
				parentWatchListener = listener;
				return { close: () => { parentWatcherClosed = true; }, unref: () => {} } as fs.FSWatcher;
			},
		});
		const stageWatcher = createResultWatcher(stage.pi, makeState("stage-session"), stageRoot, 60_000, {
			safeWatch: () => ({ close: () => { stageWatcherClosed = true; }, unref: () => {} }) as fs.FSWatcher,
		});
		const parentLifecycle = beginApiLifecycle(parent.pi);
		const stageLifecycle = beginApiLifecycle(stage.pi);
		const parentNotifyCleanup = registerSubagentNotify(parent.pi);
		const stageNotifyCleanup = registerSubagentNotify(stage.pi);
		parentWatcher.startResultWatcher();
		stageWatcher.startResultWatcher();
		parentLifecycle.setCleanup(() => { parentWatcher.stopResultWatcher(); parentNotifyCleanup(); });
		stageLifecycle.setCleanup(() => { stageWatcher.stopResultWatcher(); stageNotifyCleanup(); });

		stageLifecycle.dispose();
		assert.equal(stageWatcherClosed, true);
		assert.equal(parentWatcherClosed, false, "stage shutdown must not stop the parent watcher");
		assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 1);

		const resultFile = "parent-result.json";
		fs.writeFileSync(path.join(parentRoot, resultFile), JSON.stringify({
			id: "parent-run-lifecycle",
			sessionId: "parent-session",
			agent: "worker",
			success: true,
			summary: "implemented the fix",
			timestamp: Date.now(),
		}));
		parentWatchListener?.("rename", ".parent-result.json.atomic-write-123.tmp");
		parentWatchListener?.("change", null);
		parentWatchListener?.("rename", ".parent-result.json.atomic-write-123.tmp");
		await Bun.sleep(150);

		assert.equal(parent.messages.length, 1);
		assert.equal(parent.messages[0]?.customType, "subagent-notify");
		assert.equal(fs.existsSync(path.join(parentRoot, resultFile)), false, "consumed result must be removed");
		parentLifecycle.dispose();
	});
	test("stopping a watcher cancels its pending directory rescan", async () => {
		const api = makeApi();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stopped-results-"));
		tempRoots.push(root);
		let listener: ((event: fs.WatchEventType, file: string | null) => void) | undefined;
		const watcher = createResultWatcher(api.pi, makeState("stopped-session"), root, 60_000, {
			safeWatch: (_watchPath, nextListener) => {
				listener = nextListener;
				return { close: () => {}, unref: () => {} } as fs.FSWatcher;
			},
		});
		const notifyCleanup = registerSubagentNotify(api.pi);
		watcher.startResultWatcher();
		const resultPath = path.join(root, "stopped-result.json");
		fs.writeFileSync(resultPath, JSON.stringify({
			id: "stopped-result",
			sessionId: "stopped-session",
			agent: "worker",
			success: true,
			summary: "must remain pending",
			timestamp: Date.now(),
		}));
		listener?.("rename", ".stopped-result.json.atomic-write.tmp");
		watcher.stopResultWatcher();
		await Bun.sleep(100);

		assert.equal(api.messages.length, 0);
		assert.equal(fs.existsSync(resultPath), true, "stopped watcher must not rescan or consume results");
		notifyCleanup();
	});


	test("notification dedupe is reload-stable per API rather than process-global", () => {
		const parent = makeApi();
		const stage = makeApi();
		const parentCleanup = registerSubagentNotify(parent.pi);
		const firstStageCleanup = registerSubagentNotify(stage.pi);
		const result = {
			id: "same-key-across-apis",
			agent: "worker",
			success: true,
			summary: "done",
			timestamp: Date.now(),
		};
		stage.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, result);
		parent.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, result);
		assert.equal(stage.messages.length, 1);
		assert.equal(parent.messages.length, 1, "stage dedupe must not suppress parent notification");

		const secondStageCleanup = registerSubagentNotify(stage.pi);
		stage.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, result);
		assert.equal(stage.messages.length, 1, "same-API reload must retain its dedupe history");
		parentCleanup();
		firstStageCleanup();
		secondStageCleanup();
	});

	test("stale notify registrations stay inert when unsubscribe is ineffective", () => {
		const api = makeApi(true);
		registerSubagentNotify(api.pi);
		const cleanup = registerSubagentNotify(api.pi);
		api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "ineffective-unsubscribe",
			agent: "worker",
			success: true,
			summary: "done",
			timestamp: Date.now(),
		});
		assert.equal(api.messages.length, 1, "only the current registration may notify");
		cleanup();
	});

	test("failed extension registration disposes partial bridge subscriptions", () => {
		const priorChild = process.env[SUBAGENT_CHILD_ENV];
		const priorFanout = process.env[SUBAGENT_FANOUT_CHILD_ENV];
		delete process.env[SUBAGENT_CHILD_ENV];
		delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
		try {
			const api = makeApi();
			Object.assign(api.pi, {
				registerCommand: () => {},
				registerMessageRenderer: () => {},
				registerTool: () => { throw new Error("injected registerTool failure"); },
				on: () => {},
			});
			assert.throws(() => registerSubagentExtension(api.pi), /injected registerTool failure/);
			assert.equal(api.events.totalCount(), 0, "partial bridge subscriptions must not leak");
		} finally {
			if (priorChild === undefined) delete process.env[SUBAGENT_CHILD_ENV];
			else process.env[SUBAGENT_CHILD_ENV] = priorChild;
			if (priorFanout === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
			else process.env[SUBAGENT_FANOUT_CHILD_ENV] = priorFanout;
		}
	});

	test("same-API registration is deduplicated and stale shutdown cannot stop the replacement", () => {
		const api = makeApi();
		let firstCleanups = 0;
		let secondCleanups = 0;
		const firstLifecycle = beginApiLifecycle(api.pi);
		firstLifecycle.setCleanup(() => { firstCleanups++; });
		const firstNotifyCleanup = registerSubagentNotify(api.pi);

		const secondLifecycle = beginApiLifecycle(api.pi);
		secondLifecycle.setCleanup(() => { secondCleanups++; });
		const secondNotifyCleanup = registerSubagentNotify(api.pi);
		assert.equal(firstCleanups, 1, "replacement cleans only the previous same-API runtime");
		assert.equal(api.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 1);

		firstLifecycle.dispose();
		firstNotifyCleanup();
		api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "same-api-result",
			agent: "worker",
			success: true,
			summary: "done",
			timestamp: Date.now(),
		});
		assert.equal(api.messages.length, 1, "re-registration must emit exactly one notification");
		assert.equal(secondCleanups, 0, "stale shutdown must not tear down the replacement runtime");

		secondNotifyCleanup();
		secondLifecycle.dispose();
		assert.equal(secondCleanups, 1);
	});
});
