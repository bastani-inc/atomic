import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	completedWorkflowRunSnapshots,
	completedWorkflowSnapshot,
	listCompletedFromBackend,
	listOpenableCompletedWorkflows,
	resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import {
	formatResumableWorkflowList,
	listResumableFromBackend,
} from "../../packages/workflows/src/durable/resume-catalog.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { testRunId } from "../helpers/run-id.js";

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-catalog-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeSessionTranscript(path: string, id: string): void {
	writeFileSync(
		path,
		`${[
			JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: `${id}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "prior context", timestamp: Date.now() },
			}),
		].join("\n")}\n`,
	);
}

function registerCompleted(backend: InMemoryDurableBackend, id: string): void {
	backend.registerWorkflow({
		workflowId: id,
		name: "completed-flow",
		inputs: { topic: "done" },
		createdAt: 10,
		updatedAt: 30,
		status: "completed",
	});
}

describe("completed durable catalog", () => {
	test("keeps completed listing distinct from resumability predicates", () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: testRunId("paused"),
			name: "paused-flow",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		registerCompleted(backend, testRunId("completed"));
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: testRunId("completed"),
			checkpointId: "tool:1",
			name: "read",
			argsHash: "hash",
			output: "ok",
			completedAt: 20,
		});

		assert.deepEqual(
			listResumableFromBackend(backend).map((entry) => entry.workflowId),
			[testRunId("paused")],
		);
		assert.deepEqual(
			listCompletedFromBackend(backend).map((entry) => entry.workflowId),
			[testRunId("completed")],
		);
	});
	test("formats full workflow ids in resume target lists", () => {
		const workflowId = "bb22cc33-44dd-55ee-66ff-778899001122";
		const rendered = formatResumableWorkflowList([
			{
				workflowId,
				name: "resumable-flow",
				status: "paused",
				completedCheckpoints: 1,
				pendingPrompts: 0,
				createdAt: 1,
				updatedAt: 2,
			},
		]);
		assert.ok(rendered.includes(workflowId));
	});

	test("keeps completed graphs inspectable while stripping stale retained chat", () => {
		const backend = new InMemoryDurableBackend();
		const transcript = join(tempDir, "stage.jsonl");
		writeSessionTranscript(transcript, "valid-session");
		registerCompleted(backend, testRunId("valid-completed"));
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("valid-completed"),
			checkpointId: "stage:1",
			name: "summarize",
			replayKey: "stage:summarize:1",
			output: "finished",
			sessionFile: transcript,
			model: "provider/model",
			completedAt: 20,
		});
		registerCompleted(backend, testRunId("stale-completed"));
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("stale-completed"),
			checkpointId: "stage:1",
			name: "missing",
			replayKey: "stage:missing:1",
			sessionFile: join(tempDir, "missing.jsonl"),
			completedAt: 20,
		});

		assert.deepEqual(
			new Set(listOpenableCompletedWorkflows(backend).map((entry) => entry.workflowId)),
			new Set([testRunId("valid-completed"), testRunId("stale-completed")]),
		);
		const entries = listCompletedFromBackend(backend);
		const snapshot = completedWorkflowSnapshot(
			backend,
			entries.find((entry) => entry.workflowId === testRunId("valid-completed"))!,
		);
		assert.equal(snapshot?.status, "completed");
		assert.equal(snapshot?.stages[0]?.result, "finished");
		assert.equal(snapshot?.stages[0]?.model, "provider/model");
		const stale = completedWorkflowSnapshot(
			backend,
			entries.find((entry) => entry.workflowId === testRunId("stale-completed"))!,
		);
		assert.equal(stale?.stages[0]?.sessionFile, undefined);
		assert.equal(resolveCompletedWorkflow(testRunId("stale-completed"), backend).kind, "found");
	});

	test("keeps completed graphs open without retained chat and opens tool-only runs read-only", () => {
		const backend = new InMemoryDurableBackend();
		const cases = [
			{ id: testRunId("no-session"), sessionFile: undefined },
			{ id: testRunId("empty-session"), sessionFile: join(tempDir, "empty.jsonl") },
			{ id: testRunId("malformed-session"), sessionFile: join(tempDir, "malformed.jsonl") },
			{ id: testRunId("directory-session"), sessionFile: join(tempDir, "directory.jsonl") },
			{ id: testRunId("header-only"), sessionFile: join(tempDir, "header-only.jsonl") },
			{ id: testRunId("invalid-message"), sessionFile: join(tempDir, "invalid-message.jsonl") },
		] as const;
		writeFileSync(cases[1].sessionFile, "");
		writeFileSync(cases[2].sessionFile, "not-json\n");
		mkdirSync(cases[3].sessionFile);
		writeFileSync(cases[4].sessionFile, `${JSON.stringify({ type: "session", id: testRunId("header-only") })}\n`);
		writeFileSync(
			cases[5].sessionFile,
			[
				JSON.stringify({ type: "session", id: testRunId("invalid-message") }),
				JSON.stringify({ type: "message" }),
			].join("\n"),
		);
		for (const item of cases) {
			registerCompleted(backend, item.id);
			backend.recordCheckpoint({
				kind: "stage",
				workflowId: item.id,
				checkpointId: "stage:1",
				name: "final",
				replayKey: "stage:final:1",
				...(item.sessionFile === undefined ? {} : { sessionFile: item.sessionFile }),
				completedAt: 20,
			});
		}
		registerCompleted(backend, testRunId("tool-only"));
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: testRunId("tool-only"),
			checkpointId: "tool:1",
			name: "read",
			argsHash: "hash",
			output: "ok",
			completedAt: 20,
		});

		const ids = listOpenableCompletedWorkflows(backend).map((entry) => entry.workflowId);
		assert.deepEqual(new Set(ids), new Set([...cases.map((item) => item.id), testRunId("tool-only")]));
		for (const item of cases) assert.equal(resolveCompletedWorkflow(item.id, backend).kind, "found");
		const toolOnly = resolveCompletedWorkflow(testRunId("tool-only"), backend);
		assert.equal(toolOnly.kind, "found");
		if (toolOnly.kind === "found") {
			assert.equal(toolOnly.snapshot.stages.length, 0);
			assert.deepEqual(
				toolOnly.snapshot.toolNodes?.map((node) => ({
					name: node.name,
					status: node.status,
					attachable: node.attachable,
				})),
				[{ name: "read", status: "cached", attachable: false }],
			);
		}
	});

	test("validates the retained transcript after merging repeated stage checkpoints", () => {
		const backend = new InMemoryDurableBackend();
		const validTranscript = join(tempDir, "retained.jsonl");
		writeSessionTranscript(validTranscript, "retained-session");
		registerCompleted(backend, testRunId("merged-stage"));
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("merged-stage"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: join(tempDir, "obsolete-missing.jsonl"),
			completedAt: 20,
			topology: { version: 1, stageId: "final-source", parentIds: [], sourceOrder: 0, status: "completed" },
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("merged-stage"),
			checkpointId: "stage:2",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: validTranscript,
			output: "done",
			completedAt: 30,
			topology: { version: 1, stageId: "final-source", parentIds: [], sourceOrder: 0, status: "completed" },
		});

		assert.deepEqual(
			listOpenableCompletedWorkflows(backend).map((entry) => entry.workflowId),
			[testRunId("merged-stage")],
		);
		assert.equal(
			completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!)?.stages[0]?.sessionFile,
			validTranscript,
		);
	});

	test("keeps a completed workflow when at least one stage has a usable transcript", () => {
		const backend = new InMemoryDurableBackend();
		const validTranscript = join(tempDir, "usable.jsonl");
		writeSessionTranscript(validTranscript, "usable-session");
		registerCompleted(backend, testRunId("partially-retained"));
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("partially-retained"),
			checkpointId: "stage:1",
			name: "retained",
			replayKey: "stage:retained:1",
			sessionFile: validTranscript,
			completedAt: 20,
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("partially-retained"),
			checkpointId: "stage:2",
			name: "stale",
			replayKey: "stage:stale:1",
			sessionFile: join(tempDir, "missing.jsonl"),
			completedAt: 21,
		});

		const snapshot = completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!);
		assert.deepEqual(
			listOpenableCompletedWorkflows(backend).map((item) => item.workflowId),
			[testRunId("partially-retained")],
		);
		assert.equal(snapshot?.stages[0]?.sessionFile, validTranscript);
		assert.equal(snapshot?.stages[1]?.sessionFile, undefined);
	});

	test("strips partially malformed and context-empty transcripts without hiding the graph", () => {
		const backend = new InMemoryDurableBackend();
		const malformed = join(tempDir, "partially-malformed.jsonl");
		writeFileSync(
			malformed,
			[
				JSON.stringify({ type: "session", id: testRunId("partially-malformed") }),
				JSON.stringify({
					type: "message",
					id: "valid",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "context" },
				}),
				"not-json",
			].join("\n"),
		);
		const emptyContent = [
			{ id: testRunId("blank-string"), content: "   " },
			{ id: testRunId("empty-array"), content: [] },
			{ id: testRunId("empty-object"), content: {} },
			{ id: testRunId("empty-block"), content: [{}] },
			{ id: testRunId("blank-text-block"), content: [{ type: "text", text: "" }] },
		] as const;
		registerCompleted(backend, testRunId("partially-malformed"));
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("partially-malformed"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: malformed,
			completedAt: 20,
		});
		for (const item of emptyContent) {
			const path = join(tempDir, `${item.id}.jsonl`);
			writeFileSync(
				path,
				[
					JSON.stringify({ type: "session", id: item.id }),
					JSON.stringify({
						type: "message",
						id: `${item.id}-message`,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: item.content },
					}),
				].join("\n"),
			);
			registerCompleted(backend, item.id);
			backend.recordCheckpoint({
				kind: "stage",
				workflowId: item.id,
				checkpointId: "stage:1",
				name: "final",
				replayKey: "stage:final:1",
				sessionFile: path,
				completedAt: 20,
			});
		}

		const entries = listOpenableCompletedWorkflows(backend);
		assert.deepEqual(
			new Set(entries.map((entry) => entry.workflowId)),
			new Set([testRunId("partially-malformed"), ...emptyContent.map((item) => item.id)]),
		);
		for (const entry of entries)
			assert.equal(completedWorkflowSnapshot(backend, entry)?.stages[0]?.sessionFile, undefined);
	});

	test("accepts a retained transcript with a meaningful structured content block", () => {
		const backend = new InMemoryDurableBackend();
		const path = join(tempDir, "structured-context.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ type: "session", id: testRunId("structured-context") }),
				JSON.stringify({
					type: "message",
					id: "structured-context-message",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "retained context" }] },
				}),
			].join("\n"),
		);
		registerCompleted(backend, testRunId("structured-context"));
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("structured-context"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: path,
			completedAt: 20,
		});

		assert.deepEqual(
			listOpenableCompletedWorkflows(backend).map((item) => item.workflowId),
			[testRunId("structured-context")],
		);
	});

	test("reconstructs nested parallel runs and accumulated completed duration", () => {
		const backend = new InMemoryDurableBackend();
		const transcript = join(tempDir, "nested-child.jsonl");
		writeSessionTranscript(transcript, "nested-child-session");
		const runId = testRunId("completed-nested");
		const childRunId = testRunId("completed-nested-child");
		backend.registerWorkflow({
			workflowId: runId,
			name: "nested-root",
			inputs: {},
			createdAt: 1_000,
			updatedAt: 50_000,
			status: "completed",
		});
		const rootRun = { runId, runName: "nested-root" } as const;
		const childRun = {
			runId: childRunId,
			runName: "parallel-child",
			parentRunId: runId,
			parentStageId: "boundary",
			rootRunId: runId,
		} as const;
		const childOutput = {
			workflow: "parallel-child",
			runId: childRunId,
			status: "completed",
			exited: false,
			outputs: { value: "ok" },
		} as const;
		for (const checkpoint of [
			{
				checkpointId: "root-before",
				name: "before",
				replayKey: "before",
				output: "before",
				topology: { version: 1 as const, stageId: "before", parentIds: [], run: rootRun },
			},
			{
				checkpointId: "root-boundary",
				name: "workflow:parallel-child",
				replayKey: "boundary",
				output: childOutput,
				topology: { version: 1 as const, stageId: "boundary", parentIds: ["before"], run: rootRun },
			},
			{
				checkpointId: "child-left",
				name: "left",
				replayKey: "child:left",
				output: "left",
				sessionFile: transcript,
				topology: { version: 1 as const, stageId: "left", parentIds: [], run: childRun },
			},
			{
				checkpointId: "child-right",
				name: "right",
				replayKey: "child:right",
				output: "right",
				topology: { version: 1 as const, stageId: "right", parentIds: [], run: childRun },
			},
			{
				checkpointId: "root-after",
				name: "after",
				replayKey: "after",
				output: "after",
				topology: { version: 1 as const, stageId: "after", parentIds: ["boundary"], run: rootRun },
			},
			// Prior resume attempts can leave terminal orphan child scopes and an unfinished
			// downstream stage whose parent source id predates cached-boundary replay.
			{
				checkpointId: "orphan-child",
				name: "orphan",
				replayKey: "old-child:orphan",
				output: "old",
				topology: {
					version: 1 as const,
					stageId: "orphan",
					parentIds: [],
					run: { ...childRun, runId: testRunId("old-child-run") },
				},
			},
			{
				checkpointId: "abandoned-after",
				name: "abandoned",
				replayKey: "abandoned",
				startedAt: 2_000,
				topology: { version: 1 as const, stageId: "abandoned", parentIds: ["old-boundary-id"], run: rootRun },
			},
		]) {
			backend.recordCheckpoint({ kind: "stage", workflowId: runId, completedAt: 2_000, ...checkpoint });
		}
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "run-timing:12345",
			name: "workflow-run-timing",
			argsHash: "workflow-run-timing",
			output: { elapsedMs: 12_345 },
			completedAt: 3_000,
		});

		const entry = listCompletedFromBackend(backend)[0]!;
		const runs = completedWorkflowRunSnapshots(backend, entry);
		assert.equal(runs.length, 2);
		const root = runs.find((run) => run.id === runId)!;
		const childSnapshot = runs.find((run) => run.id === childRunId)!;
		assert.equal(childSnapshot.parentStageId, root.stages.find((stage) => stage.replayKey === "boundary")?.id);
		assert.equal(completedWorkflowSnapshot(backend, entry)?.durationMs, 12_345);
		const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, runId);
		assert.deepEqual(
			graph.stages.map((stage) => stage.name),
			["before", "left", "right", "after"],
		);
		const before = graph.stages.find((stage) => stage.name === "before")!;
		const left = graph.stages.find((stage) => stage.name === "left")!;
		const right = graph.stages.find((stage) => stage.name === "right")!;
		const after = graph.stages.find((stage) => stage.name === "after")!;
		assert.deepEqual(left.parentIds, [before.id]);
		assert.deepEqual(right.parentIds, [before.id]);
		assert.deepEqual(new Set(after.parentIds), new Set([left.id, right.id]));
	});

	test("hides duplicate boundary-start records instead of inventing a child link", () => {
		const backend = new InMemoryDurableBackend();
		registerCompleted(backend, testRunId("duplicate-boundary"));
		const rootRun = { runId: testRunId("duplicate-boundary"), runName: "completed-flow" } as const;
		const child = {
			runId: testRunId("duplicate-child"),
			runName: "child",
			parentRunId: "duplicate-boundary",
			parentStageId: "boundary",
			rootRunId: "duplicate-boundary",
		} as const;
		const boundary = {
			version: 1 as const,
			replayScope: "workflow:child:1",
			alias: "child",
			workflow: "child",
			child,
		};
		for (const checkpointId of ["boundary-start:a", "boundary-start:b"]) {
			backend.recordCheckpoint({
				kind: "stage",
				workflowId: testRunId("duplicate-boundary"),
				checkpointId,
				name: "workflow:child",
				replayKey: "workflow:child:1",
				completedAt: 20,
				topology: {
					version: 1,
					stageId: "boundary",
					parentIds: [],
					sourceOrder: 0,
					status: "running",
					run: rootRun,
					boundary: { ...boundary, event: "start", status: "running" },
				},
			});
		}

		assert.equal(listOpenableCompletedWorkflows(backend).length, 0);
		assert.equal(resolveCompletedWorkflow(testRunId("duplicate-boundary"), backend).kind, "stale");
		assert.equal(completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!), undefined);
	});

	test("hides cyclic and duplicated stage topology", () => {
		const backend = new InMemoryDurableBackend();
		registerCompleted(backend, testRunId("cyclic"));
		for (const [stageId, parentIds] of [
			["a", ["b"]],
			["b", ["a"]],
		] as const) {
			backend.recordCheckpoint({
				kind: "stage",
				workflowId: testRunId("cyclic"),
				checkpointId: `stage:${stageId}`,
				name: stageId,
				replayKey: `stage:${stageId}:1`,
				output: stageId,
				completedAt: 20,
				topology: {
					version: 1,
					stageId,
					parentIds: [...parentIds],
					run: { runId: testRunId("cyclic"), runName: "completed-flow" },
				},
			});
		}
		registerCompleted(backend, testRunId("duplicate-stage-id"));
		for (const replayKey of ["stage:one:1", "stage:two:1"]) {
			backend.recordCheckpoint({
				kind: "stage",
				workflowId: testRunId("duplicate-stage-id"),
				checkpointId: replayKey,
				name: "shared",
				replayKey,
				output: "ok",
				completedAt: 20,
				topology: {
					version: 1,
					stageId: "shared-source-id",
					parentIds: [],
					run: { runId: testRunId("duplicate-stage-id"), runName: "completed-flow" },
				},
			});
		}

		assert.equal(listOpenableCompletedWorkflows(backend).length, 0);
		assert.equal(resolveCompletedWorkflow(testRunId("cyclic"), backend).kind, "stale");
		assert.equal(resolveCompletedWorkflow(testRunId("duplicate-stage-id"), backend).kind, "stale");
	});

	test("hides a boundary terminal that disagrees with its start identity", () => {
		const backend = new InMemoryDurableBackend();
		registerCompleted(backend, testRunId("mismatched-terminal"));
		const rootRun = { runId: testRunId("mismatched-terminal"), runName: "completed-flow" } as const;
		const child = {
			runId: testRunId("child-from-start"),
			runName: "child",
			parentRunId: "mismatched-terminal",
			parentStageId: "boundary",
			rootRunId: "mismatched-terminal",
		} as const;
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("mismatched-terminal"),
			checkpointId: "boundary-start:workflow:child:1",
			name: "workflow:child",
			replayKey: "workflow:child:1",
			completedAt: 20,
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: rootRun,
				boundary: {
					version: 1,
					event: "start",
					replayScope: "workflow:child:1",
					alias: "child",
					workflow: "child",
					status: "running",
					child,
				},
			},
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("mismatched-terminal"),
			checkpointId: "boundary-terminal:workflow:child:1:completed",
			name: "workflow:child",
			replayKey: "workflow:child:1",
			completedAt: 21,
			endedAt: 21,
			output: {
				workflow: "child",
				runId: testRunId("unrelated-child"),
				status: "completed",
				exited: false,
				outputs: {},
			},
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: rootRun,
				boundary: {
					version: 1,
					event: "terminal",
					replayScope: "workflow:child:1",
					alias: "child",
					workflow: "child",
					status: "completed",
					child: { ...child, runId: testRunId("unrelated-child") },
				},
			},
		});

		assert.equal(listOpenableCompletedWorkflows(backend).length, 0);
		assert.equal(resolveCompletedWorkflow(testRunId("mismatched-terminal"), backend).kind, "stale");
	});
	test("marks a completed root stale when a current boundary start has no terminal", () => {
		const backend = new InMemoryDurableBackend();
		const runId = testRunId("unterminated-completed-root");
		const childRunId = testRunId("unterminated-child");
		const replayKey = "workflow:child:1";
		registerCompleted(backend, runId);
		const rootRun = { runId, runName: "completed-flow" } as const;
		const child = {
			runId: childRunId,
			runName: "child",
			parentRunId: runId,
			parentStageId: "boundary",
			rootRunId: runId,
		} as const;
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage:root",
			name: "root-stage",
			replayKey: "stage:root:1",
			output: "done",
			completedAt: 20,
			topology: {
				version: 1,
				stageId: "root-stage",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: rootRun,
			},
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `boundary-start:${replayKey}`,
			name: "workflow:child",
			replayKey,
			completedAt: 21,
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: ["root-stage"],
				sourceOrder: 1,
				status: "running",
				run: rootRun,
				boundary: {
					version: 1,
					event: "start",
					replayScope: replayKey,
					alias: "child",
					workflow: "child",
					status: "running",
					child,
				},
			},
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `${replayKey}:stage:child:1`,
			name: "child-stage",
			replayKey: `${replayKey}:stage:child:1`,
			output: "child-done",
			completedAt: 22,
			topology: {
				version: 1,
				stageId: "child-stage",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: {
					runId: childRunId,
					runName: "child",
					parentRunId: runId,
					parentStageId: "boundary",
					rootRunId: runId,
				},
			},
		});

		assert.deepEqual(completedWorkflowRunSnapshots(backend, listCompletedFromBackend(backend)[0]!), []);
		assert.deepEqual(listOpenableCompletedWorkflows(backend), []);
		assert.equal(resolveCompletedWorkflow(runId, backend).kind, "stale");
	});
});
