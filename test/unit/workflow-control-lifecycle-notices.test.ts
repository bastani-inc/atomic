import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	type WorkflowLifecycleNoticeDetails,
	type WorkflowLifecycleNoticeKind,
	type WorkflowLifecycleNotificationState,
	withWorkflowLifecycleNotificationsSuppressed,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { reconcileDurableResumeShadow } from "../../packages/workflows/src/extension/workflow-resume-shadow.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { interruptRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

interface CapturedNotice {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details?: WorkflowLifecycleNoticeDetails;
}

interface CapturedSendOptions {
	readonly triggerTurn?: boolean;
	readonly deliverAs?: string;
	readonly persistWhenStreaming?: boolean;
}

interface ScheduledTimer {
	readonly callback: () => void;
	readonly delay: number;
	active: boolean;
}

type Store = ReturnType<typeof createStore>;

const ALL_KINDS: readonly WorkflowLifecycleNoticeKind[] = [
	"started",
	"completed",
	"failed",
	"blocked",
	"awaiting_input",
	"paused",
	"quit",
	"resumed",
];

function asNotice(message: object): CapturedNotice {
	return message as CapturedNotice;
}

function asSendOptions(options?: object): CapturedSendOptions | undefined {
	return options as CapturedSendOptions | undefined;
}

interface Harness {
	readonly store: Store;
	readonly state: WorkflowLifecycleNotificationState;
	readonly sent: CapturedNotice[];
	readonly sendOptions: (CapturedSendOptions | undefined)[];
	readonly unsubscribe: () => void;
}

function installOn(
	store: Store,
	opts: {
		notifyOn?: readonly WorkflowLifecycleNoticeKind[];
		state?: WorkflowLifecycleNotificationState;
		seedExisting?: boolean;
	} = {},
): Harness {
	const state = opts.state ?? createWorkflowLifecycleNotificationState();
	const sent: CapturedNotice[] = [];
	const sendOptions: (CapturedSendOptions | undefined)[] = [];
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		state,
		config: { enabled: true, notifyOn: opts.notifyOn ?? ALL_KINDS },
		...(opts.seedExisting === undefined ? {} : { seedExisting: opts.seedExisting }),
		sendMessage(message, options) {
			sent.push(asNotice(message));
			sendOptions.push(asSendOptions(options));
		},
	});
	return { store, state, sent, sendOptions, unsubscribe };
}

function startRun(
	store: Store,
	id: string,
	opts: { name?: string; parentRunId?: string; origin?: RunSnapshot["origin"]; startedAt?: number } = {},
): void {
	store.recordRunStart({
		id,
		name: opts.name ?? id,
		inputs: {},
		status: "running",
		stages: [],
		startedAt: opts.startedAt ?? 1,
		...(opts.parentRunId === undefined ? {} : { parentRunId: opts.parentRunId }),
		...(opts.origin === undefined ? {} : { origin: opts.origin }),
	});
}

function addStage(store: Store, runId: string, stageId: string, name: string): void {
	store.recordStageStart(runId, { id: stageId, name, status: "running", parentIds: [], toolEvents: [] });
}

/** Force a store invalidation that changes nothing about the run's control state. */
function invalidate(store: Store, id: string): void {
	store.recordNotice({ id, level: "info", message: "invalidate", createdAt: 1 });
}

function kinds(sent: readonly CapturedNotice[]): (WorkflowLifecycleNoticeKind | undefined)[] {
	return sent.map((notice) => notice.details?.kind);
}

function scopes(sent: readonly CapturedNotice[]): (string | undefined)[] {
	return sent.map((notice) => notice.details?.scope);
}

