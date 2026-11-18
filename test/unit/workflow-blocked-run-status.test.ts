import { stripVTControlCharacters } from "node:util";
import { describe } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	isDurableWorkflowResumable,
	isWorkflowRunResumable,
} from "../../packages/workflows/src/durable/resume-eligibility.js";
import { isAbsorbingDurableStatus } from "../../packages/workflows/src/durable/workflow-status-transition.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { isWorkflowHeartbeatTerminalRun } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { inspectRun, statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { workflowRunResumeCandidate } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import {
	authDecision,
	cancelledDecision,
	classificationForDecision,
	infrastructureFaultDecision,
	isRecoverableActiveBlocked,
	providerUnavailableDecision,
	rateLimitDecision,
	stageSessionUnavailableDecision,
	strongDecisionFromNormalizedCode,
	terminalProviderConfigDecision,
	unknownDecision,
} from "../../packages/workflows/src/shared/workflow-failures-decisions.js";
import type { WorkflowFailureDecision } from "../../packages/workflows/src/shared/workflow-failures-signals.js";
import {
	WORKFLOW_INFRASTRUCTURE_FAULTS,
	type WorkflowInfrastructureFault,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { isTerminalOrBlockedRun } from "../../packages/workflows/src/tui/run-display-state.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { workflowsListingItems } from "../../packages/workflows/src/tui/workflows-listing.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { defaultTheme, makeStore } from "./overlay-graph-helpers.js";
import { type Counters, counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** The session store's own failure while it is unreachable, as its adapter reports it. */
function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

const definition = workflow({
	name: "reopen-after-wait",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.task("implement", { prompt: "watch ci" });
		return {};
	},
});

/**
 * Runs the workflow until its released stage wakes and cannot reopen its session store: the engine blocks the run
 * resumably on that stage (#4309).
 */
async function blockOnUnreachableSessionStore() {
	const service = new FakeCiService();
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const notices: WorkflowLifecycleNoticeDetails[] = [];
	const stopNotices = installWorkflowLifecycleNotifications({
		store,
		state: createWorkflowLifecycleNotificationState(),
		config: { enabled: true, notifyOn: ["completed", "failed", "blocked", "awaiting_input"] },
		sendMessage(message) {
			const details = (message as { readonly details?: WorkflowLifecycleNoticeDetails }).details;
			if (details !== undefined) notices.push(details);
		},
	});
	const onStageLifecycleEvent = (_runId: string, event: StageLifecycleEvent) => {
		if (event.type === "stage_waiting") service.finishAll();
	};
	const adapters = detachingAdapters(service, counters(), {
		failCreationAfter: 1,
		creationFailure: () => storeUnavailable(),
		resumable: true,
	});
	const blocked = await run(
		definition,
		{},
		{ store, durableBackend: backend, releaseWhenWaiting: { afterMs: 0 }, adapters, onStageLifecycleEvent },
	);
	const source = store.run(blocked.runId);
	assert.ok(source);
	assert.equal(source.status, "running", "the block keeps the run live for a resume");
	assert.ok(source.blockedAt !== undefined);
	/** Adapters for a resume once the store is reachable again: the same session store, sessions that reopen. */
	const reachableAdapters = (resumedCounters: Counters): StageAdapters => ({
		...detachingAdapters(service, resumedCounters, { resumable: true }),
		sessionStore: adapters.sessionStore,
	});
	return {
		store,
		backend,
		service,
		blocked,
		source,
		notices,
		stopNotices,
		reachableAdapters,
		resume: () =>
			run(
				definition,
				{},
				{
					runId: source.id,
					store,
					durableBackend: backend,
					releaseWhenWaiting: { afterMs: 0 },
					continuation: { source, resumeFromStageId: source.failedStageId },
					adapters: reachableAdapters(counters()),
					onStageLifecycleEvent,
				},
			),
	};
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

/** The graph's footer keys for a run, with both run controls available. */
function graphFooter(target: RunSnapshot): string {
	const view = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: target.id,
		store: makeStore({ runs: [target], notices: [], version: 1 }),
		graphTheme: defaultTheme,
		stageActions: {
			pauseRun: async () => ({ ok: true, message: "paused" }),
			resumeRun: async () => ({ ok: true, message: "resumed" }),
		},
	});
	try {
		return plain(view.render(160).join("\n"));
	} finally {
		view.dispose();
	}
}

