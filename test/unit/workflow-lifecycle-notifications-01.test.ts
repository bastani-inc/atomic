// @ts-nocheck

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	clearWorkflowLifecycleBridgeEvents,
	getWorkflowLifecycleBridgeLineages,
	getWorkflowLifecycleBridgeSnapshot,
	getWorkflowLifecycleBridgeTerminalLineages,
	rememberWorkflowLifecycleBridgeEvent,
	rememberWorkflowLifecycleBridgeLineage,
} from "../../packages/coding-agent/src/core/workflow-lifecycle-events.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	LIFECYCLE_NOTICE_SNIPPET_LIMIT,
	resetWorkflowLifecycleNotificationState,
	seedWorkflowLifecycleNotificationState,
	type WorkflowLifecycleNoticeDetails,
	withWorkflowLifecycleNotificationsSuppressed,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

interface SentMessage {
	readonly customType: string;
	readonly content?: string;
	readonly display?: boolean;
	readonly details?: WorkflowLifecycleNoticeDetails;
}

type SendOptions = {
	readonly triggerTurn?: boolean;
	readonly deliverAs?: "steer" | "followUp" | "nextTurn" | "interrupt";
};

const config = {
	enabled: true,
	notifyOn: ["completed", "failed", "blocked", "awaiting_input"] as const,
};

function runningStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id: "stage-1",
		name: "planner",
		status: "running",
		parentIds: [],
		toolEvents: [],
		...overrides,
	};
}

function prompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
	return {
		id: "prompt-1",
		kind: "confirm",
		message: "Proceed with this plan?",
		createdAt: 10,
		...overrides,
	};
}

function install() {
	const store = createStore();
	const state = createWorkflowLifecycleNotificationState();
	const sent: SentMessage[] = [];
	const options: SendOptions[] = [];
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		config,
		state,
		sendMessage(message, sendOptions) {
			sent.push(message as SentMessage);
			options.push(sendOptions ?? {});
		},
	});
	return { store, state, sent, options, unsubscribe };
}

function installWithState(
	store: ReturnType<typeof createStore>,
	state: ReturnType<typeof createWorkflowLifecycleNotificationState>,
	sent: SentMessage[],
): () => void {
	return installWorkflowLifecycleNotifications({
		store,
		config,
		state,
		seedExisting: true,
		sendMessage(message) {
			sent.push(message as SentMessage);
		},
	});
}

function startRun(store: ReturnType<typeof createStore>, id: string, name = id): void {
	store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 });
}

