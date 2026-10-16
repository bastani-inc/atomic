import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash } from "../../packages/workflows/src/durable/backend.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { JournalTestDatabase } from "../helpers/journal-database.js";
import { readJournalEntries } from "../helpers/journal-internals.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { mockSession } from "./executor-shared.js";
import { buildCtx, registerWorkflowCommand } from "./slash-dispatch-utils.js";

const ROOT_ID = "2603abcd-1111-4222-8333-123456789abc";
const CHILD_ID = "2603abcd-2222-4222-8333-123456789abc";

let savedStageSubagentGuard: string | undefined;

beforeEach(() => {
	store.clear();
	savedStageSubagentGuard = process.env.ATOMIC_WORKFLOW_STAGE_SUBAGENT_GUARD;
	delete process.env.ATOMIC_WORKFLOW_STAGE_SUBAGENT_GUARD;
});
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
	if (savedStageSubagentGuard === undefined) delete process.env.ATOMIC_WORKFLOW_STAGE_SUBAGENT_GUARD;
	else process.env.ATOMIC_WORKFLOW_STAGE_SUBAGENT_GUARD = savedStageSubagentGuard;
	vi.restoreAllMocks();
});

describe("targeted durable workflow inspection", () => {
	test("rejects malformed truncations before loading the durable catalog", async () => {
		const backend = await createMemoryTestBackend();
		backend.prepareWorkflowCatalog = async () => {
			throw new Error("malformed selectors must not load the durable catalog");
		};

		const result = await inspectTargetedDurableWorkflow(backend, "2603abcd-1111");
		assert.equal(result.kind, "malformed");
		assert.match(result.message, /full 36-character UUID or a unique 8-character hexadecimal prefix/);
	});

	test("resolves a unique 8-hex durable prefix and reports catalog collisions", async () => {
		// Regression: #2603 — status/stage/transcript durable inspection shares the UUID-prefix contract.
		const backend = await createMemoryTestBackend();
		const firstId = "2603abcd-1111-4222-8333-123456789abc";
		const secondId = "2603abcd-9999-4222-8333-123456789abc";
		const seed = async (workflowId: string) => {
			await backend.commitWorkflowRegistration({
				workflowId,
				name: workflowId,
				inputs: {},
				createdAt: 1,
				status: "paused",
				completedCheckpoints: 1,
			});
			await backend.commitCheckpoint({
				topology: { version: 1, nodeId: `tool:${`proof:${workflowId}`}`, ordinal: 1, order: 1, parentIds: [] },
				kind: "tool",
				workflowId,
				checkpointId: `tool:${workflowId}`,
				name: "proof",
				argsHash: `proof:${workflowId}`,
				output: true,
				completedAt: 2,
			});
		};
		await seed(firstId);

		const unique = await inspectTargetedDurableWorkflow(backend, "2603abcd");
		assert.equal(unique.kind, "found");
		if (unique.kind === "found") assert.equal(unique.detail.runId, firstId);

		await seed(secondId);
		const ambiguous = await inspectTargetedDurableWorkflow(backend, "2603abcd");
		assert.equal(ambiguous.kind, "malformed");
		assert.match(ambiguous.message, /ambiguous/);
		assert.match(ambiguous.message, new RegExp(firstId));
		assert.match(ambiguous.message, new RegExp(secondId));
	});

	// #2603: resolve the durable root once even when its child shares the prefix.
	test.each([ROOT_ID, ROOT_ID.slice(0, 8)])("reads a released journal root via %s without writes", async (target) => {
		const writer = await JournalTestBackend.create();
		const staleAt = Date.now() - FOREIGN_LIVE_WORKFLOW_WINDOW_MS - 1;
		await writer.commitWorkflowRegistration({
			workflowId: ROOT_ID,
			name: "paper-writer",
			status: "running",
			createdAt: staleAt,
			inputs: { topic: "durability" },
		});
		await writer.commitCheckpoint({
			kind: "stage",
			workflowId: ROOT_ID,
			checkpointId: "boundary-start:phase-6",
			name: "workflow:paper-writer-phase-6",
			replayKey: "workflow:paper-writer-phase-6:1",
			completedAt: staleAt,
			topology: {
				version: 1,
				stageId: "phase-6-boundary",
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: { runId: ROOT_ID, runName: "paper-writer" },
				boundary: {
					version: 1,
					event: "start",
					status: "running",
					replayScope: "workflow:paper-writer-phase-6:1",
					alias: "paper-writer-phase-6",
					workflow: "paper-writer-phase-6",
					invocationFingerprint: "h00000000000000000000000000000000",
					child: {
						runId: CHILD_ID,
						runName: "paper-writer-phase-6",
						parentRunId: ROOT_ID,
						parentStageId: "phase-6-boundary",
						rootRunId: ROOT_ID,
					},
				},
			},
		});
		await writer.commitCheckpoint({
			kind: "stage",
			workflowId: ROOT_ID,
			checkpointId: "workflow:paper-writer-phase-6:1:stage-session:draft",
			name: "draft",
			replayKey: "workflow:paper-writer-phase-6:1:stage:draft:1",
			sessionId: "phase-6-session",
			sessionFile: "/tmp/retained-phase-6.jsonl",
			startedAt: staleAt - 30_000,
			durationMs: 30_000,
			completedAt: staleAt,
			topology: {
				version: 1,
				stageId: "draft",
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: {
					runId: CHILD_ID,
					runName: "paper-writer-phase-6",
					parentRunId: ROOT_ID,
					parentStageId: "phase-6-boundary",
					rootRunId: ROOT_ID,
				},
			},
		});
		const backend = await writer.reopen();
		const beforeInspection = await readJournalEntries(backend.journal, ROOT_ID);
		setDurableBackend(backend);
		const runtime = createExtensionRuntime({ store });
		const execute = makeExecuteWorkflowTool(runtime, () => undefined);

		const result = await execute({ action: "status", runId: target }, {} as never);

		assert.equal(result.action, "statusDetail");
		if (result.action !== "statusDetail" || "error" in result) assert.fail("expected durable run detail");
		assert.equal(result.detail.status, "crashed");
		assert.equal(result.detail.resumable, true);
		assert.match(result.detail.resumeGuidance ?? "", new RegExp(`/workflow resume ${ROOT_ID}`));
		assert.deepEqual(
			result.detail.stages.map((stage) => [stage.name, stage.status, stage.sessionId, stage.sessionFile]),
			[["draft", "running", "phase-6-session", "/tmp/retained-phase-6.jsonl"]],
		);
		const stages = await execute({ action: "stages", runId: target }, {} as never);
		assert.equal(stages.action, "stages");
		if (stages.action !== "stages") assert.fail("expected durable stage listing");
		assert.deepEqual(
			stages.stages.map((item) => [item.name, item.status]),
			[["draft", "running"]],
		);
		const stage = await execute({ action: "stage", runId: target, stageId: "draft" }, {} as never);
		assert.equal(stage.action, "stage");
		if (stage.action !== "stage" || stage.stage === undefined) assert.fail("expected durable stage detail");
		assert.equal(stage.runId, CHILD_ID);
		assert.equal(stage.stage.sessionId, "phase-6-session");

		const transcript = await execute({ action: "transcript", runId: target, stageId: "draft" }, {} as never);
		assert.equal(transcript.action, "transcript");
		if (transcript.action !== "transcript") assert.fail("expected durable transcript detail");
		assert.equal(transcript.runId, CHILD_ID);
		assert.equal(transcript.source, "snapshot");
		assert.equal(transcript.sessionFile, "/tmp/retained-phase-6.jsonl");
		const canonicalId = stages.stages[0]!.id;
		assert.equal(canonicalId, `${CHILD_ID}:draft`);
		assert.deepEqual(await execute({ action: "stage", runId: target, stageId: canonicalId }, {} as never), stage);
		assert.deepEqual(
			await execute({ action: "transcript", runId: target, stageId: canonicalId }, {} as never),
			transcript,
		);
		assert.deepEqual(store.runs(), [], "targeted durable inspection must not add foreign runs to session status");
		assert.deepEqual(await readJournalEntries(backend.journal, ROOT_ID), beforeInspection);

		const listing = await execute({ action: "status" }, {} as never);
		assert.equal(listing.action, "status");
		if (listing.action === "status") assert.deepEqual(listing.runs, []);
	});

	test("absent and deleted journal roots are absent to a fresh reader", async () => {
		const absentId = testRunId("targeted-absent");
		const deletedId = testRunId("targeted-deleted");
		const writer = await JournalTestBackend.create();
		await writer.commitWorkflowRegistration({
			workflowId: deletedId,
			name: "deleted",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		await writer.deleteWorkflow(deletedId);
		const observer = await writer.reopen();
		assert.equal((await inspectTargetedDurableWorkflow(observer, absentId)).kind, "absent");
		assert.equal((await inspectTargetedDurableWorkflow(observer, deletedId)).kind, "absent");
	});

	// #2603: read-only prefix inspection includes live runs owned by another session.
	test.each([false, true])("protects a fresh foreign owner without writes (prefix: %s)", async (prefix) => {
		const liveId = testRunId("targeted-foreign-live");
		const terminalId = testRunId("targeted-terminal");
		const owner = await JournalTestBackend.create();
		for (const [workflowId, status] of [
			[liveId, "running"],
			[terminalId, "completed"],
		] as const) {
			await owner.commitWorkflowRegistration({
				workflowId,
				name: workflowId,
				inputs: {},
				createdAt: Date.now(),
				status,
			});
			await owner.commitCheckpoint({
				kind: "stage",
				workflowId,
				checkpointId: "stage:work",
				name: "work",
				replayKey: "stage:work:1",
				output: "done",
				completedAt: Date.now(),
				topology: {
					version: 1,
					stageId: "work",
					parentIds: [],
					status: "completed",
					run: { runId: workflowId, runName: workflowId },
				},
			});
			if (status === "completed") await owner.commitWorkflowStatus(workflowId, status, 0, false);
		}
		const beforeInspection = await readJournalEntries(owner.journal, liveId);
		const observer = await JournalTestBackend.create(owner.databasePath);
		const live = await inspectTargetedDurableWorkflow(observer, prefix ? liveId.slice(0, 8) : liveId);
		const terminal = await inspectTargetedDurableWorkflow(observer, terminalId);

		assert.equal(live.kind, "found");
		if (live.kind === "found") {
			assert.equal(live.detail.status, "running");
			assert.equal(live.detail.resumable, false);
			assert.match(live.detail.resumeGuidance ?? "", /actively running in another Atomic session/);
		}
		assert.equal(terminal.kind, "found");
		if (terminal.kind === "found") assert.equal(terminal.detail.status, "completed");
		assert.deepEqual(await readJournalEntries(owner.journal, liveId), beforeInspection);
	});

	test("fails closed for cyclic, orphaned, and nonreciprocal retained topology", async () => {
		const cyclicId = testRunId("targeted-cyclic");
		const cyclic = await createMemoryTestBackend();
		await cyclic.commitWorkflowRegistration({
			workflowId: cyclicId,
			name: "cyclic",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		for (const [stageId, parentId] of [
			["left", "right"],
			["right", "left"],
		] as const) {
			await cyclic.commitCheckpoint({
				kind: "stage",
				workflowId: cyclicId,
				checkpointId: `stage-session:${stageId}`,
				name: stageId,
				replayKey: `stage:${stageId}:1`,
				sessionFile: `/${stageId}.jsonl`,
				completedAt: 2,
				topology: {
					version: 1,
					stageId,
					parentIds: [parentId],
					status: "running",
					run: { runId: cyclicId, runName: "cyclic" },
				},
			});
		}
		assert.equal((await inspectTargetedDurableWorkflow(cyclic, cyclicId)).kind, "malformed");

		const orphanRootId = testRunId("targeted-orphan-root");
		const orphanRunId = testRunId("targeted-orphan-child");
		const orphaned = await createMemoryTestBackend();
		await orphaned.commitWorkflowRegistration({
			workflowId: orphanRootId,
			name: "orphan-root",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		for (const [runId, parentRunId] of [
			[orphanRootId, undefined],
			[orphanRunId, "missing-parent"],
		] as const) {
			await orphaned.commitCheckpoint({
				kind: "stage",
				workflowId: orphanRootId,
				checkpointId: `stage-session:${runId}`,
				name: runId === orphanRootId ? "root-work" : "orphan-work",
				replayKey: `stage:${runId}:1`,
				sessionFile: `/${runId}.jsonl`,
				completedAt: 2,
				topology: {
					version: 1,
					stageId: runId === orphanRootId ? "root-work" : "orphan-work",
					parentIds: [],
					status: "running",
					run: {
						runId,
						runName: runId === orphanRootId ? "orphan-root" : "orphan-child",
						...(parentRunId === undefined
							? {}
							: { parentRunId, parentStageId: "missing-boundary", rootRunId: orphanRootId }),
					},
				},
			});
		}
		assert.equal((await inspectTargetedDurableWorkflow(orphaned, orphanRootId)).kind, "malformed");

		const rootId = testRunId("targeted-nonreciprocal-root");
		const childId = testRunId("targeted-nonreciprocal-child");
		const nonreciprocal = await createMemoryTestBackend();
		await nonreciprocal.commitWorkflowRegistration({
			workflowId: rootId,
			name: "root",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await nonreciprocal.commitCheckpoint({
			kind: "stage",
			workflowId: rootId,
			checkpointId: "boundary-start",
			name: "child",
			replayKey: "workflow:child:1",
			completedAt: 2,
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: [],
				status: "running",
				run: { runId: rootId, runName: "root" },
				boundary: {
					version: 1,
					event: "start",
					status: "running",
					replayScope: "workflow:child:1",
					alias: "child",
					workflow: "child",
					invocationFingerprint: "child-fingerprint",
					child: {
						runId: childId,
						runName: "child",
						parentRunId: rootId,
						parentStageId: "boundary",
						rootRunId: rootId,
					},
				},
			},
		});
		await nonreciprocal.commitCheckpoint({
			kind: "stage",
			workflowId: rootId,
			checkpointId: "child-session",
			name: "work",
			replayKey: "workflow:child:1:stage:work:1",
			sessionFile: "/child.jsonl",
			completedAt: 3,
			topology: {
				version: 1,
				stageId: "work",
				parentIds: [],
				status: "running",
				run: {
					runId: childId,
					runName: "child",
					parentRunId: rootId,
					parentStageId: "wrong-boundary",
					rootRunId: rootId,
				},
			},
		});
		assert.equal((await inspectTargetedDurableWorkflow(nonreciprocal, rootId)).kind, "malformed");
	});

	test("rejects active boundary identity and replay-scope ambiguity", async () => {
		const makeNested = async (suffix: string, invocationFingerprint: string, childReplayKey: string) => {
			const rootId = testRunId(`targeted-boundary-${suffix}`);
			const childId = testRunId(`targeted-child-${suffix}`);
			const backend = await createMemoryTestBackend();
			await backend.commitWorkflowRegistration({
				workflowId: rootId,
				name: "root",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			await backend.commitCheckpoint({
				kind: "stage",
				workflowId: rootId,
				checkpointId: "boundary-start",
				name: "workflow:child",
				replayKey: "workflow:child:1",
				completedAt: 2,
				topology: {
					version: 1,
					stageId: "boundary",
					parentIds: [],
					sourceOrder: 0,
					status: "running",
					run: { runId: rootId, runName: "root" },
					boundary: {
						version: 1,
						event: "start",
						status: "running",
						replayScope: "workflow:child:1",
						alias: "child",
						workflow: "child",
						invocationFingerprint,
						child: {
							runId: childId,
							runName: "child",
							parentRunId: rootId,
							parentStageId: "boundary",
							rootRunId: rootId,
						},
					},
				},
			});
			await backend.commitCheckpoint({
				kind: "stage",
				workflowId: rootId,
				checkpointId: "child-session",
				name: "work",
				replayKey: childReplayKey,
				sessionFile: "/tmp/retained-child.jsonl",
				completedAt: 3,
				topology: {
					version: 1,
					stageId: "work",
					parentIds: [],
					sourceOrder: 0,
					status: "running",
					run: {
						runId: childId,
						runName: "child",
						parentRunId: rootId,
						parentStageId: "boundary",
						rootRunId: rootId,
					},
				},
			});
			return { backend, rootId };
		};

		const escaped = await makeNested("escaped-scope", "h00000000000000000000000000000000", "stage:outside:1");
		assert.equal((await inspectTargetedDurableWorkflow(escaped.backend, escaped.rootId)).kind, "malformed");
	});

	test("rejects cycles across stages and tools", async () => {
		const toolCycleId = testRunId("targeted-tool-cycle");
		const toolCycle = await createMemoryTestBackend();
		await toolCycle.commitWorkflowRegistration({
			workflowId: toolCycleId,
			name: "tool-cycle",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		for (const [nodeId, parentId] of [
			["tool:left", "tool:right"],
			["tool:right", "tool:left"],
		] as const) {
			await toolCycle.commitCheckpoint({
				kind: "tool",
				workflowId: toolCycleId,
				checkpointId: nodeId,
				name: nodeId,
				argsHash: nodeId,
				output: true,
				completedAt: 2,
				topology: {
					version: 1,
					nodeId,
					ordinal: 1,
					order: 1,
					parentIds: [parentId],
					run: { runId: toolCycleId, runName: "tool-cycle" },
				},
			});
		}
		assert.equal((await inspectTargetedDurableWorkflow(toolCycle, toolCycleId)).kind, "malformed");

		const mixedId = testRunId("targeted-stage-tool-cycle");
		const mixed = await createMemoryTestBackend();
		await mixed.commitWorkflowRegistration({
			workflowId: mixedId,
			name: "mixed-cycle",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await mixed.commitCheckpoint({
			kind: "stage",
			workflowId: mixedId,
			checkpointId: "stage-session",
			name: "stage",
			replayKey: "stage:stage:1",
			sessionFile: "/tmp/retained-stage.jsonl",
			completedAt: 2,
			topology: {
				version: 1,
				stageId: "stage",
				parentIds: ["tool"],
				sourceOrder: 0,
				status: "running",
				run: { runId: mixedId, runName: "mixed-cycle" },
			},
		});
		await mixed.commitCheckpoint({
			kind: "tool",
			workflowId: mixedId,
			checkpointId: "tool",
			name: "tool",
			argsHash: "tool",
			output: true,
			completedAt: 3,
			topology: {
				version: 1,
				nodeId: "tool",
				ordinal: 1,
				order: 1,
				parentIds: ["stage"],
				run: { runId: mixedId, runName: "mixed-cycle" },
			},
		});
		assert.equal((await inspectTargetedDurableWorkflow(mixed, mixedId)).kind, "malformed");
	});

	test("rejects root ownership claims and conflicting tool run ownership", async () => {
		const rootClaimId = testRunId("targeted-root-claim");
		const rootClaim = await createMemoryTestBackend();
		await rootClaim.commitWorkflowRegistration({
			workflowId: rootClaimId,
			name: "root-claim",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await rootClaim.commitCheckpoint({
			kind: "stage",
			workflowId: rootClaimId,
			checkpointId: "root-stage",
			name: "work",
			replayKey: "stage:work:1",
			sessionFile: "/tmp/retained-root.jsonl",
			completedAt: 2,
			topology: {
				version: 1,
				stageId: "work",
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: {
					runId: rootClaimId,
					runName: "root-claim",
					parentRunId: "foreign",
					parentStageId: "foreign-stage",
					rootRunId: "foreign",
				},
			},
		});
		assert.equal((await inspectTargetedDurableWorkflow(rootClaim, rootClaimId)).kind, "malformed");

		const conflictId = testRunId("targeted-tool-owner-conflict");
		const conflict = await createMemoryTestBackend();
		await conflict.commitWorkflowRegistration({
			workflowId: conflictId,
			name: "owner-conflict",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		for (const [nodeId, runName] of [
			["left", "owner-conflict"],
			["right", "different-name"],
		] as const) {
			await conflict.commitCheckpoint({
				kind: "tool",
				workflowId: conflictId,
				checkpointId: nodeId,
				name: nodeId,
				argsHash: nodeId,
				output: true,
				completedAt: 2,
				topology: { version: 1, nodeId, ordinal: 1, order: 1, parentIds: [], run: { runId: conflictId, runName } },
			});
		}
		assert.equal((await inspectTargetedDurableWorkflow(conflict, conflictId)).kind, "malformed");
	});

	test("rejects empty or duplicate tool node ids while preserving distinct graph targets", async () => {
		const makeTools = async (suffix: string, nodeIds: readonly string[]) => {
			const runId = testRunId(`targeted-tool-ids-${suffix}`);
			const backend = await createMemoryTestBackend();
			await backend.commitWorkflowRegistration({
				workflowId: runId,
				name: "tool-ids",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			for (const [index, nodeId] of nodeIds.entries()) {
				await backend.commitCheckpoint({
					kind: "tool",
					workflowId: runId,
					checkpointId: `tool-${index}`,
					name: `tool-${index}`,
					argsHash: `args-${index}`,
					output: true,
					completedAt: index + 2,
					topology: {
						version: 1,
						nodeId,
						ordinal: index + 1,
						order: index + 1,
						parentIds: [],
						run: { runId, runName: "tool-ids" },
					},
				});
			}
			return { backend, runId };
		};

		for (const malformed of [await makeTools("empty", [""]), await makeTools("duplicate", ["same", "same"])]) {
			assert.equal((await inspectTargetedDurableWorkflow(malformed.backend, malformed.runId)).kind, "malformed");
		}
		const valid = await makeTools("valid", ["left", "right"]);
		const inspected = await inspectTargetedDurableWorkflow(valid.backend, valid.runId);
		assert.equal(inspected.kind, "found");
		if (inspected.kind === "found") {
			const ids = inspected.runs.flatMap((run) => run.toolNodes?.map((tool) => tool.id) ?? []);
			assert.deepEqual(ids, ["left", "right"]);
			assert.equal(new Set(ids).size, ids.length);
		}
	});

	test("keeps UI-only durable roots inspectable without fabricating graph nodes", async () => {
		const runId = testRunId("targeted-ui-only");
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "ui-only",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await backend.commitCheckpoint({
			kind: "ui",
			workflowId: runId,
			checkpointId: "ui:confirm",
			promptKind: "confirm",
			message: "Continue?",
			promptHash: "confirm",
			response: true,
			completedAt: 2,
		});

		const inspected = await inspectTargetedDurableWorkflow(backend, runId);
		assert.equal(inspected.kind, "found");
		if (inspected.kind === "found") {
			assert.deepEqual(inspected.runs[0]?.stages, []);
			assert.deepEqual(inspected.runs[0]?.toolNodes, []);
		}
	});

	test("returns deep-cloned durable runs that cannot mutate later inspection", async () => {
		const runId = testRunId("targeted-clone-isolation");
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "clone-isolation",
			inputs: { nested: { value: "original" } },
			createdAt: 1,
			status: "running",
		});
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "tool",
			name: "tool",
			argsHash: "tool",
			output: { nested: { value: "output" } },
			completedAt: 2,
			topology: {
				version: 1,
				nodeId: "tool",
				ordinal: 1,
				order: 1,
				parentIds: [],
				run: { runId, runName: "clone-isolation" },
			},
		});

		const first = await inspectTargetedDurableWorkflow(backend, runId);
		assert.equal(first.kind, "found");
		if (first.kind !== "found") assert.fail("expected first inspection");
		(first.runs[0]!.inputs.nested as { value: string }).value = "mutated";

		const second = await inspectTargetedDurableWorkflow(backend, runId);
		assert.equal(second.kind, "found");
		if (second.kind === "found") {
			assert.equal((second.runs[0]!.inputs.nested as { value: string }).value, "original");
		}
		assert.equal((backend.getWorkflow(runId)!.inputs.nested as { value: string }).value, "original");
	});

	test("replays a process-lost journal root exactly once only after explicit resume", async () => {
		let clock = 10_000;
		const sessionStore = new MemorySessionStore();
		await sessionStore.create(
			{ id: "lost-session", version: 4, createdAt: new Date().toISOString(), cwd: process.cwd() },
			[],
		);
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const workflowId = testRunId("targeted-process-loss-replay");
		const crashedOwner = await JournalTestBackend.create();
		await crashedOwner.commitWorkflowRegistration({
			workflowId,
			name: "process-loss-replay",
			inputs: {},
			createdAt: clock,
			status: "running",
		});
		const argsHash = durableHash({ name: "once", args: {}, ordinal: 1 });
		await crashedOwner.commitCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: `tool:${argsHash}`,
			name: "once",
			argsHash,
			output: "first-process-effect",
			completedAt: clock,
			topology: {
				version: 1,
				nodeId: "tool:once",
				ordinal: 1,
				order: 1,
				parentIds: [],
				startedAt: clock - 10,
				endedAt: clock,
				run: { runId: workflowId, runName: "process-loss-replay" },
			},
		});
		await crashedOwner.commitCheckpoint({
			kind: "stage",
			workflowId,
			checkpointId: "stage-session:long",
			name: "long",
			replayKey: "stage:long:1",
			sessionId: "lost-session",
			sessionFile: "/tmp/retained-lost-session.jsonl",
			startedAt: clock - 5,
			durationMs: 5,
			completedAt: clock,
			topology: {
				version: 1,
				stageId: "long",
				parentIds: ["tool:once"],
				sourceOrder: 1,
				status: "running",
				run: { runId: workflowId, runName: "process-loss-replay" },
			},
		});

		clock += FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1;
		const connection = new JournalTestDatabase(crashedOwner.databasePath);
		try {
			connection.run(
				"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? - 1",
				FOREIGN_LIVE_WORKFLOW_WINDOW_MS,
			);
		} finally {
			connection.close();
		}
		const recoverer = await JournalTestBackend.create(crashedOwner.databasePath);
		const inspected = await inspectTargetedDurableWorkflow(recoverer, workflowId);
		assert.equal(inspected.kind, "found");
		if (inspected.kind === "found") assert.equal(inspected.detail.status, "crashed");
		assert.equal(await recoverer.workflowOwnership(workflowId), "available");

		let sideEffects = 1;
		const finishResume = Promise.withResolvers<void>();
		const definition = workflow({
			name: "process-loss-replay",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("once", {}, async () => {
					sideEffects += 1;
					return "duplicate-effect";
				});
				await finishResume.promise;
				await ctx.stage("long").prompt("continue");
				return {};
			},
		});
		const resumedStore = createStore();
		const jobs = createJobTracker();
		let completion: Promise<void> | undefined;
		const resumed = await resumeDurableWorkflow(
			workflowId,
			{
				registry: createRegistry([definition]),
				baseRunOpts: {
					store: resumedStore,
					adapters: {
						sessionStore,
						agentSession: { create: async (options) => mockSession(options.sessionManager) },
					},
				},
				durableBackend: recoverer,
				jobs,
				onRunAccepted: (id) => {
					completion = jobs.get(id)?.promise;
				},
			},
			recoverer.listResumableWorkflows(),
		);
		try {
			assert.equal(resumed.ok, true);
			assert.equal(await recoverer.workflowOwnership(workflowId), "local");
		} finally {
			finishResume.resolve();
		}
		assert.ok(completion);
		await completion;
		const terminal = resumedStore.runs().find((run) => run.id === workflowId);
		assert.equal(terminal?.status, "completed");
		assert.equal(sideEffects, 1, "the completed tool checkpoint must replay without a duplicate effect");
		assert.equal(terminal?.toolNodes?.[0]?.status, "cached");
		assert.equal(await recoverer.workflowOwnership(workflowId), "available");
	});

	test("routes /workflow status with an exact missing-local id through durable inspection", async () => {
		const workflowId = testRunId("targeted-slash-status");
		const staleAt = Date.now() - FOREIGN_LIVE_WORKFLOW_WINDOW_MS - 1;
		const writer = await JournalTestBackend.create();
		await writer.commitWorkflowRegistration({
			workflowId,
			name: "slash-crashed",
			inputs: {},
			status: "running",
			createdAt: staleAt,
		});
		await writer.commitCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: "tool:done",
			name: "done",
			argsHash: "done",
			output: true,
			completedAt: staleAt,
			topology: {
				version: 1,
				nodeId: "tool:done",
				ordinal: 1,
				order: 1,
				parentIds: [],
				run: { runId: workflowId, runName: "slash-crashed" },
			},
		});
		setDurableBackend(await writer.reopen());
		const { workflowCmd, sent } = await registerWorkflowCommand();
		const { ctx } = buildCtx();

		await workflowCmd.options.handler(`status ${workflowId}`, ctx);

		const detail = sent.find(
			(message) =>
				typeof message.details === "object" &&
				message.details !== null &&
				"kind" in message.details &&
				message.details.kind === "detail",
		)?.details as { readonly detail?: { readonly status?: string; readonly runId?: string } } | undefined;
		assert.equal(detail?.detail?.runId, workflowId);
		assert.equal(detail?.detail?.status, "crashed");
		assert.deepEqual(store.runs(), []);
	});
});