describe("a run blocked on a stage whose session store stays unreachable reads as blocked everywhere", () => {
	test("its status, indicator, graph, status list, listing, workflow status, panel and notices all say blocked", async () => {
		const { store, source, notices, stopNotices } = await blockOnUnreachableSessionStore();
		try {
			const runId = source.id;
			assert.equal(effectiveRunStatus(source), "blocked");
			assert.equal(runIndicatorStatus(source, store.runs()), "blocked", "the run indicator");
			assert.equal(isTerminalOrBlockedRun(source), true);

			assert.match(
				plain(renderHeader(source, { width: 120, theme: defaultTheme })[1]!),
				/↑ blocked/,
				"graph header",
			);
			const footer = graphFooter(source);
			assert.match(footer, /r resume run/, "the graph offers to resume the run");
			assert.doesNotMatch(footer, /p pause run/, "and not to pause a run that is not working");
			const statusRow = plain(renderStatusList([source], { theme: defaultTheme, width: 100 }))
				.split("\n")
				.find((line) => line.includes(source.name));
			assert.match(statusRow ?? "", /↑ blocked/, "status list");
			const listing = workflowsListingItems([source]).find((item) => item.id === `run:${runId}`);
			assert.match(listing?.description ?? "", /^blocked · /, "/workflows listing");

			assert.equal(statusRuns({ store }).find((entry) => entry.runId === runId)?.status, "blocked", "status");
			const inspected = inspectRun(runId, { store });
			assert.ok(inspected.ok);
			assert.equal(inspected.detail.status, "blocked", "status of one run");

			const item = panelItemsFromSnapshot(store.runs()).find((candidate) => candidate.id === `run:${runId}`);
			assert.equal(item?.state, "paused", "the agent panel and /tasks rest it like a paused run");

			const blockedNotices = notices.filter((notice) => notice.runId === runId && notice.kind === "blocked");
			assert.equal(blockedNotices.length, 1, "one blocked notice");
			assert.equal(blockedNotices[0]?.status, "blocked");
			assert.equal(blockedNotices[0]?.active, true);
			assert.equal(blockedNotices[0]?.stageName, "implement");
			assert.equal(blockedNotices[0]?.createdAt, source.blockedAt);
		} finally {
			stopNotices();
		}
	});

	test("a resume clears the block in its first update, and the resumed run completes", async () => {
		const { store, source, stopNotices, resume } = await blockOnUnreachableSessionStore();
		stopNotices();
		const seen: string[] = [];
		const unsubscribe = store.subscribe(() => {
			const current = store.run(source.id);
			if (current === undefined) return;
			const state = `${effectiveRunStatus(current)}|${runIndicatorStatus(current, store.runs())}`;
			if (seen.at(-1) !== state) seen.push(state);
		});
		try {
			const resumed = await resume();
			assert.equal(resumed.status, "completed", resumed.error);
		} finally {
			unsubscribe();
		}
		assert.ok(seen.length > 0);
		assert.ok(
			seen.every((state) => !state.includes("blocked")),
			`no update of the resumed run reads blocked: ${seen.join(", ")}`,
		);
		assert.equal(seen.at(-1), "completed|completed");
	});
});

