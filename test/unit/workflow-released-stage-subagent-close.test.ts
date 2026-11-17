import assert from "node:assert/strict";
import type { ExtensionContext, SessionManager } from "@bastani/atomic";
import { test } from "vitest";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "../../packages/coding-agent/src/core/extensions/stale-context.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	subagentChildRecordFailures,
	subagentChildRecordsAppended,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { StageWaitHooks } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { createStageContext, type InternalStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

const RUN_ID = "run-released-stage-children";
const STAGE_ID = "stage-released-stage-children";
const STAGE_NAME = "review";

/**
 * A workflow stage whose sessions run the subagents extension's child records as an AgentSession's would: one admission
 * boundary and extension state for the stage generation, and each session's extension API refusing every append once
 * that session is given up.
 */
function releasableStage() {
	const store = new MemorySessionStore();
	const dispatcher = new StageWakeDispatcher(RUN_ID, undefined);
	dispatcher.open({ runId: RUN_ID, stageId: STAGE_ID, wakeKey: stageWakeKey(RUN_ID, STAGE_ID) });
	const boundary = new WorkflowStageAdmissionBoundary();
	const orchestrationContext = {
		kind: "workflow-stage" as const,
		workflowRunId: RUN_ID,
		workflowStageId: STAGE_ID,
		workflowStageName: STAGE_NAME,
		messageAdmission: { boundary, extensionState: new Map<string, object>(), isOpen: () => boundary.isOpen() },
	};
	const hooks: StageWaitHooks = {
		policy: { afterMs: 0 },
		dispatcher,
		wakeKey: stageWakeKey(RUN_ID, STAGE_ID),
		async enter() {},
		async recordResults() {},
		resultsInTranscript() {},
		async leave() {},
		async reopenFailed() {},
		async rehydrated() {},
		resident() {},
	};
	const sessions: SessionManager[] = [];
	const ctx = createStageContext(
		makeOpts({
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			waiting: hooks,
			adapters: {
				sessionStore: store,
				agentSession: {
					async create(options) {
						const sessionManager = options.sessionManager as SessionManager;
						sessions.push(sessionManager);
						let given = false;
						const pi = {
							appendEntry: async (customType: string, data?: unknown) => {
								if (given) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
								await sessionManager.appendCustomEntry(customType, data);
							},
						};
						const extensionCtx = { sessionManager, orchestrationContext } as unknown as Pick<
							ExtensionContext,
							"sessionManager" | "orchestrationContext"
						>;
						// The child the stage's prompt launches, which settles before the stage waits.
						const sink = createSubagentChildRecordSink(pi, extensionCtx);
						const { session } = makeMockSession({
							sessionId: sessionManager.getSessionId(),
							async prompt() {
								sink.record({
									runId: "released-stage-child",
									index: 0,
									agent: "worker",
									state: "terminal",
									terminalStatus: "ok",
									cwd: "/repo",
								});
								await sink.flushed?.();
							},
							dispose() {
								given = true;
							},
						});
						return Object.assign(session, {
							state: {},
							sessionManager,
							modelRuntime: {},
							getContextUsage: () => undefined,
							orchestrationContext,
							// As AgentSession does: closing the generation closes its admission.
							closeWorkflowStageGeneration: () => boundary.close(),
						});
					},
				},
			},
			stageOptions: { sessionStore: store },
		}),
	) as InternalStageContext;
	return { ctx, store, sessions };
}

test("a stage that gave its session up and is then closed for good records each of its children stage-closed once", async () => {
	const stage = releasableStage();
	await stage.ctx.prompt("launch a worker");
	const [first] = stage.sessions;
	assert.ok(first);
	const stageSessionId = first.getSessionId();
	// The stage gives its session up while it waits, then its run is killed: it closes for good, released.
	await stage.ctx.release();
	assert.equal(stage.ctx.__isReleased?.(), true);
	const failures = subagentChildRecordFailures.count;

	await stage.ctx.__closeGeneration?.(true);
	await subagentChildRecordsAppended(stageSessionId);

	assert.equal(subagentChildRecordFailures.count, failures, "nothing was saved through the session it gave up");
	const { SessionManager: Sessions } = await import("../../packages/coding-agent/src/core/session-manager.js");
	const stored = await Sessions.open(stage.store, stageSessionId);
	const closed = stored
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				(entry.data as { terminalStatus?: string } | undefined)?.terminalStatus ===
					SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
		);
	assert.equal(closed.length, 1);
	assert.equal(
		readSubagentChildRecords(stored.getEntries(), stageSessionId).get("released-stage-child:0")?.terminalStatus,
		SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	);
});