describe("installWorkflowLifecycleNotifications", () => {
	test("emits one completion notice when a run completes", () => {
		const { store, sent, options } = install();
		store.recordRunStart({ id: "run-1", name: "release", inputs: {}, status: "running", stages: [], startedAt: 1 });

		assert.equal(store.recordRunEnd("run-1", "completed", {}, undefined), true);
		store.recordNotice({ id: "nudge", level: "info", message: "force notify", createdAt: 3 });

		assert.equal(sent.length, 1);
		assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true }]);
		assert.equal(sent[0]?.customType, LIFECYCLE_NOTICE_CUSTOM_TYPE);
		assert.equal(sent[0]?.display, true);
		assert.equal(sent[0]?.details?.kind, "completed");
		assert.equal(sent[0]?.details?.scope, "run");
		assert.equal(sent[0]?.details?.workflowName, "release");
		assert.match(sent[0]?.content ?? "", /\/workflow status run-1/);
	});

	test("uses blocked lifecycle notices for runs ending with blocked status", () => {
		const { store, sent } = install();
		store.recordRunStart({
			id: "run-blocked",
			name: "release",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});

		assert.equal(
			store.recordRunEnd(
				"run-blocked",
				"blocked",
				{ status: "blocked", summary: "checks are still pending" },
				"checks are still pending",
			),
			true,
		);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.details?.kind, "blocked");
		assert.equal(sent[0]?.details?.status, "blocked");
		assert.equal(sent[0]?.details?.error, "checks are still pending");
		assert.match(sent[0]?.content ?? "", /ended blocked.*checks are still pending/u);
		assert.doesNotMatch(sent[0]?.content ?? "", /✓/u);
	});

	test("uses blocked lifecycle notices for legacy completed runs whose returned status needs human", () => {
		const { store, sent } = install();
		startRun(store, "run-needs-human", "adversarial-verification");

		assert.equal(
			store.recordRunEnd("run-needs-human", "completed", {
				status: "needs_human",
				remaining_work: "Worker failed before producing a receipt: No API key for provider: github-copilot",
			}),
			true,
		);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.details?.kind, "blocked");
		assert.equal(sent[0]?.details?.status, "blocked");
		assert.match(sent[0]?.details?.error ?? "", /No API key for provider: github-copilot/u);
		assert.doesNotMatch(sent[0]?.content ?? "", /completed/u);
		assert.match(sent[0]?.content ?? "", /ended blocked.*No API key for provider: github-copilot/u);
	});

	test("uses blocked lifecycle notices for structured recoverable stage failures without returned status", () => {
		const { store, sent } = install();
		startRun(store, "run-structured-auth", "adversarial-verification");
		const failure = {
			failureKind: "auth" as const,
			failureCode: "missing_api_key" as const,
			failureRecoverability: "recoverable" as const,
			failureDisposition: "active_blocked" as const,
			failureMessage: "No API key for provider: github-copilot",
		};
		const reviewer = runningStage({ id: "reviewer-a", name: "reviewer-a" });
		store.recordStageStart("run-structured-auth", reviewer);
		store.recordStageEnd("run-structured-auth", {
			...reviewer,
			...failure,
			status: "failed",
			error: "A required model provider API key is missing. Configure the provider credentials and resume the workflow.",
			endedAt: 2,
		});

		assert.equal(
			store.recordRunEnd(
				"run-structured-auth",
				"completed",
				{ remaining_work: "Reviewer execution failed" },
				undefined,
				{
					...failure,
					failedStageId: "reviewer-a",
					resumable: true,
				},
			),
			true,
		);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.details?.kind, "blocked");
		assert.equal(sent[0]?.details?.status, "blocked");
		assert.match(sent[0]?.details?.error ?? "", /No API key for provider: github-copilot/u);
		assert.doesNotMatch(sent[0]?.content ?? "", /completed/u);
		assert.match(sent[0]?.content ?? "", /ended blocked.*No API key for provider: github-copilot/u);
	});

	test("includes ctx.exit blocked reasons in lifecycle notices", () => {
		const { store, sent } = install();
		startRun(store, "run-exit-blocked", "release");

		assert.equal(
			store.recordRunEnd("run-exit-blocked", "blocked", undefined, undefined, {
				exited: true,
				exitReason: "waiting for approval",
			}),
			true,
		);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.details?.kind, "blocked");
		assert.equal(sent[0]?.details?.error, "waiting for approval");
		assert.match(sent[0]?.content ?? "", /ended blocked.*waiting for approval/u);
	});

	test("seeds historical completed runs using returned failed or blocked status", () => {
		const store = createStore();
		const sent: SentMessage[] = [];
		startRun(store, "run-legacy-failed", "legacy failed");
		store.recordRunEnd("run-legacy-failed", "completed", { status: "failed", summary: "old failure" });
		startRun(store, "run-legacy-blocked", "legacy blocked");
		store.recordRunEnd("run-legacy-blocked", "completed", { status: "blocked", summary: "old blocker" });

		installWorkflowLifecycleNotifications({
			store,
			config,
			state: createWorkflowLifecycleNotificationState(),
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});
		store.recordNotice({ id: "history-tick", level: "info", message: "tick", createdAt: 13 });

		assert.deepEqual(sent, []);
	});

	test("emits failure notice with stage and truncated error context", () => {
		const { store, sent, options } = install();
		const longError = `${"No API key. ".repeat(40)}tail`;
		store.recordRunStart({ id: "run-2", name: "deploy", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart("run-2", runningStage({ id: "stage-2", name: "publish" }));

		assert.equal(store.recordRunEnd("run-2", "failed", undefined, longError, { failedStageId: "stage-2" }), true);

		assert.equal(sent.length, 1);
		assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true }]);
		assert.equal(sent[0]?.details?.kind, "failed");
		assert.equal(sent[0]?.details?.stageName, "publish");
		assert.equal(sent[0]?.details?.error?.length, LIFECYCLE_NOTICE_SNIPPET_LIMIT);
		assert.match(sent[0]?.details?.error ?? "", /…$/);
	});

	test("tracks a stage pending prompt without waking the main chat", () => {
		const { store, state, sent, options } = install();
		store.recordRunStart({ id: "run-3", name: "review", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart("run-3", runningStage());

		assert.equal(store.recordStagePendingPrompt("run-3", "stage-1", prompt()), true);
		store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 11 });

		assert.equal(sent.length, 0);
		assert.deepEqual(options, []);
		assert.equal(state.deliveredInputPrompts.size, 1);
	});

	test("tracks ask_user_question-style stages without waking the main chat", () => {
		const { store, state, sent, options } = install();
		store.recordRunStart({ id: "run-4", name: "qa", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart("run-4", runningStage({ id: "stage-ask", name: "question" }));
		assert.equal(
			store.recordStageInputRequest("run-4", "stage-ask", {
				id: "ask-1",
				kind: "ask_user_question",
				createdAt: 122,
				questions: [{ question: "What color?", options: [{ label: "Red" }, { label: "Blue" }] }],
			}),
			true,
		);

		assert.equal(store.recordStageAwaitingInput("run-4", "stage-ask", true, 123), true);

		assert.equal(sent.length, 0);
		assert.deepEqual(options, []);
		assert.equal(state.deliveredInputPrompts.size, 1);
	});

	test("tracks a fresh promptless awaiting-input state after resolving a structured stage prompt", () => {
		const { store, state, sent } = install();
		const runId = "run-stale-footprint";
		const stageId = "stage-mixed";

		startRun(store, runId, "stale footprint");
		store.recordStageStart(runId, runningStage({ id: stageId, name: "mixed" }));

		assert.equal(
			store.recordStagePendingPrompt(
				runId,
				stageId,
				prompt({ id: "prompt-1", message: "Old structured prompt", createdAt: 10 }),
			),
			true,
		);
		assert.equal(store.resolveStagePendingPrompt(runId, stageId, "prompt-1", "accepted"), true);
		assert.equal(store.recordStageAwaitingInput(runId, stageId, true, 123), true);

		assert.equal(sent.length, 0);
		assert.equal(state.deliveredInputPrompts.size, 2);
	});

	test("dedupes repeated promptless pauses by awaitingInputSince instead of stale prompt footprint", () => {
		const { store, state, sent } = install();
		const runId = "run-promptless-dedupe";
		const stageId = "stage-repeat";

		startRun(store, runId, "promptless dedupe");
		store.recordStageStart(runId, runningStage({ id: stageId, name: "repeat" }));

		assert.equal(store.recordStagePendingPrompt(runId, stageId, prompt({ id: "prompt-1", createdAt: 10 })), true);
		assert.equal(store.resolveStagePendingPrompt(runId, stageId, "prompt-1", true), true);
		assert.equal(store.recordStageAwaitingInput(runId, stageId, true, 123), true);
		store.recordNotice({ id: "same-pause-tick", level: "info", message: "tick", createdAt: 124 });
		assert.equal(store.recordStageAwaitingInput(runId, stageId, false), true);
		assert.equal(store.recordStageAwaitingInput(runId, stageId, true, 456), true);

		assert.equal(sent.length, 0);
		assert.equal(state.deliveredInputPrompts.size, 3);
	});

	test("uses a new prompt id for a second structured stage prompt", () => {
		const { store, state, sent } = install();
		const runId = "run-second-prompt";
		const stageId = "stage-structured";

		startRun(store, runId, "second prompt");
		store.recordStageStart(runId, runningStage({ id: stageId, name: "structured" }));

		assert.equal(store.recordStagePendingPrompt(runId, stageId, prompt({ id: "prompt-1", createdAt: 10 })), true);
		assert.equal(store.resolveStagePendingPrompt(runId, stageId, "prompt-1", false), true);
		assert.equal(
			store.recordStagePendingPrompt(
				runId,
				stageId,
				prompt({ id: "prompt-2", message: "New prompt", createdAt: 20 }),
			),
			true,
		);

		assert.equal(sent.length, 0);
		assert.equal(state.deliveredInputPrompts.size, 2);
	});

	test("respects disabled and notifyOn filtering", () => {
		const store = createStore();
		const sent: SentMessage[] = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: true, notifyOn: ["failed"] },
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});
		store.recordRunStart({ id: "run-5", name: "filtered", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordRunEnd("run-5", "completed", {});
		assert.equal(sent.length, 0);

		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: ["completed", "failed", "awaiting_input"] },
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});
		store.recordRunStart({ id: "run-6", name: "disabled", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordRunEnd("run-6", "failed", undefined, "boom");
		assert.equal(sent.length, 1);
	});

	test("tracks a run-level pending prompt without waking the main chat", () => {
		const { store, state, sent, options } = install();
		startRun(store, "run-prompt", "legacy");

		assert.equal(store.recordPendingPrompt("run-prompt", prompt({ id: "run-prompt-1" })), true);

		assert.equal(sent.length, 0);
		assert.deepEqual(options, []);
		assert.equal(state.deliveredInputPrompts.size, 1);
	});

	test("suppresses run-level pending prompt when notifyOn excludes awaiting_input", () => {
		const store = createStore();
		const sent: SentMessage[] = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: true, notifyOn: ["completed", "failed"] },
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});
		startRun(store, "run-filtered-prompt", "legacy filtered");

		assert.equal(store.recordPendingPrompt("run-filtered-prompt", prompt({ id: "filtered-prompt" })), true);

		assert.equal(sent.length, 0);
	});

	test("shared state dedupes terminal notices across reinstall", () => {
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const sent: SentMessage[] = [];
		const unsubscribe = installWithState(store, state, sent);
		startRun(store, "run-dedupe", "dedupe");
		store.recordRunEnd("run-dedupe", "completed", {});
		unsubscribe();
		installWithState(store, state, sent);
		startRun(store, "run-other", "other");

		assert.deepEqual(
			sent.map((message) => message.details?.runId),
			["run-dedupe"],
		);
	});

	test("omitted seedExisting treats current terminal runs and prompts as history", () => {
		const store = createStore();
		startRun(store, "run-old", "old");
		store.recordRunEnd("run-old", "completed", {});
		startRun(store, "run-old-prompt", "old prompt");
		store.recordPendingPrompt("run-old-prompt", prompt({ id: "old-prompt" }));

		const sent: SentMessage[] = [];
		installWorkflowLifecycleNotifications({
			store,
			config,
			state: createWorkflowLifecycleNotificationState(),
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});
		store.recordNotice({ id: "tick", level: "info", message: "tick", createdAt: 11 });
		startRun(store, "run-new", "new");
		store.recordRunEnd("run-new", "completed", {});

		assert.deepEqual(
			sent.map((message) => message.details?.runId),
			["run-new"],
		);
	});

	test("resetting shared state allows reused run IDs across session boundaries", () => {
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const sent: SentMessage[] = [];
		let unsubscribe = installWithState(store, state, sent);
		startRun(store, "run-reused", "first session");
		store.recordRunEnd("run-reused", "completed", {});
		unsubscribe();

		store.clear();
		resetWorkflowLifecycleNotificationState(state);
		unsubscribe = installWithState(store, state, sent);
		startRun(store, "run-reused", "second session");
		store.recordRunEnd("run-reused", "completed", {});
		unsubscribe();

		assert.deepEqual(
			sent.map((message) => message.details?.workflowName),
			["first session", "second session"],
		);
	});

	test("restore suppression after reset seeds restored history without emitting", () => {
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const sent: SentMessage[] = [];
		installWorkflowLifecycleNotifications({
			store,
			config,
			state,
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});

		startRun(store, "run-before-reset", "before reset");
		store.recordRunEnd("run-before-reset", "completed", {});
		store.clear();
		resetWorkflowLifecycleNotificationState(state);

		const entries: SessionEntry[] = [
			{
				id: "e1",
				type: "workflow.run.start",
				payload: { runId: "run-restored-after-reset", name: "restored after reset", inputs: {}, ts: 1 },
			},
			{
				id: "e2",
				type: "workflow.run.end",
				payload: { runId: "run-restored-after-reset", status: "completed", result: {}, ts: 2 },
			},
		];

		withWorkflowLifecycleNotificationsSuppressed(state, () => {
			restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
			seedWorkflowLifecycleNotificationState(state, store.snapshot());
		});
		store.recordNotice({ id: "after-reset-restore", level: "info", message: "tick", createdAt: 12 });
		startRun(store, "run-live-after-reset", "live after reset");
		store.recordRunEnd("run-live-after-reset", "completed", {});

		assert.deepEqual(
			sent.map((message) => message.details?.runId),
			["run-before-reset", "run-live-after-reset"],
		);
	});

	test("suppression seeds actual restore replay without emitting", () => {
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const sent: SentMessage[] = [];
		installWorkflowLifecycleNotifications({
			store,
			config,
			state,
			sendMessage(message) {
				sent.push(message as SentMessage);
			},
		});
		const entries: SessionEntry[] = [
			{
				id: "e1",
				type: "workflow.run.start",
				payload: { runId: "run-restored", name: "restored", inputs: {}, ts: 1 },
			},
			{
				id: "e2",
				type: "workflow.run.end",
				payload: { runId: "run-restored", status: "failed", error: "old failure", ts: 2 },
			},
		];

		withWorkflowLifecycleNotificationsSuppressed(state, () => {
			restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
		});
		store.recordNotice({ id: "after-restore", level: "info", message: "tick", createdAt: 12 });
		startRun(store, "run-live", "live");
		store.recordRunEnd("run-live", "failed", undefined, "live failure");

		assert.deepEqual(
			sent.map((message) => message.details?.runId),
			["run-live"],
		);
	});
});

