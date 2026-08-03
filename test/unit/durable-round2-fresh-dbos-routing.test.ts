import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageRunTopology, DurableStageTopology } from "../../packages/workflows/src/durable/types.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { workflowPauseAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

const ROOT_ID = testRunId("round2-routing-root");
const CHILD_IDS = [testRunId("round2-routing-child-a"), testRunId("round2-routing-child-b")] as const;
const LOCAL_STAGE_ID = "shared-local-id";
const LOCAL_STAGE_NAME = "shared-name";

afterEach(() => {
	stageControlRegistry.clear();
	for (const runId of [ROOT_ID, ...CHILD_IDS]) store.removeRun(runId);
});

function transcript(directory: string, name: string): string {
	const file = join(directory, `${name}.jsonl`);
	writeFileSync(
		file,
		`${[
			JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: directory }),
			JSON.stringify({
				type: "message",
				id: `${name}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: name },
			}),
		].join("\n")}\n`,
	);
	return file;
}

function boundaryTopology(
	childRun: DurableStageRunTopology,
	boundaryId: string,
	replayScope: string,
	sourceOrder: number,
	event: "start" | "terminal",
): DurableStageTopology {
	const identity = {
		version: 1 as const,
		replayScope,
		alias: "round2-routing-child",
		workflow: "round2-routing-child",
		child: {
			runId: childRun.runId,
			runName: childRun.runName,
			parentRunId: ROOT_ID,
			parentStageId: boundaryId,
			rootRunId: ROOT_ID,
		},
	};
	return event === "start"
		? {
				version: 1,
				stageId: boundaryId,
				parentIds: [],
				sourceOrder,
				status: "running",
				run: { runId: ROOT_ID, runName: "round2-routing-parent" },
				boundary: { ...identity, event: "start", status: "running" },
			}
		: {
				version: 1,
				stageId: boundaryId,
				parentIds: [],
				sourceOrder,
				status: "completed",
				run: { runId: ROOT_ID, runName: "round2-routing-parent" },
				boundary: { ...identity, event: "terminal", status: "completed" },
			};
}

async function persistRepeatedChildren(
	backend: DbosDurableBackend,
	sessionFiles: readonly [string, string],
): Promise<void> {
	backend.registerWorkflow({
		workflowId: ROOT_ID,
		name: "round2-routing-parent",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	for (const [index, childRunId] of CHILD_IDS.entries()) {
		const ordinal = index + 1;
		const boundaryId = `round2-routing-boundary-${ordinal}`;
		const scope = `workflow:workflow:round2-routing-child:${ordinal}`;
		const childRun: DurableStageRunTopology = {
			runId: childRunId,
			runName: "round2-routing-child",
			parentRunId: ROOT_ID,
			parentStageId: boundaryId,
			rootRunId: ROOT_ID,
		};
		await backend.recordCheckpointAsync({
			kind: "stage",
			workflowId: ROOT_ID,
			checkpointId: `boundary-start:${scope}`,
			name: "workflow:round2-routing-child",
			replayKey: scope,
			completedAt: ordinal,
			topology: boundaryTopology(childRun, boundaryId, scope, index, "start"),
		});
		await backend.recordCheckpointAsync({
			kind: "stage",
			workflowId: ROOT_ID,
			checkpointId: `${scope}:stage:shared:${ordinal}`,
			name: LOCAL_STAGE_NAME,
			replayKey: `${scope}:stage:shared:1`,
			output: `child-${ordinal}`,
			sessionFile: sessionFiles[index],
			sessionId: `session-${ordinal}`,
			startedAt: 10 + ordinal,
			endedAt: 20 + ordinal,
			completedAt: 20 + ordinal,
			topology: {
				version: 1,
				stageId: LOCAL_STAGE_ID,
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: childRun,
			},
		});
		await backend.recordCheckpointAsync({
			kind: "stage",
			workflowId: ROOT_ID,
			checkpointId: `boundary-terminal:${scope}:completed`,
			name: "workflow:round2-routing-child",
			replayKey: scope,
			output: {
				workflow: "round2-routing-child",
				runId: childRunId,
				status: "completed",
				exited: false,
				outputs: {},
			},
			completedAt: 30 + ordinal,
			endedAt: 30 + ordinal,
			topology: boundaryTopology(childRun, boundaryId, scope, index, "terminal"),
		});
	}
	backend.setWorkflowStatus(ROOT_ID, "completed");
	await backend.flush();
}

test.sequential("fresh completed DBOS graphs keep exact attach routing while terminal sends fail at the root", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-round2-routing-"));
	const sessionFiles = [transcript(directory, "child-a"), transcript(directory, "child-b")] as const;
	try {
		const sdk = createMockSdk();
		const writer = new DbosDurableBackend(sdk, { executorId: "round2-routing-writer" });
		await persistRepeatedChildren(writer, sessionFiles);
		const fresh = new DbosDurableBackend(sdk, { executorId: "round2-routing-fresh" });
		await fresh.hydrateWorkflow(ROOT_ID);
		const catalog = await fresh.prepareWorkflowCatalog();
		assert.deepEqual(
			catalog.completed.map((entry) => entry.workflowId),
			[ROOT_ID],
		);

		const attachedFiles: string[] = [];
		const prompts: string[] = [];
		const opened = openCompletedDurableWorkflow(
			ROOT_ID,
			{
				durableBackend: fresh,
				store,
				stageControlRegistry,
				cwd: directory,
				adapters: {
					agentSession: {
						async create(options) {
							const sessionFile = options.sessionManager?.getSessionFile?.();
							attachedFiles.push(sessionFile ?? "");
							const session: StageSessionRuntime = {
								...mockSession(),
								sessionFile,
								async prompt(text: string) {
									prompts.push(text);
								},
							};
							return session;
						},
					},
				},
			},
			catalog.completed,
		);
		assert.equal(opened.ok, true);
		assert.equal(store.runs().filter((run) => CHILD_IDS.includes(run.id as (typeof CHILD_IDS)[number])).length, 2);

		const ambiguousId = resolveStageTarget(ROOT_ID, LOCAL_STAGE_ID);
		assert.equal(ambiguousId.ok, false);
		if (!ambiguousId.ok) assert.match(ambiguousId.message, /Ambiguous stage identifier/);
		const ambiguousName = resolveStageTarget(ROOT_ID, LOCAL_STAGE_NAME);
		assert.equal(ambiguousName.ok, false);
		if (!ambiguousName.ok) assert.match(ambiguousName.message, /Ambiguous stage identifier/);

		const expandedId = `${CHILD_IDS[0]}:${LOCAL_STAGE_ID}`;
		const exact = resolveStageTarget(ROOT_ID, expandedId);
		assert.deepEqual(exact, { ok: true, runId: CHILD_IDS[0], stageId: LOCAL_STAGE_ID });
		assert.equal(Object.getPrototypeOf(exact), Object.prototype);
		const handle = stageControlRegistry.get(CHILD_IDS[0], LOCAL_STAGE_ID);
		assert.ok(handle, "exact attach resolves the first child's detached handle");
		await handle.ensureAttached();
		assert.deepEqual(attachedFiles, [sessionFiles[0]]);

		const sent = await workflowSendAction({
			runId: ROOT_ID,
			stageId: expandedId,
			text: "route only to child a",
			delivery: "prompt",
		});
		assert.equal(sent.status, "failed");
		if (sent.status === "failed") {
			assert.equal(sent.code, "WORKFLOW_TERMINAL");
			assert.equal(sent.workflowStatus, "completed");
		}
		assert.equal(sent.runId, ROOT_ID);
		assert.equal(sent.stageId, expandedId);
		assert.equal(sent.delivery, "rejected");
		assert.deepEqual(prompts, []);

		const paused = await workflowPauseAction({ runId: ROOT_ID, stageId: expandedId });
		assert.ok("runId" in paused && "status" in paused);
		if ("runId" in paused && "status" in paused) {
			assert.equal(paused.runId, CHILD_IDS[0]);
			assert.equal(paused.status, "noop", "completed child chat cannot pause execution");
		}
		const resumed = await workflowSendAction({
			runId: ROOT_ID,
			stageId: expandedId,
			text: "must stay detached",
			delivery: "resume",
		});
		assert.equal(resumed.status, "failed");
		assert.equal(resumed.runId, ROOT_ID);
		assert.equal(resumed.stageId, expandedId);
		assert.equal(resumed.delivery, "rejected");
		assert.deepEqual(prompts, [], "terminal send never falls back to root execution or chat");
		assert.equal(stageControlRegistry.get(ROOT_ID, LOCAL_STAGE_ID), undefined);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