function stageHandle(input: {
	runId: string;
	stageId: string;
	pause: () => Promise<void>;
	resume: () => Promise<undefined>;
	status: () => StageControlStatus;
}): StageControlHandle {
	return {
		runId: input.runId,
		stageId: input.stageId,
		stageName: input.stageId,
		get status() {
			return input.status();
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		pause: input.pause,
		resume: input.resume,
		subscribe: () => () => {},
	};
}

/**
 * A stage handle that publishes its own state exactly the way the real executor
 * does (`executor-stage-control.ts`): pausing the last active stage records the
 * whole run paused with no attribution, and resuming records both the stage and
 * the run resumed under the internal `stage_control` source.
 */
function executorStyleHandle(input: {
	store: Store;
	runId: string;
	stageId: string;
	failAfterPausing?: boolean;
}): StageControlHandle {
	let status: StageControlStatus = "running";
	return stageHandle({
		runId: input.runId,
		stageId: input.stageId,
		status: () => status,
		pause: async () => {
			status = "paused";
			input.store.recordStagePaused(input.runId, input.stageId);
			const run = input.store.runs().find((candidate) => candidate.id === input.runId);
			const stillActive = run?.stages.some((stage) => stage.status === "running" && stage.id !== input.stageId);
			if (stillActive !== true) input.store.recordRunPaused(input.runId);
			if (input.failAfterPausing === true) throw new Error("stage refused to acknowledge the pause");
		},
		resume: async () => {
			status = "running";
			input.store.recordStageResumed(input.runId, input.stageId);
			input.store.recordRunResumed(input.runId, undefined, { source: "stage_control" });
			return undefined;
		},
	});
}

function installTimerHarness(): {
	readonly delays: () => number[];
	readonly runNext: () => void;
	readonly activeCount: () => number;
	readonly restore: () => void;
} {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const timers: ScheduledTimer[] = [];

	globalThis.setTimeout = ((callback: () => void, delay = 0) => {
		const timer: ScheduledTimer = { callback, delay, active: true };
		timers.push(timer);
		return timer as never;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		(handle as unknown as ScheduledTimer).active = false;
	}) as typeof clearTimeout;

	return {
		delays: () => timers.map((timer) => timer.delay),
		runNext() {
			const timer = timers.find((candidate) => candidate.active);
			assert.ok(timer, "expected an active lifecycle retry timer");
			timer.active = false;
			timer.callback();
		},
		activeCount: () => timers.filter((timer) => timer.active).length,
		restore() {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

/** A live run with one controllable stage, wired to the real control registry. */
function liveRun(
	store: Store,
	registry: ReturnType<typeof createStageControlRegistry>,
	runId: string,
	opts: { name?: string; stageName?: string; origin?: RunSnapshot["origin"] } = {},
): void {
	startRun(store, runId, { name: opts.name ?? "goal", ...(opts.origin === undefined ? {} : { origin: opts.origin }) });
	addStage(store, runId, "stage-1", opts.stageName ?? "review");
	registry.register(executorStyleHandle({ store, runId, stageId: "stage-1" }));
}

afterEach(() => setDurableBackend(undefined));

describe("workflow control lifecycle notices", () => {
	test("a user slash launch emits one started notice; a tool launch emits none", () => {
		const store = createStore();
		const { sent, sendOptions, unsubscribe } = installOn(store);
		try {
			startRun(store, "run-user", { name: "ralph", origin: "user", startedAt: 100 });
			assert.deepEqual(kinds(sent), ["started"]);
			const notice = sent[0];
			assert.ok(notice);
			assert.equal(notice.customType, LIFECYCLE_NOTICE_CUSTOM_TYPE);
			assert.equal(notice.details?.createdAt, 100);
			assert.equal(notice.details?.actor, "user");
			assert.equal(notice.details?.origin, undefined, "started never repeats the origin it already states");
			assert.equal(
				notice.content,
				'▶ The user started workflow "ralph" (run run-user). It is running in the background; you will be notified when it completes.',
			);
			assert.deepEqual(sendOptions, [{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true }]);

			startRun(store, "run-agent", { name: "ralph", origin: "agent" });
			startRun(store, "run-unattributed", { name: "ralph" });
			assert.deepEqual(kinds(sent), ["started"], "a tool launch and an unattributed launch stay silent");
		} finally {
			unsubscribe();
		}
	});

	test("origin renders on completed, failed, and blocked, and is omitted when unrecorded", () => {
		const store = createStore();
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["completed", "failed"] });
		try {
			startRun(store, "run-a", { name: "ralph", origin: "agent" });
			assert.equal(store.recordRunEnd("run-a", "completed", {}), true);
			startRun(store, "run-b", { name: "ralph", origin: "user" });
			assert.equal(store.recordRunEnd("run-b", "failed", {}, "boom"), true);
			startRun(store, "run-c", { name: "ralph" });
			assert.equal(store.recordRunEnd("run-c", "failed", {}, "boom"), true);

			assert.deepEqual(kinds(sent), ["completed", "failed", "failed"]);
			assert.match(sent[0]?.content ?? "", /completed \(run run-a\), which you started\./);
			assert.match(sent[1]?.content ?? "", /failed \(run run-b\), which the user started: boom\./);
			assert.match(sent[2]?.content ?? "", /failed \(run run-c\): boom\./);
			assert.doesNotMatch(sent[2]?.content ?? "", /which/, "an unrecorded origin is omitted, never guessed");
		} finally {
			unsubscribe();
		}
	});

	test("the real pause and quit control paths emit one user-attributed notice each", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		liveRun(store, registry, "run-control", { name: "goal", origin: "agent" });
		backend.registerWorkflow({
			workflowId: "run-control",
			name: "goal",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const { sent, unsubscribe } = installOn(store);
		try {
			assert.equal(
				(await pauseRun("run-control", { store, stageControlRegistry: registry, actor: "user" })).ok,
				true,
			);
			assert.deepEqual(kinds(sent), ["paused"]);
			assert.deepEqual(scopes(sent), ["run"]);
			assert.match(
				sent[0]?.content ?? "",
				/^⏸ The user paused the workflow "goal" \(run run-control\), which you started, at stage review\./,
			);
			assert.match(sent[0]?.content ?? "", /do not resume it or take over the work unless asked/);

			assert.equal(
				(await resumeRun("run-control", { store, stageControlRegistry: registry, actor: "user" })).ok,
				true,
			);
			assert.deepEqual(kinds(sent), ["paused", "resumed"]);
			assert.match(
				sent[1]?.content ?? "",
				/^▶ The user resumed the workflow "goal" \(run run-control\), which you started, at stage review\. It is running again in the background\./,
			);
			assert.doesNotMatch(sent[1]?.content ?? "", /do not resume/);

			assert.equal(
				(await quitRun("run-control", { store, stageControlRegistry: registry, actor: "user" })).ok,
				true,
			);
			assert.deepEqual(
				kinds(sent),
				["paused", "resumed", "quit"],
				"a quit never also reports the pause it publishes",
			);
			assert.equal(sent[2]?.details?.resumable, true);
		} finally {
			unsubscribe();
		}
	});

	test("agent tool control emits nothing while the same store transitions happen", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		liveRun(store, registry, "run-tool", { origin: "agent" });
		backend.registerWorkflow({ workflowId: "run-tool", name: "goal", inputs: {}, createdAt: 1, status: "running" });
		const { sent, unsubscribe } = installOn(store);
		try {
			assert.equal((await pauseRun("run-tool", { store, stageControlRegistry: registry, actor: "agent" })).ok, true);
			assert.equal(
				(await resumeRun("run-tool", { store, stageControlRegistry: registry, actor: "agent" })).ok,
				true,
			);
			assert.equal((await quitRun("run-tool", { store, stageControlRegistry: registry, actor: "agent" })).ok, true);
			assert.deepEqual(sent, [], "the tool result already reports what the agent just did");
		} finally {
			unsubscribe();
		}
	});
	test("interrupting a run emits nothing; interrupt is deliberately out of scope", async () => {
		const store = createStore();
		const registry = createStageControlRegistry();
		liveRun(store, registry, "run-interrupt", { origin: "user" });
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "quit", "resumed"] });
		try {
			assert.equal((await interruptRun("run-interrupt", { store, stageControlRegistry: registry })).ok, true);
			assert.equal(store.runs().find((run) => run.id === "run-interrupt")?.status, "paused");
			assert.deepEqual(sent, [], "an interrupt stops the run but is never reported as a control notice");
		} finally {
			unsubscribe();
		}
	});

	test("an internal control path with no attribution emits nothing", async () => {
		const store = createStore();
		const registry = createStageControlRegistry();
		liveRun(store, registry, "run-internal");
		const { sent, unsubscribe } = installOn(store);
		try {
			assert.equal((await pauseRun("run-internal", { store, stageControlRegistry: registry })).ok, true);
			assert.equal((await resumeRun("run-internal", { store, stageControlRegistry: registry })).ok, true);
			assert.deepEqual(sent, []);
		} finally {
			unsubscribe();
		}
	});

	test("answering a workflow prompt resumes the run without emitting a resumed notice", () => {
		const store = createStore();
		const { sent, unsubscribe } = installOn(store);
		try {
			startRun(store, "run-hil", { name: "goal", origin: "agent" });
			addStage(store, "run-hil", "stage-1", "ask");
			// A prompt pause is internal: the engine pauses the stage and the run.
			assert.equal(store.recordStagePaused("run-hil", "stage-1"), true);
			assert.equal(store.recordRunPaused("run-hil"), true);
			assert.deepEqual(sent, [], "an engine pause is not a control action");

			// executor-prompt-nodes.ts resumes through the prompt_answer source.
			assert.equal(store.recordStageResumed("run-hil", "stage-1"), true);
			store.recordRunResumed("run-hil", undefined, { source: "prompt_answer" });
			assert.deepEqual(sent, [], "answering a HIL prompt must never wake the main chat");

			// Repeating the cycle stays silent no matter how many prompts are answered.
			for (let index = 0; index < 3; index += 1) {
				assert.equal(store.recordStagePaused("run-hil", "stage-1"), true);
				assert.equal(store.recordRunPaused("run-hil"), true);
				assert.equal(store.recordStageResumed("run-hil", "stage-1"), true);
				store.recordRunResumed("run-hil", undefined, { source: "prompt_answer" });
			}
			assert.deepEqual(sent, []);
		} finally {
			unsubscribe();
		}
	});

	test("stage-control, acknowledgement, and metadata-less resumes emit nothing", () => {
		const store = createStore();
		const { sent, unsubscribe } = installOn(store);
		try {
			for (const source of ["stage_control", "acknowledgement", "prompt_answer"] as const) {
				const runId = `run-${source}`;
				startRun(store, runId, { name: "goal", origin: "user" });
				assert.equal(store.recordRunPaused(runId, undefined, { actor: "user" }), true);
				store.recordRunResumed(runId, undefined, { source });
			}
			startRun(store, "run-bare", { name: "goal", origin: "user" });
			assert.equal(store.recordRunPaused("run-bare", undefined, { actor: "user" }), true);
			store.recordRunResumed("run-bare");

			assert.deepEqual(
				kinds(sent),
				["started", "paused", "started", "paused", "started", "paused", "started", "paused"],
				"only the attributed launches and pauses report; no resume does",
			);
		} finally {
			unsubscribe();
		}
	});

	test("a stage-scoped pause and resume that leave siblings paused report at stage scope", async () => {
		const store = createStore();
		const registry = createStageControlRegistry();
		startRun(store, "run-stage-scope", { name: "goal", origin: "user" });
		addStage(store, "run-stage-scope", "stage-1", "review");
		addStage(store, "run-stage-scope", "stage-2", "implement");
		registry.register(executorStyleHandle({ store, runId: "run-stage-scope", stageId: "stage-1" }));
		registry.register(executorStyleHandle({ store, runId: "run-stage-scope", stageId: "stage-2" }));
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "resumed"] });
		try {
			assert.equal(
				(
					await pauseRun("run-stage-scope", {
						store,
						stageControlRegistry: registry,
						stageId: "stage-1",
						actor: "user",
					})
				).ok,
				true,
			);
			assert.deepEqual(kinds(sent), ["paused"]);
			assert.deepEqual(scopes(sent), ["stage"], "stage-2 is still running, so the run did not stop");
			assert.equal(sent[0]?.details?.stageName, "review");
			assert.match(sent[0]?.content ?? "", /The user paused the stage of workflow "goal"/);

			assert.equal(
				(
					await pauseRun("run-stage-scope", {
						store,
						stageControlRegistry: registry,
						stageId: "stage-2",
						actor: "user",
					})
				).ok,
				true,
			);
			assert.deepEqual(kinds(sent), ["paused", "paused"]);
			assert.deepEqual(scopes(sent), ["stage", "run"], "pausing the last active stage stops the run itself");
		} finally {
			unsubscribe();
		}
	});

	test("a resume that returns the whole run to running reports once at run scope", async () => {
		const store = createStore();
		const registry = createStageControlRegistry();
		startRun(store, "run-resume-scope", { name: "goal", origin: "user" });
		addStage(store, "run-resume-scope", "stage-1", "review");
		addStage(store, "run-resume-scope", "stage-2", "implement");
		registry.register(executorStyleHandle({ store, runId: "run-resume-scope", stageId: "stage-1" }));
		registry.register(executorStyleHandle({ store, runId: "run-resume-scope", stageId: "stage-2" }));
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["resumed"] });
		try {
			assert.equal((await pauseRun("run-resume-scope", { store, stageControlRegistry: registry })).ok, true);
			assert.equal(
				(
					await resumeRun("run-resume-scope", {
						store,
						stageControlRegistry: registry,
						stageId: "stage-1",
						actor: "user",
					})
				).ok,
				true,
			);
			assert.deepEqual(kinds(sent), ["resumed"]);
			assert.deepEqual(scopes(sent), ["stage"], "stage-2 is still paused, so this resumed a stage");

			assert.equal(
				(
					await resumeRun("run-resume-scope", {
						store,
						stageControlRegistry: registry,
						stageId: "stage-2",
						actor: "user",
					})
				).ok,
				true,
			);
			assert.deepEqual(kinds(sent), ["resumed", "resumed"]);
			assert.deepEqual(scopes(sent), ["stage", "run"], "the last paused stage returns the whole run to running");
		} finally {
			unsubscribe();
		}
	});

	test("pause, resume, pause, resume emits four notices in order", async () => {
		const store = createStore();
		const registry = createStageControlRegistry();
		liveRun(store, registry, "run-cycle", { origin: "user" });
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "resumed"] });
		const originalNow = Date.now;
		Date.now = () => 100;
		try {
			for (let cycle = 0; cycle < 2; cycle += 1) {
				assert.equal(
					(await pauseRun("run-cycle", { store, stageControlRegistry: registry, actor: "user" })).ok,
					true,
				);
				assert.equal(
					(await resumeRun("run-cycle", { store, stageControlRegistry: registry, actor: "user" })).ok,
					true,
				);
			}
			assert.deepEqual(kinds(sent), ["paused", "resumed", "paused", "resumed"]);
		} finally {
			Date.now = originalNow;
			unsubscribe();
		}
	});

	test("stage pause and resume re-arm at one clock tick", async () => {
		const store = createStore();
		const registry = createStageControlRegistry();
		startRun(store, "run-stage-cycle", { name: "goal", origin: "user" });
		addStage(store, "run-stage-cycle", "stage-1", "review");
		addStage(store, "run-stage-cycle", "stage-2", "implement");
		registry.register(executorStyleHandle({ store, runId: "run-stage-cycle", stageId: "stage-1" }));
		registry.register(executorStyleHandle({ store, runId: "run-stage-cycle", stageId: "stage-2" }));
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "resumed"] });
		const originalNow = Date.now;
		Date.now = () => 100;
		try {
			for (let cycle = 0; cycle < 2; cycle += 1) {
				assert.equal(
					(
						await pauseRun("run-stage-cycle", {
							store,
							stageControlRegistry: registry,
							stageId: "stage-1",
							actor: "user",
						})
					).ok,
					true,
				);
				assert.equal(
					(
						await resumeRun("run-stage-cycle", {
							store,
							stageControlRegistry: registry,
							stageId: "stage-1",
							actor: "user",
						})
					).ok,
					true,
				);
			}
			assert.deepEqual(kinds(sent), ["paused", "resumed", "paused", "resumed"]);
			assert.deepEqual(scopes(sent), ["stage", "stage", "stage", "stage"]);
		} finally {
			Date.now = originalNow;
			unsubscribe();
		}
	});

	test("repeated invalidations at one unchanged control state emit exactly one notice", () => {
		const store = createStore();
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "quit"] });
		try {
			startRun(store, "run-storm", { name: "goal", origin: "user" });
			assert.equal(store.recordRunPaused("run-storm", 100, { actor: "user" }), true);
			for (let index = 0; index < 3; index += 1) invalidate(store, `paused-storm-${index}`);
			assert.deepEqual(kinds(sent), ["paused"]);

			startRun(store, "run-storm-quit", { name: "ralph", origin: "user" });
			assert.equal(
				store.recordRunPaused("run-storm-quit", 400, { exitReason: "quit", resumable: false, actor: "user" }),
				true,
			);
			for (let index = 0; index < 3; index += 1) invalidate(store, `quit-storm-${index}`);
			assert.deepEqual(kinds(sent), ["paused", "quit"]);
		} finally {
			unsubscribe();
		}
	});
	test("a restored quit shadow stays QUIT when a user quits it again", async () => {
		const workflowId = "run-restored-quit-no-timestamp";
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId,
			name: "goal",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			resumable: true,
		});
		const store = createStore();
		store.recordRunStart({
			id: workflowId,
			name: "goal",
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			pausedAt: 100,
			exitReason: "quit",
			resumable: true,
		});
		const restored = store.runs().find((run) => run.id === workflowId);
		assert.ok(restored);
		assert.equal(reconcileDurableResumeShadow(restored, store, { backend }), true);

		const registry = createStageControlRegistry();
		const originalNow = Date.now;
		Date.now = () => 100;
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "quit"] });
		try {
			const result = await quitRun(workflowId, { store, stageControlRegistry: registry, actor: "user" });
			assert.equal(result.ok, true);
			assert.deepEqual(kinds(sent), ["quit"]);
			assert.equal(sent[0]?.details?.createdAt, 101, "quit falls back to pausedAt and re-arms its timestamp");
			invalidate(store, "restored-quit-repeat");
			assert.deepEqual(kinds(sent), ["quit"], "repeated invalidations keep one restored quit notice");
		} finally {
			Date.now = originalNow;
			unsubscribe();
		}
	});

	test("exitReason quit selects QUIT when quitAt is absent", () => {
		const store = createStore();
		startRun(store, "run-quit-without-quit-at", { name: "goal", origin: "user" });
		const run = store.runs().find((candidate) => candidate.id === "run-quit-without-quit-at");
		assert.ok(run);
		run.status = "paused";
		run.pausedAt = 200;
		run.exitReason = "quit";
		run.pauseActor = "user";
		const { sent, unsubscribe } = installOn(store, { seedExisting: false, notifyOn: ["paused", "quit"] });
		try {
			invalidate(store, "quit-without-quit-at");
			assert.deepEqual(kinds(sent), ["quit"]);
			assert.equal(sent[0]?.details?.createdAt, 200);
		} finally {
			unsubscribe();
		}
	});

	test("a run already started, paused, or quit when notifications install emits nothing", () => {
		const store = createStore();
		startRun(store, "run-restored", { name: "goal", origin: "user" });
		assert.equal(store.recordRunPaused("run-restored", 100, { actor: "user" }), true);
		startRun(store, "run-restored-quit", { name: "ralph", origin: "user" });
		assert.equal(
			store.recordRunPaused("run-restored-quit", 150, { exitReason: "quit", resumable: true, actor: "user" }),
			true,
		);
		startRun(store, "run-restored-live", { name: "ralph", origin: "user" });

		const { sent, unsubscribe } = installOn(store);
		try {
			assert.deepEqual(sent, []);
			invalidate(store, "post-install");
			assert.deepEqual(sent, [], "seeded control states stay silent across later invalidations");
		} finally {
			unsubscribe();
		}
	});

	test("replayed control actions under suppression seed dedupe state without notifying", () => {
		const store = createStore();
		const { state, sent, unsubscribe } = installOn(store, { seedExisting: false });
		try {
			withWorkflowLifecycleNotificationsSuppressed(state, () => {
				startRun(store, "run-replayed", { name: "goal", origin: "user" });
				assert.equal(store.recordRunPaused("run-replayed", 100, { actor: "user" }), true);
				startRun(store, "run-replayed-quit", { name: "ralph", origin: "user" });
				assert.equal(store.recordRunPaused("run-replayed-quit", 120, { exitReason: "quit", actor: "user" }), true);
			});
			assert.deepEqual(sent, []);
			invalidate(store, "post-replay");
			assert.deepEqual(sent, [], "a suppressed replay must not re-announce after suppression lifts");
		} finally {
			unsubscribe();
		}
	});

	test("notifyOn without the control kinds suppresses all of them", () => {
		const store = createStore();
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["failed"] });
		try {
			startRun(store, "run-filtered", { name: "goal", origin: "user" });
			assert.equal(store.recordRunPaused("run-filtered", 100, { actor: "user" }), true);
			store.recordRunResumed("run-filtered", 150, { source: "run_control", actor: "user" });
			assert.equal(
				store.recordRunPaused("run-filtered", 200, { exitReason: "quit", resumable: true, actor: "user" }),
				true,
			);
			assert.deepEqual(sent, []);

			store.recordRunResumed("run-filtered", 250, { source: "run_control", actor: "user" });
			assert.equal(store.recordRunEnd("run-filtered", "failed", {}, "boom"), true);
			assert.deepEqual(kinds(sent), ["failed"], "unrelated kinds keep their existing behavior");
		} finally {
			unsubscribe();
		}
	});

	test("a nested child run emits no top-level notice for any control action", () => {
		const store = createStore();
		const { sent, unsubscribe } = installOn(store);
		try {
			startRun(store, "run-parent", { name: "goal", origin: "agent" });
			startRun(store, "run-child", { name: "child", parentRunId: "run-parent", origin: "user" });
			assert.equal(store.recordRunPaused("run-child", 100, { actor: "user" }), true);
			store.recordRunResumed("run-child", 150, { source: "run_control", actor: "user" });
			assert.equal(
				store.recordRunPaused("run-child", 200, { exitReason: "quit", resumable: true, actor: "user" }),
				true,
			);
			assert.deepEqual(sent, []);
		} finally {
			unsubscribe();
		}
	});

	test("a rejected control notice retries with capped backoff and survives reinstall exactly once", async () => {
		const timers = installTimerHarness();
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const rejected: CapturedNotice[] = [];
		const replacement: CapturedNotice[] = [];
		let firstUnsubscribe: (() => void) | undefined;
		let replacementUnsubscribe: (() => void) | undefined;
		try {
			firstUnsubscribe = installWorkflowLifecycleNotifications({
				store,
				state,
				seedExisting: false,
				config: { enabled: true, notifyOn: ["paused"] },
				sendMessage(message) {
					rejected.push(asNotice(message));
					return Promise.reject(new Error("paused admission rejected"));
				},
			});
			startRun(store, "run-retry", { name: "goal", origin: "user" });
			assert.equal(store.recordRunPaused("run-retry", 100, { actor: "user" }), true);
			await flushMicrotasks();

			assert.equal(rejected.length, 1);
			assert.equal(rejected[0]?.details?.kind, "paused");
			const originalDetails = rejected[0]?.details;
			assert.ok(originalDetails);

			for (const expectedDelay of [20, 40, 80]) {
				assert.equal(timers.delays().at(-1), expectedDelay);
				timers.runNext();
				await flushMicrotasks();
			}
			assert.deepEqual(timers.delays(), [20, 40, 80, 160]);
			assert.equal(rejected.length, 4);
			assert.equal(state.deliveredTerminalRuns.size, 0);
			assert.equal(state.retryableTerminalNotices.size, 1);

			assert.equal(store.removeRun("run-retry"), true);
			firstUnsubscribe();
			firstUnsubscribe = undefined;
			assert.equal(timers.activeCount(), 0);

			replacementUnsubscribe = installWorkflowLifecycleNotifications({
				store,
				state,
				config: { enabled: true, notifyOn: ["paused"] },
				sendMessage(message) {
					replacement.push(asNotice(message));
				},
			});

			assert.equal(replacement.length, 1);
			assert.equal(replacement[0]?.details, originalDetails);
			assert.equal(state.retryableTerminalNotices.size, 0);
			assert.equal(state.deliveredTerminalRuns.size, 1);

			invalidate(store, "post-reinstall");
			assert.equal(replacement.length, 1, "the recovered notice is delivered exactly once");
		} finally {
			replacementUnsubscribe?.();
			firstUnsubscribe?.();
			timers.restore();
		}
	});

	test("a rejected quit notice retries and survives reinstall exactly once", async () => {
		const timers = installTimerHarness();
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const rejected: CapturedNotice[] = [];
		const replacement: CapturedNotice[] = [];
		let firstUnsubscribe: (() => void) | undefined;
		let replacementUnsubscribe: (() => void) | undefined;
		try {
			firstUnsubscribe = installWorkflowLifecycleNotifications({
				store,
				state,
				seedExisting: false,
				config: { enabled: true, notifyOn: ["quit"] },
				sendMessage(message) {
					rejected.push(asNotice(message));
					return Promise.reject(new Error("quit admission rejected"));
				},
			});
			startRun(store, "run-retry-quit", { name: "goal", origin: "user" });
			assert.equal(
				store.recordRunPaused("run-retry-quit", 100, {
					exitReason: "quit",
					resumable: true,
					actor: "user",
				}),
				true,
			);
			await flushMicrotasks();

			assert.equal(rejected.length, 1);
			assert.equal(rejected[0]?.details?.kind, "quit");
			assert.equal(rejected[0]?.details?.resumable, true);
			const originalDetails = rejected[0]?.details;
			assert.ok(originalDetails);

			for (const expectedDelay of [20, 40, 80]) {
				assert.equal(timers.delays().at(-1), expectedDelay);
				timers.runNext();
				await flushMicrotasks();
			}
			assert.deepEqual(timers.delays(), [20, 40, 80, 160]);
			assert.equal(rejected.length, 4);
			assert.equal(state.deliveredTerminalRuns.size, 0);
			assert.equal(state.retryableTerminalNotices.size, 1);

			assert.equal(store.removeRun("run-retry-quit"), true);
			firstUnsubscribe();
			firstUnsubscribe = undefined;
			assert.equal(timers.activeCount(), 0);

			replacementUnsubscribe = installWorkflowLifecycleNotifications({
				store,
				state,
				config: { enabled: true, notifyOn: ["quit"] },
				sendMessage(message) {
					replacement.push(asNotice(message));
				},
			});

			assert.equal(replacement.length, 1);
			assert.equal(replacement[0]?.details, originalDetails);
			assert.equal(state.retryableTerminalNotices.size, 0);
			assert.equal(state.deliveredTerminalRuns.size, 1);

			invalidate(store, "post-quit-reinstall");
			assert.equal(replacement.length, 1, "the recovered quit notice is delivered exactly once");
		} finally {
			replacementUnsubscribe?.();
			firstUnsubscribe?.();
			timers.restore();
		}
	});

	test("a quit that never publishes leaves the run paused and reports nothing", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		startRun(store, "run-quit-failed", { name: "ralph", origin: "user" });
		addStage(store, "run-quit-failed", "stage-1", "implement");
		registry.register(
			executorStyleHandle({ store, runId: "run-quit-failed", stageId: "stage-1", failAfterPausing: true }),
		);
		backend.registerWorkflow({
			workflowId: "run-quit-failed",
			name: "ralph",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const { sent, unsubscribe } = installOn(store, { notifyOn: ["paused", "quit"] });
		try {
			await assert.rejects(
				quitRun("run-quit-failed", { store, stageControlRegistry: registry, actor: "user" }),
				/Failed to pause workflow stages/,
			);
			assert.deepEqual(
				sent,
				[],
				"the quit never published, so nothing was attributed and nothing is reported to the chat",
			);
			assert.equal(store.runs().find((run) => run.id === "run-quit-failed")?.status, "paused");
		} finally {
			unsubscribe();
		}
	});
});