describe("a run blocked on a stage whose session store stays unreachable stays resumable", () => {
	test("run() reports it as it reports every recoverable block: still running, with an active_blocked failure", async () => {
		const { blocked } = await blockOnUnreachableSessionStore();
		assert.equal(blocked.status, "running");
		assert.deepEqual(blocked.failure, {
			kind: "unknown",
			code: "session_unavailable",
			retryable: true,
			resumable: true,
			recoverability: "recoverable",
			disposition: "active_blocked",
		});
		const stage = blocked.stages.find((candidate) => candidate.name === "implement") as
			| (StageSnapshot & { readonly failureCode?: string })
			| undefined;
		assert.equal(stage?.failureCode, "session_unavailable");
	});

	test("its journal keeps it as blocked and resumable, never as an ended run, and its live record stays running", async () => {
		const { store, backend, source } = await blockOnUnreachableSessionStore();
		const handle = backend.getWorkflow(source.id);
		assert.ok(handle);
		assert.equal(handle.status, "blocked", "kept durably as blocked, like any recoverable block");
		assert.equal(handle.resumable, true);
		assert.equal(isAbsorbingDurableStatus(handle.status, handle.resumable), false, "not a final status");
		assert.equal(isDurableWorkflowResumable(handle), true);
		assert.ok(backend.listResumableWorkflows().some((entry) => entry.workflowId === source.id));
		assert.equal(isWorkflowRunResumable(workflowRunResumeCandidate(source, store.runs(), backend)), true);
		assert.equal(source.endedAt, undefined);
		assert.equal(isWorkflowHeartbeatTerminalRun(source), false, "its run state is not cleaned up as ended");
	});

	test("resuming it in the same session, as the graph's r does, continues the stage from its saved results", async () => {
		const { store, service, source, reachableAdapters } = await blockOnUnreachableSessionStore();
		const resumedCounters = counters();
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition]),
			store,
			jobs,
			adapters: reachableAdapters(resumedCounters),
		});
		const resumed = await runtime.resumeFailedRun(source.id);
		assert.ok(resumed.ok, resumed.ok ? undefined : resumed.message);
		await jobs.get(resumed.runId)?.promise;
		assert.equal(store.run(resumed.runId)?.status, "completed", store.run(resumed.runId)?.error);
		assert.equal(service.dispatches, 1, "the tool did not run again");
		assert.equal(resumedCounters.continued.get("implement"), 1);
		assert.equal(resumedCounters.userPrompts.get("implement"), undefined);
	});

	test("after a restart, resuming it from its journal continues the stage from its saved results", async () => {
		const { backend, service, source, reachableAdapters } = await blockOnUnreachableSessionStore();
		setDurableBackend(backend);
		try {
			const restarted = createStore();
			const resumedCounters = counters();
			const jobs = createJobTracker();
			const runtime = createExtensionRuntime({
				registry: createRegistry([definition]),
				store: restarted,
				jobs,
				adapters: reachableAdapters(resumedCounters),
			});
			await runtime.prepareDurableResumable(source.id);
			const resumed = await runtime.resumeDurableWorkflow(source.id, { actor: "user" });
			assert.ok(resumed.ok, resumed.ok ? undefined : resumed.message);
			await jobs.get(source.id)?.promise;
			assert.equal(restarted.run(source.id)?.status, "completed", restarted.run(source.id)?.error);
			assert.equal(backend.getWorkflow(source.id)?.status, "completed");
			assert.equal(service.dispatches, 1, "the tool did not run again");
			assert.equal(resumedCounters.continued.get("implement"), 1);
			assert.equal(resumedCounters.userPrompts.get("implement"), undefined);
		} finally {
			setDurableBackend(undefined);
		}
	});
});

