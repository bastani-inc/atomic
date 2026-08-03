import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { listOpenableCompletedWorkflows } from "../../packages/workflows/src/durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableBoundaryChildTopology, DurableStageTopology } from "../../packages/workflows/src/durable/types.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

interface ChatFixture {
	readonly rootId: string;
	readonly childId: string;
	readonly boundaryId: string;
	readonly sessionFile: string;
	readonly output: WorkflowSerializableValue;
}

function boundaryTopology(
	fixture: ChatFixture,
	child: DurableBoundaryChildTopology,
	event: "start" | "terminal",
): DurableStageTopology {
	const identity = {
		version: 1 as const,
		replayScope: "workflow:chat-child:1",
		alias: "chat-child",
		workflow: "chat-child",
		child,
	};
	return event === "start"
		? {
				version: 1,
				stageId: fixture.boundaryId,
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: { runId: fixture.rootId, runName: "chat-root" },
				boundary: { ...identity, event: "start", status: "running" },
			}
		: {
				version: 1,
				stageId: fixture.boundaryId,
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: { runId: fixture.rootId, runName: "chat-root" },
				boundary: { ...identity, event: "terminal", status: "completed" },
			};
}

async function persistChatFixture(backend: DbosDurableBackend, fixture: ChatFixture): Promise<void> {
	const replayKey = "workflow:chat-child:1";
	const child: DurableBoundaryChildTopology = {
		runId: fixture.childId,
		runName: "chat-child",
		parentRunId: fixture.rootId,
		parentStageId: fixture.boundaryId,
		rootRunId: fixture.rootId,
	};
	backend.registerWorkflow({
		workflowId: fixture.rootId,
		name: "chat-root",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	await backend.recordCheckpointAsync({
		kind: "stage",
		workflowId: fixture.rootId,
		checkpointId: `boundary-start:${replayKey}`,
		name: "workflow:chat-child",
		replayKey,
		completedAt: 1,
		topology: boundaryTopology(fixture, child, "start"),
	});
	await backend.recordCheckpointAsync({
		kind: "stage",
		workflowId: fixture.rootId,
		checkpointId: `${replayKey}:stage:retained`,
		name: "retained-child",
		replayKey: `${replayKey}:stage:retained:1`,
		output: "done",
		sessionFile: fixture.sessionFile,
		completedAt: 2,
		topology: {
			version: 1,
			stageId: "retained-child-stage",
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: child,
		},
	});
	await backend.recordCheckpointAsync({
		kind: "stage",
		workflowId: fixture.rootId,
		checkpointId: `boundary-terminal:${replayKey}:completed`,
		name: "workflow:chat-child",
		replayKey,
		completedAt: 3,
		endedAt: 3,
		output: fixture.output,
		topology: boundaryTopology(fixture, child, "terminal"),
	});
	backend.setWorkflowStatus(fixture.rootId, "completed");
	await backend.flush();
}

function createTranscript(directory: string, id: string): string {
	const sessionFile = join(directory, `${id}.jsonl`);
	writeFileSync(
		sessionFile,
		`${[
			JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: directory }),
			JSON.stringify({
				type: "message",
				id: "message",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "prior" },
			}),
		].join("\n")}\n`,
	);
	return sessionFile;
}

test("fresh DBOS root-only catalog opens nested post-mortem chat detached from execution", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-nested-chat-"));
	try {
		const fixture: ChatFixture = {
			rootId: testRunId("completed-chat-root"),
			childId: testRunId("completed-chat-child"),
			boundaryId: "completed-chat-boundary",
			sessionFile: createTranscript(tempDir, "nested-chat"),
			output: {
				workflow: "chat-child",
				runId: testRunId("completed-chat-child"),
				status: "completed",
				exited: false,
				outputs: {},
			},
		};
		const sdk = createMockSdk();
		const writer = new DbosDurableBackend(sdk, { executorId: "completed-chat-writer" });
		await persistChatFixture(writer, fixture);
		assert.equal(sdk.state.workflows.size, 1, "nested child has no independent DBOS catalog row");

		const fresh = new DbosDurableBackend(sdk, { executorId: "completed-chat-fresh" });
		await fresh.hydrateWorkflow(fixture.rootId);
		const catalog = await fresh.prepareWorkflowCatalog();
		assert.deepEqual(
			catalog.completed.map((entry) => entry.workflowId),
			[fixture.rootId],
		);
		assert.deepEqual(
			listOpenableCompletedWorkflows(fresh).map((entry) => entry.workflowId),
			[fixture.rootId],
		);

		const prompts: string[] = [];
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile: fixture.sessionFile,
			async prompt(text: string) {
				prompts.push(text);
			},
		};
		const registry = createStageControlRegistry();
		const freshStore = createStore();
		const opened = openCompletedDurableWorkflow(
			fixture.rootId,
			{
				durableBackend: fresh,
				store: freshStore,
				stageControlRegistry: registry,
				cwd: tempDir,
				adapters: {
					agentSession: {
						async create() {
							return session;
						},
					},
				},
			},
			catalog.completed,
		);
		assert.equal(opened.ok, true);
		const rootBefore = structuredClone(freshStore.runs().find((run) => run.id === fixture.rootId));
		const childBefore = structuredClone(freshStore.runs().find((run) => run.id === fixture.childId));
		const handle = registry.get(fixture.childId, "retained-child-stage");
		assert.ok(handle);
		await handle.prompt("post-mortem follow-up");
		assert.deepEqual(prompts, ["post-mortem follow-up"]);
		assert.deepEqual(await registry.run(fixture.rootId).pause(), []);
		assert.deepEqual(await registry.run(fixture.childId).resume(), []);
		assert.deepEqual(
			freshStore.runs().find((run) => run.id === fixture.rootId),
			rootBefore,
		);
		assert.deepEqual(
			freshStore.runs().find((run) => run.id === fixture.childId),
			childBefore,
		);
		registry.clear();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("fresh DBOS hides malformed completed child output and registers no chat attachment", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-malformed-chat-"));
	try {
		const fixture: ChatFixture = {
			rootId: testRunId("malformed-chat-root"),
			childId: testRunId("malformed-chat-child"),
			boundaryId: "malformed-chat-boundary",
			sessionFile: createTranscript(tempDir, "malformed-chat"),
			output: {
				workflow: "chat-child",
				runId: testRunId("malformed-chat-child"),
				status: "completed",
				outputs: {},
			},
		};
		const sdk = createMockSdk();
		const writer = new DbosDurableBackend(sdk, { executorId: "malformed-chat-writer" });
		await persistChatFixture(writer, fixture);
		const fresh = new DbosDurableBackend(sdk, { executorId: "malformed-chat-fresh" });
		await fresh.hydrateWorkflow(fixture.rootId);
		const catalog = await fresh.prepareWorkflowCatalog();
		assert.deepEqual(
			catalog.completed.map((entry) => entry.workflowId),
			[fixture.rootId],
		);
		assert.deepEqual(listOpenableCompletedWorkflows(fresh), []);
		const registry = createStageControlRegistry();
		const freshStore = createStore();
		let attachments = 0;
		const opened = openCompletedDurableWorkflow(
			fixture.rootId,
			{
				durableBackend: fresh,
				store: freshStore,
				stageControlRegistry: registry,
				adapters: {
					agentSession: {
						async create() {
							attachments += 1;
							return mockSession();
						},
					},
				},
			},
			catalog.completed,
		);
		assert.deepEqual(opened, {
			ok: false,
			reason: "stale",
			message: `Completed workflow ${fixture.rootId} is stale or missing durable checkpoint/session data and cannot be opened.`,
		});
		assert.deepEqual(freshStore.runs(), []);
		assert.equal(registry.get(fixture.childId, "retained-child-stage"), undefined);
		assert.equal(attachments, 0);
		registry.clear();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