describe("neutral workflow lifecycle bridge", () => {
	test("publishes top-level current lifecycle states even when chat notices are disabled", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "run-start", "build");
		store.recordRunStart({
			id: "nested-run",
			name: "hidden child",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 2,
			parentRunId: "run-start",
		});
		store.recordStageStart("run-start", runningStage({ id: "approval", name: "approval" }));
		store.recordStageAwaitingInput("run-start", "approval", true, 3);
		const eventCountAtWait = events.length;
		store.recordNotice({ id: "while-awaiting", level: "info", message: "unrelated", createdAt: 3.5 });
		assert.equal(events.length, eventCountAtWait);

		store.recordStageAwaitingInput("run-start", "approval", false, 4);
		store.recordRunPaused("run-start", 4, { actor: "user" });
		store.recordRunResumed("run-start", 5, { actor: "user", source: "run_control" });
		const eventCountAfterResume = events.length;
		store.recordNotice({ id: "after-resume", level: "info", message: "unrelated", createdAt: 5.5 });
		assert.equal(events.length, eventCountAfterResume);

		startRun(store, "run-failed", "failed");
		store.recordRunEnd("run-failed", "failed", undefined, "failure details");
		startRun(store, "run-blocked", "blocked");
		store.recordRunEnd("run-blocked", "blocked", undefined, "blocked details");
		startRun(store, "run-completed", "completed");
		store.recordRunEnd("run-completed", "completed", {});
		startRun(store, "run-quit", "quit");
		store.recordRunPaused("run-quit", 6, { actor: "user", exitReason: "quit" });

		assert.deepEqual([...new Set(events.map((event) => event.kind))].sort(), [
			"awaiting_input",
			"blocked",
			"completed",
			"failed",
			"paused",
			"quit",
			"resumed",
			"started",
		]);
		assert.equal(
			events.some((event) => event.runKey === "nested-run"),
			false,
		);
		assert.equal(events.find((event) => event.kind === "awaiting_input")?.label, "build: approval");
		assert.equal(
			events.some((event) => event.label.includes("failure details")),
			false,
		);
		assert.deepEqual(events, [
			{ runKey: "run-start", kind: "started", label: "build" },
			{ runKey: "run-start", kind: "awaiting_input", label: "build: approval" },
			{ runKey: "run-start", kind: "resumed", label: "build" },
			{ runKey: "run-start", kind: "paused", label: "build: approval" },
			{ runKey: "run-start", kind: "resumed", label: "build: approval" },
			{ runKey: "run-failed", kind: "started", label: "failed" },
			{ runKey: "run-failed", kind: "failed", label: "failed" },
			{ runKey: "run-blocked", kind: "started", label: "blocked" },
			{ runKey: "run-blocked", kind: "blocked", label: "blocked" },
			{ runKey: "run-completed", kind: "started", label: "completed" },
			{ runKey: "run-completed", kind: "completed", label: "completed" },
			{ runKey: "run-quit", kind: "started", label: "quit" },
			{ runKey: "run-quit", kind: "quit", label: "quit" },
		]);
	});

	test("seeds a replacement bridge from active and blocked snapshot state", () => {
		const store = createStore();
		startRun(store, "active", "active workflow");
		startRun(store, "failed", "failed workflow");
		store.recordRunEnd("failed", "failed", undefined, "private failure");

		const first: Array<{ runKey: string; kind: string; label: string }> = [];
		const unsubscribeFirst = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				first.push(event);
			},
		});
		assert.deepEqual(
			first.map((event) => event.kind),
			["started", "failed"],
		);

		assert.equal(first.find((event) => event.kind === "failed")?.label, "failed workflow");
		unsubscribeFirst();

		const replacement: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				replacement.push(event);
			},
		});
		assert.deepEqual(
			replacement.map((event) => event.kind),
			["started", "failed"],
		);
	});
	test("keeps a fresh-id continuation on one logical bridge contribution", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "failed-source", "deploy");
		store.recordRunEnd("failed-source", "failed", undefined, "private failure");
		store.recordRunStart({
			id: "fresh-continuation",
			name: "deploy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 3,
			resumedFromRunId: "failed-source",
			resumeSource: "run_control",
			resumeActor: "agent",
			resumedAt: 3,
		});
		store.recordRunEnd("fresh-continuation", "completed", {});

		assert.deepEqual(events, [
			{ runKey: "failed-source", kind: "started", label: "deploy" },
			{ runKey: "failed-source", kind: "failed", label: "deploy" },
			{ runKey: "failed-source", kind: "resumed", label: "deploy" },
			{ runKey: "failed-source", kind: "completed", label: "deploy" },
		]);
	});
	test("keeps a logical continuation working while any sibling leaf remains live", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "source", "deploy");
		store.recordRunEnd("source", "failed", undefined, "private failure");
		store.recordRunStart({
			id: "branch-one",
			name: "deploy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 2,
			resumedFromRunId: "source",
		});
		store.recordRunStart({
			id: "branch-two",
			name: "deploy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 3,
			resumedFromRunId: "source",
		});
		const beforeBranchCompletion = events.length;
		store.recordRunEnd("branch-two", "completed", {});
		assert.deepEqual(events.slice(beforeBranchCompletion), []);

		store.recordRunEnd("branch-one", "completed", {});
		assert.deepEqual(events.at(-1), { runKey: "source", kind: "completed", label: "deploy" });
		assert.equal(
			events.every((event) => event.runKey === "source"),
			true,
		);
	});

	test("does not resurrect a failed predecessor after pruning a completed continuation", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "source", "deploy");
		store.recordRunEnd("source", "failed", undefined, "private failure");
		store.recordRunStart({
			id: "successor",
			name: "deploy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 2,
			resumedFromRunId: "source",
		});
		store.recordRunEnd("successor", "completed", {});
		const afterCompletion = events.length;

		store.removeRun("successor");
		assert.deepEqual(events.slice(afterCompletion), []);
	});

	test("preserves a completed continuation tombstone across bridge replacement", () => {
		const store = createStore();
		const bus = createEventBus();
		const first: Array<{ runKey: string; kind: string; label: string }> = [];
		const firstUnsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			rememberBridgeLineage(runId, runKey) {
				rememberWorkflowLifecycleBridgeLineage(runId, runKey, bus);
			},
			publishLifecycleEvent(event) {
				rememberWorkflowLifecycleBridgeEvent(event, bus);
				first.push(event);
			},
		});

		startRun(store, "source", "deploy");
		store.recordRunEnd("source", "failed", undefined, "private failure");
		store.recordRunStart({
			id: "successor",
			name: "deploy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 2,
			resumedFromRunId: "source",
		});
		store.recordRunEnd("successor", "completed", {});
		store.removeRun("successor");
		firstUnsubscribe();
		clearWorkflowLifecycleBridgeEvents(bus);
		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(bus), []);

		assert.deepEqual(getWorkflowLifecycleBridgeLineages(bus), [
			{ runId: "source", runKey: "source" },
			{ runId: "successor", runKey: "source" },
		]);
		assert.deepEqual(getWorkflowLifecycleBridgeTerminalLineages(bus), ["source"]);

		const replacement: Array<{ runKey: string; kind: string; label: string }> = [];
		const replacementUnsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			bridgeLineages: getWorkflowLifecycleBridgeLineages(bus),
			bridgeTerminalLineages: getWorkflowLifecycleBridgeTerminalLineages(bus),
			publishLifecycleEvent(event) {
				replacement.push(event);
			},
		});

		assert.deepEqual(replacement, []);
		replacementUnsubscribe();
	});

	test("allows a quit run to resume after its dropped contribution is tombstoned", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "quit-resume", "deploy");
		store.recordRunPaused("quit-resume", 2, { actor: "user", exitReason: "quit" });
		store.recordRunResumed("quit-resume", 3, { actor: "user", source: "run_control" });

		assert.deepEqual(events, [
			{ runKey: "quit-resume", kind: "started", label: "deploy" },
			{ runKey: "quit-resume", kind: "quit", label: "deploy" },
			{ runKey: "quit-resume", kind: "resumed", label: "deploy" },
		]);
	});

	test("keeps a two-hop continuation key after its predecessors leave the snapshot", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "root", "chain");
		store.recordRunEnd("root", "failed", undefined, "first failure");
		store.recordRunStart({
			id: "middle",
			name: "chain",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 2,
			resumedFromRunId: "root",
		});
		store.recordRunEnd("middle", "failed", undefined, "second failure");
		store.recordRunStart({
			id: "leaf",
			name: "chain",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 3,
			resumedFromRunId: "middle",
		});
		const beforeRemoval = events.length;
		store.removeRun("root");
		store.removeRun("middle");
		store.recordNotice({ id: "unrelated", level: "info", message: "tick", createdAt: 4 });
		assert.deepEqual(events.slice(beforeRemoval), []);
		assert.equal(
			events.every((event) => event.runKey === "root"),
			true,
		);

		store.recordRunEnd("leaf", "completed", {});
		assert.deepEqual(events.at(-1), { runKey: "root", kind: "completed", label: "chain" });
	});

	test("reconstructs a pruned two-hop continuation under the same key after replacement", () => {
		const store = createStore();
		const bus = createEventBus();
		const first: Array<{ runKey: string; kind: string; label: string }> = [];
		const firstUnsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			rememberBridgeLineage(runId, runKey) {
				rememberWorkflowLifecycleBridgeLineage(runId, runKey, bus);
			},
			publishLifecycleEvent(event) {
				rememberWorkflowLifecycleBridgeEvent(event, bus);
				first.push(event);
			},
		});

		startRun(store, "root", "chain");
		store.recordRunEnd("root", "failed", undefined, "first failure");
		store.recordRunStart({
			id: "middle",
			name: "chain",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 2,
			resumedFromRunId: "root",
		});
		store.recordRunEnd("middle", "failed", undefined, "second failure");
		store.recordRunStart({
			id: "leaf",
			name: "chain",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 3,
			resumedFromRunId: "middle",
		});
		store.removeRun("root");
		store.removeRun("middle");
		firstUnsubscribe();

		const replacement: Array<{ runKey: string; kind: string; label: string }> = [];
		const replacementUnsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			bridgeLineages: getWorkflowLifecycleBridgeLineages(bus),
			publishLifecycleEvent(event) {
				replacement.push(event);
			},
		});

		assert.equal(replacement.at(-1)?.runKey, "root");
		store.recordRunEnd("leaf", "completed", {});
		assert.deepEqual(replacement.at(-1), { runKey: "root", kind: "completed", label: "chain" });
		assert.equal(
			first.every((event) => event.runKey === "root"),
			true,
		);
		replacementUnsubscribe();
	});

	test("drops killed, cancelled, and skipped runs without claiming they completed", () => {
		for (const status of ["killed", "cancelled", "skipped"] as const) {
			const store = createStore();
			const events: Array<{ runKey: string; kind: string; label: string }> = [];
			installWorkflowLifecycleNotifications({
				store,
				config: { enabled: false, notifyOn: [] },
				publishLifecycleEvent(event) {
					events.push(event);
				},
			});

			startRun(store, status, "cleanup");
			store.recordRunEnd(status, status, {});
			assert.deepEqual(
				events,
				[
					{ runKey: status, kind: "started", label: "cleanup" },
					{ runKey: status, kind: "quit", label: "cleanup" },
				],
				`run ended ${status}`,
			);
			assert.equal(
				events.some((event) => event.kind === "completed"),
				false,
				`run ended ${status} must never publish completed`,
			);
		}
	});

	test("drops a run that leaves the snapshot without claiming it completed", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		startRun(store, "vanishes", "deploy");
		store.removeRun("vanishes");
		assert.deepEqual(events, [
			{ runKey: "vanishes", kind: "started", label: "deploy" },
			{ runKey: "vanishes", kind: "quit", label: "deploy" },
		]);
	});

	test("publishes one event when a listener synchronously invalidates the store", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		let reentered = false;
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
				if (reentered || event.kind !== "started") return;
				reentered = true;
				// A synchronous listener re-enters `inspect` from inside publish.
				store.recordNotice({ id: "listener-side-effect", level: "info", message: "tick", createdAt: 2 });
			},
		});

		startRun(store, "run-1", "deploy");
		assert.equal(reentered, true);
		assert.deepEqual(events, [{ runKey: "run-1", kind: "started", label: "deploy" }]);
	});

	test("keeps reentrant publishes in order when the store really changed", () => {
		const store = createStore();
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		let reentered = false;
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
				if (reentered || event.kind !== "started") return;
				reentered = true;
				store.recordStageStart("run-1", runningStage({ id: "approval", name: "approval" }));
				store.recordStageAwaitingInput("run-1", "approval", true, 3);
			},
		});

		startRun(store, "run-1", "deploy");
		assert.deepEqual(events, [
			{ runKey: "run-1", kind: "started", label: "deploy" },
			{ runKey: "run-1", kind: "awaiting_input", label: "deploy: approval" },
		]);
	});

	test("reconciles a retained contribution against the successor's own store", () => {
		const store = createStore();
		startRun(store, "live", "deploy");
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			bridgeContributions: [
				{ runKey: "live", kind: "started", label: "deploy" },
				{ runKey: "gone", kind: "started", label: "stale" },
			],
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});

		// The live run keeps the contribution it already published; the run this
		// bridge cannot observe is dropped rather than left behind.
		assert.deepEqual(events, [{ runKey: "gone", kind: "quit", label: "stale" }]);
		unsubscribe();
	});

	test("does not resurrect completed or quit runs while seeding a replacement", () => {
		const store = createStore();
		startRun(store, "completed", "completed workflow");
		store.recordRunEnd("completed", "completed", {});
		startRun(store, "quit", "quit workflow");
		store.recordRunPaused("quit", 3, { actor: "user", exitReason: "quit" });
		const events: Array<{ runKey: string; kind: string; label: string }> = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				events.push(event);
			},
		});
		assert.deepEqual(events, []);
		unsubscribe();
	});
	test("dedupes bridge state across a notification reinstall that shares lifecycle state", () => {
		const store = createStore();
		startRun(store, "run-shared", "shared workflow");
		const state = createWorkflowLifecycleNotificationState();
		const first: Array<{ runKey: string; kind: string; label: string }> = [];
		const unsubscribeFirst = installWorkflowLifecycleNotifications({
			store,
			state,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				first.push(event);
			},
		});
		assert.deepEqual(first, [{ runKey: "run-shared", kind: "started", label: "shared workflow" }]);
		unsubscribeFirst();

		const second: Array<{ runKey: string; kind: string; label: string }> = [];
		const unsubscribeSecond = installWorkflowLifecycleNotifications({
			store,
			state,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent(event) {
				second.push(event);
			},
		});
		assert.deepEqual(second, []);
		unsubscribeSecond();
	});
});