describe("a resume pressed as soon as the run reads blocked", () => {
	test("waits for the blocked attempt to finish recording the block, then resumes it", async () => {
		const service = new FakeCiService();
		const store = createStore();
		const memory = await createMemoryTestBackend();
		// The blocked attempt is held just before its journal records the block, as a slow store would hold it.
		const recordBlock = Promise.withResolvers<void>();
		let blockRecordsHeld = 0;
		const backend = new Proxy(memory, {
			get(target, key) {
				const value = Reflect.get(target, key, target) as unknown;
				if (typeof value !== "function") return value;
				if (key !== "commitWorkflowStatus") return value.bind(target);
				return async (...args: Parameters<typeof memory.commitWorkflowStatus>) => {
					if (args[1] === "blocked") {
						blockRecordsHeld++;
						await recordBlock.promise;
					}
					return memory.commitWorkflowStatus(...args);
				};
			},
		});
		const first = detachingAdapters(service, counters(), {
			failCreationAfter: 1,
			creationFailure: () => storeUnavailable(),
			resumable: true,
		});
		const runId = "5534a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
		const jobs = createJobTracker();
		const attempt = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: first,
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type === "stage_waiting") service.finishAll();
				},
			},
		);
		const job = {
			runId,
			controller: new AbortController(),
			promise: attempt.then(
				() => {
					jobs.unregister(runId, job);
				},
				() => {
					jobs.unregister(runId, job);
				},
			),
		};
		jobs.register(job);
		const blocked = Promise.withResolvers<void>();
		const unsubscribe = store.subscribe(() => {
			if (store.run(runId)?.blockedAt !== undefined) blocked.resolve();
		});
		await blocked.promise;
		unsubscribe();
		assert.equal(effectiveRunStatus(store.run(runId)!), "blocked", "the graph already offers r");

		const resumedCounters = counters();
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition]),
			store,
			jobs,
			adapters: {
				...detachingAdapters(service, resumedCounters, { resumable: true }),
				sessionStore: first.sessionStore,
			},
		});
		const resuming = runtime.resumeFailedRun(runId);
		// Let the resume run as far as it can while the attempt still holds the block's record.
		for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(blockRecordsHeld, 1);
		recordBlock.resolve();
		const resumed = await resuming;
		assert.ok(resumed.ok, resumed.ok ? undefined : resumed.message);
		await jobs.get(runId)?.promise;
		assert.equal(store.run(runId)?.status, "completed", store.run(runId)?.error);
		assert.equal(service.dispatches, 1, "the tool did not run again");
	});
});

describe("a child workflow blocked on a stage whose session store stays unreachable", () => {
	test("blocks its parent, and both read as blocked", async () => {
		const service = new FakeCiService();
		const store = createStore();
		const parent = workflow({
			name: "parent-of-reopen",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.workflow(definition);
				return {};
			},
		});
		const blocked = await run(
			parent,
			{},
			{
				store,
				durableBackend: await createMemoryTestBackend(),
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters(), {
					failCreationAfter: 1,
					creationFailure: () => storeUnavailable(),
					resumable: true,
				}),
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type === "stage_waiting") service.finishAll();
				},
			},
		);
		assert.equal(blocked.status, "running", blocked.error);
		assert.equal(blocked.failure?.disposition, "active_blocked");
		const root = store.run(blocked.runId);
		const child = store.runs().find((candidate) => candidate.parentRunId === blocked.runId);
		assert.ok(root && child);
		assert.equal(effectiveRunStatus(root), "blocked", "parent");
		assert.equal(effectiveRunStatus(child), "blocked", "child");
		assert.equal(runIndicatorStatus(root, store.runs()), "blocked");
	});
});

describe("the effective status reads a live run as blocked exactly on the failures the engine blocks it on", () => {
	const decisions: readonly WorkflowFailureDecision[] = [
		authDecision("missing_api_key"),
		authDecision("auth_timeout"),
		authDecision("login_required"),
		authDecision("invalid_api_key"),
		rateLimitDecision("rate_limited"),
		rateLimitDecision("quota_limited"),
		providerUnavailableDecision(),
		terminalProviderConfigDecision("unknown_model"),
		terminalProviderConfigDecision("forbidden_config"),
		cancelledDecision(),
		stageSessionUnavailableDecision(),
		strongDecisionFromNormalizedCode("pending_stage_delivery_failed")!,
		...[...WORKFLOW_INFRASTRUCTURE_FAULTS].map((code) =>
			infrastructureFaultDecision(code as WorkflowInfrastructureFault),
		),
		unknownDecision(),
	];

	test.each(decisions.map((decision) => [`${decision.kind}/${decision.code}`, decision] as const))(
		"%s",
		(_name, decision) => {
			const run: RunSnapshot = {
				id: "r1",
				name: "wf",
				inputs: {},
				status: "running",
				startedAt: 1,
				stages: [],
				toolNodes: [],
				failureKind: decision.kind,
				failureCode: decision.code,
				failureRecoverability: decision.recoverability,
				failureDisposition: decision.disposition,
				error: "it failed",
			};
			const engineBlocks = isRecoverableActiveBlocked(classificationForDecision(decision, "top_level", undefined));
			assert.equal(effectiveRunStatus(run), engineBlocks ? "blocked" : "running");
		},
	);
});
