import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	endWorkflowRunStageSubagentChildren,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT,
	type WorkflowRunEndedStageSubagentsRequest,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { controlSubagentChildren } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import type { PiEventContext } from "../../packages/workflows/src/extension/public-types.js";
import { killRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The subagents extension's answer to the workflows extension, as one Atomic session wires the two. */
function subagentsExtensionEvents(fallback: Pick<ExtensionContext, "sessionManager">) {
	const emitted: string[] = [];
	return {
		emitted,
		emit(event: string, payload: Record<string, unknown>) {
			emitted.push(event);
			if (event !== WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT) return;
			const request = payload as unknown as WorkflowRunEndedStageSubagentsRequest;
			request.completion = endWorkflowRunStageSubagentChildren(request.context ?? fallback, request.stageSessionIds);
		},
	};
}

test("killing a workflow run dormant after a restart ends every subagent of its stages, and resume names why (#3784)", async () => {
	const cwd = makeTempDirectory("dormant-run-kill-");
	cleanups.push(() => removeTempDirectory(cwd));
	const sessions = new MemorySessionStore();
	const launching = await SessionManager.create(sessions, cwd);
	const stageSession = await SessionManager.create(sessions, cwd);
	const stageSessionId = stageSession.getSessionId();
	const runId = `dormant-${crypto.randomUUID().slice(0, 8)}`;
	const statuses = ["running", "paused", "quit", "ok", SUBAGENT_CHILD_STAGE_PAUSED_STATUS, "killed"] as const;
	for (const [index, status] of statuses.entries()) {
		const record: SubagentChildRecord = {
			version: 1,
			childId: `children:${index}`,
			runId: "children",
			index,
			agent: `${status}-child`,
			state: status === "running" ? "running" : "terminal",
			cwd,
			owner: {
				kind: "workflow-stage",
				sessionId: stageSessionId,
				workflowRunId: runId,
				workflowStageId: "build",
				workflowStageName: "build",
			},
			taskId: `task-${index}`,
			...(status === "running" ? {} : { terminalStatus: status }),
		};
		await stageSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	}
	// After a restart the run is known to this session's store, but no generation of its stage runs in this process.
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "dormant",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [
			{ id: "build", name: "build", status: "paused", parentIds: [], toolEvents: [], sessionId: stageSessionId },
		],
		startedAt: 1,
	});
	const events = subagentsExtensionEvents({ sessionManager: launching });

	const killed = await killRun(runId, {
		store,
		events,
		context: { sessionManager: launching } as unknown as PiEventContext,
	});
	assert.equal(killed.ok, true);
	assert.deepEqual(events.emitted, [WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT]);

	const reopened = await SessionManager.open(sessions, stageSessionId);
	const latest = readSubagentChildRecords(reopened.getEntries(), stageSessionId);
	assert.deepEqual(
		Object.fromEntries([...latest.values()].map((record) => [record.agent, [record.state, record.terminalStatus]])),
		{
			"running-child": ["terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS],
			"paused-child": ["terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS],
			"quit-child": ["terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS],
			"ok-child": ["terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS],
			[`${SUBAGENT_CHILD_STAGE_PAUSED_STATUS}-child`]: ["terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS],
			"killed-child": ["terminal", "killed"],
		},
	);

	// Reopening the stage session finds them terminal: neither its restoration nor an explicit resume continues them.
	const stageContext = { sessionManager: reopened } as unknown as ExtensionContext;
	for (const index of [0, 1, 2, 3, 4]) {
		const resumed = await controlSubagentChildren({} as SubagentChildRestoreDeps, stageContext, {
			action: "resume",
			id: `children:${index}`,
		});
		assert.equal(resumed.isError, true);
		const text = resumed.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.match(text, /is terminal and cannot be resumed: its workflow stage ended/);
	}
});
