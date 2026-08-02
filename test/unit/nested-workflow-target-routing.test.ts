import assert from "node:assert/strict";
import { Key } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	resolveControlNodeTarget,
	resolveStageTarget,
	topLevelExpandedSnapshots,
} from "../../packages/workflows/src/extension/workflow-targets.js";
import {
	workflowInterruptAction,
	workflowPauseAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import {
	workflowStageResult,
	workflowTranscriptResult,
} from "../../packages/workflows/src/extension/workflow-tool-inspection.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { aggregateWorkflowRootRunId } from "../../packages/workflows/src/runs/background/workflow-lifecycle-aggregate.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import {
	createStageControlRegistry,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { testRunId } from "../helpers/run-id.js";

const fixtureRunId = (seed: string): string => testRunId(seed);

function stage(id: string, name = id): StageSnapshot {
	return { id, name, status: "running", parentIds: [], toolEvents: [], attachable: true };
}

function run(overrides: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "name" | "stages">): RunSnapshot {
	return {
		inputs: {},
		status: "running",
		startedAt: 1,
		...overrides,
	};
}

function seedSiblingChildren(targetStore: Store = store): void {
	targetStore.recordRunStart(
		run({
			id: fixtureRunId("root-run"),
			name: "root",
			stages: [
				{
					...stage("workflow:left", "left import"),
					workflowChildRun: { alias: "left", workflow: "worker", runId: fixtureRunId("child-left") },
				},
				{
					...stage("workflow:right", "right import"),
					workflowChildRun: { alias: "right", workflow: "worker", runId: fixtureRunId("child-right") },
				},
			],
		}),
	);
	targetStore.recordRunStart(
		run({
			id: fixtureRunId("child-left"),
			name: "worker",
			parentRunId: fixtureRunId("root-run"),
			parentStageId: "workflow:left",
			rootRunId: fixtureRunId("root-run"),
			stages: [stage("shared", "duplicate name"), stage("left-only", "repeated name")],
		}),
	);
	targetStore.recordRunStart(
		run({
			id: fixtureRunId("child-right"),
			name: "worker",
			parentRunId: fixtureRunId("root-run"),
			parentStageId: "workflow:right",
			rootRunId: fixtureRunId("root-run"),
			stages: [stage("shared", "duplicate name"), stage("right-only", "repeated name")],
		}),
	);
}

interface HandleCalls {
	pauses: number;
	resumes: string[];
	prompts: string[];
}

function liveHandle(runId: string, stageId: string, calls: HandleCalls): StageControlHandle {
	const state: { status: "running" | "paused" } = { status: "running" };
	return {
		runId,
		stageId,
		stageName: stageId,
		get status() {
			return state.status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async sendUserMessage(text, _options, beforeDelivery) {
			beforeDelivery?.();
			calls.prompts.push(text);
			return "prompt";
		},
		async prompt(text) {
			calls.prompts.push(text);
		},
		async steer() {},
		async followUp() {},
		async pause() {
			calls.pauses += 1;
			state.status = "paused";
		},
		async resume(message, beforeResume) {
			beforeResume?.();
			calls.resumes.push(message ?? "");
			state.status = "running";
		},
		subscribe() {
			return () => {};
		},
	};
}

beforeEach(() => {
	store.clear();
	stageControlRegistry.clear();
	seedSiblingChildren();
});

afterEach(() => {
	stageControlRegistry.clear();
	setDurableBackend(undefined);
	store.clear();
});
describe("nested workflow stage target routing", () => {
	test("duplicate child-local stage IDs are ambiguous instead of first-matched", () => {
		const result = resolveStageTarget(fixtureRunId("root-run"), "shared");

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(
			result.message,
			`Ambiguous stage identifier "shared" matches: worker:duplicate name (${fixtureRunId("child-left")}/shared), worker:duplicate name (${fixtureRunId("child-right")}/shared)`,
		);
	});

	test("exact virtual IDs and unique local IDs retain the owning child run", () => {
		assert.deepEqual(resolveStageTarget(fixtureRunId("root-run"), `${fixtureRunId("child-right")}:shared`), {
			ok: true,
			runId: fixtureRunId("child-right"),
			stageId: "shared",
		});
		assert.deepEqual(resolveStageTarget(fixtureRunId("root-run"), "left-only"), {
			ok: true,
			runId: fixtureRunId("child-left"),
			stageId: "left-only",
		});
	});

	test("exact stage and tool ids and names resolve without prefix fallback", () => {
		const toolRunId = fixtureRunId("tool-targets-root");
		store.recordRunStart(
			run({
				id: toolRunId,
				name: "tool-targets",
				stages: [stage("stage-id", "build-check")],
				toolNodes: [
					{
						kind: "tool",
						id: "tool:args-hash",
						name: "format-files",
						argsHash: "args-hash",
						ordinal: 0,
						parentIds: [],
						status: "running",
						attachable: false,
					},
				],
			}),
		);

		assert.deepEqual(resolveStageTarget(toolRunId, "stage-id"), {
			ok: true,
			runId: toolRunId,
			stageId: "stage-id",
		});
		assert.deepEqual(resolveStageTarget(toolRunId, "build-check"), {
			ok: true,
			runId: toolRunId,
			stageId: "stage-id",
		});
		assert.deepEqual(resolveControlNodeTarget(toolRunId, "tool:args-hash"), {
			ok: true,
			kind: "tool",
			runId: toolRunId,
			nodeId: "tool:args-hash",
			name: "format-files",
		});
		assert.deepEqual(resolveControlNodeTarget(toolRunId, "format-files"), {
			ok: true,
			kind: "tool",
			runId: toolRunId,
			nodeId: "tool:args-hash",
			name: "format-files",
		});
		assert.deepEqual(resolveStageTarget(toolRunId, "build"), {
			ok: false,
			message: `Stage not found in run ${toolRunId}: build`,
		});
	});

	test("repeated names remain ambiguous while partial names are rejected", () => {
		const byName = resolveStageTarget(fixtureRunId("root-run"), "repeated name");
		assert.equal(byName.ok, false);
		if (!byName.ok) {
			assert.equal(
				byName.message,
				`Ambiguous stage identifier "repeated name" matches: worker:repeated name (${fixtureRunId("child-left")}/left-only), worker:repeated name (${fixtureRunId("child-right")}/right-only)`,
			);
		}

		const byPartialName = resolveStageTarget(fixtureRunId("root-run"), "duplicate");
		assert.deepEqual(byPartialName, {
			ok: false,
			message: `Stage not found in run ${fixtureRunId("root-run")}: duplicate`,
		});
	});

	test("attach detach restores the exact sibling owner when local stage IDs collide", () => {
		const localStore = createStore();
		seedSiblingChildren(localStore);
		const pane = new WorkflowAttachPane({
			store: localStore,
			graphTheme: deriveGraphTheme({}),
			runId: fixtureRunId("root-run"),
			initialAttachRunId: fixtureRunId("child-right"),
			initialAttachStageId: "shared",
			onClose: () => {},
		});

		assert.equal(
			localStore.runs().find((candidate) => candidate.id === fixtureRunId("child-right"))?.stages[0]?.attached,
			true,
		);
		pane.handleInput(Key.ctrl("x"));
		assert.equal(pane._mode, "graph");
		pane.handleInput(Key.enter);

		assert.equal(pane._mode, "stage-chat");
		assert.equal(
			localStore.runs().find((candidate) => candidate.id === fixtureRunId("child-left"))?.stages[0]?.attached,
			undefined,
		);
		assert.equal(
			localStore.runs().find((candidate) => candidate.id === fixtureRunId("child-right"))?.stages[0]?.attached,
			true,
		);
		pane.dispose();
	});

	test("ownerless attach does not first-match an ambiguous child-local stage ID", () => {
		const localStore = createStore();
		seedSiblingChildren(localStore);
		const pane = new WorkflowAttachPane({
			store: localStore,
			graphTheme: deriveGraphTheme({}),
			runId: fixtureRunId("root-run"),
			initialAttachStageId: "shared",
			onClose: () => {},
		});

		assert.equal(pane._mode, "graph");
		assert.equal(pane._hasChatView, false);
		assert.deepEqual(
			localStore
				.runs()
				.flatMap((run) => run.stages)
				.filter((stage) => stage.attached),
			[],
		);

		assert.equal(
			localStore.runs().find((candidate) => candidate.id === fixtureRunId("child-left"))?.stages[0]?.attached,
			undefined,
		);
		assert.equal(
			localStore.runs().find((candidate) => candidate.id === fixtureRunId("child-right"))?.stages[0]?.attached,
			undefined,
		);
		pane.dispose();
	});

	test("aggregate root traversal follows the child's reciprocal owner instead of a stale first claim", () => {
		const localStore = createStore();
		localStore.recordRunStart(
			run({
				id: "stale-parent",
				name: "stale",
				stages: [
					{
						...stage("stale-boundary"),
						workflowChildRun: { alias: "stale", workflow: "worker", runId: "leaf-run" },
					},
				],
			}),
		);
		localStore.recordRunStart(
			run({
				id: "root-owner",
				name: "root-owner",
				stages: [
					{
						...stage("root-boundary"),
						status: "completed",
						workflowChild: {
							alias: "middle",
							workflow: "middle",
							runId: "middle-run",
							status: "completed",
							outputs: {},
						},
					},
				],
			}),
		);
		localStore.recordRunStart(
			run({
				id: "middle-run",
				name: "middle",
				parentRunId: "root-owner",
				parentStageId: "root-boundary",
				rootRunId: "root-owner",
				stages: [
					{
						...stage("leaf-boundary"),
						workflowChildRun: { alias: "leaf", workflow: "worker", runId: "leaf-run" },
					},
				],
			}),
		);
		localStore.recordRunStart(
			run({
				id: "leaf-run",
				name: "leaf",
				parentRunId: "middle-run",
				parentStageId: "leaf-boundary",
				rootRunId: "root-owner",
				stages: [stage("work")],
			}),
		);

		assert.equal(aggregateWorkflowRootRunId(localStore, "leaf-run"), "root-owner");
	});

	test("aggregate root uses the status-authoritative child reference when live and replay refs conflict", () => {
		const localStore = createStore();
		localStore.recordRunStart(
			run({
				id: "root-owner",
				name: "root-owner",
				stages: [
					{
						...stage("completed-boundary"),
						status: "completed",
						workflowChild: {
							alias: "replay",
							workflow: "worker",
							runId: "replay-child",
							status: "completed",
							outputs: {},
						},
						workflowChildRun: { alias: "stale-live", workflow: "worker", runId: "stale-live-child" },
					},
				],
			}),
		);
		for (const id of ["replay-child", "stale-live-child"]) {
			localStore.recordRunStart(
				run({
					id,
					name: id,
					parentRunId: "root-owner",
					parentStageId: "completed-boundary",
					rootRunId: "root-owner",
					stages: [stage("work")],
				}),
			);
		}

		assert.equal(aggregateWorkflowRootRunId(localStore, "replay-child"), "root-owner");
		assert.equal(aggregateWorkflowRootRunId(localStore, "stale-live-child"), "stale-live-child");
	});

	test("aggregate root rejects a present root mismatch while accepting an omitted legacy root", () => {
		const localStore = createStore();
		localStore.recordRunStart(
			run({
				id: "root-owner",
				name: "root-owner",
				stages: [
					{
						...stage("legacy-boundary"),
						workflowChildRun: { alias: "legacy", workflow: "worker", runId: "legacy-child" },
					},
					{
						...stage("mismatch-boundary"),
						workflowChildRun: { alias: "mismatch", workflow: "worker", runId: "mismatch-child" },
					},
				],
			}),
		);
		localStore.recordRunStart(
			run({
				id: "legacy-child",
				name: "legacy-child",
				parentRunId: "root-owner",
				parentStageId: "legacy-boundary",
				stages: [stage("work")],
			}),
		);
		localStore.recordRunStart(
			run({
				id: "mismatch-child",
				name: "mismatch-child",
				parentRunId: "root-owner",
				parentStageId: "mismatch-boundary",
				rootRunId: "unrelated-root",
				stages: [stage("work")],
			}),
		);

		assert.equal(aggregateWorkflowRootRunId(localStore, "legacy-child"), "root-owner");
		assert.equal(aggregateWorkflowRootRunId(localStore, "mismatch-child"), "mismatch-child");
	});

	test("aggregate root uses live refs only for active boundaries and none for failed or skipped boundaries", () => {
		const localStore = createStore();
		localStore.recordRunStart(
			run({
				id: "root-owner",
				name: "root-owner",
				stages: [
					{
						...stage("active"),
						workflowChildRun: { alias: "live", workflow: "worker", runId: "live" },
						workflowChild: {
							alias: "stale",
							workflow: "worker",
							runId: "stale",
							status: "completed",
							outputs: {},
						},
					},
					{
						...stage("failed"),
						status: "failed",
						workflowChildRun: { alias: "failed", workflow: "worker", runId: "failed" },
					},
					{
						...stage("skipped"),
						status: "skipped",
						workflowChildRun: { alias: "skipped", workflow: "worker", runId: "skipped" },
					},
				],
			}),
		);
		for (const [id, parentStageId] of [
			["live", "active"],
			["stale", "active"],
			["failed", "failed"],
			["skipped", "skipped"],
		]) {
			localStore.recordRunStart(
				run({
					id,
					name: id,
					parentRunId: "root-owner",
					parentStageId,
					rootRunId: "root-owner",
					stages: [stage("work")],
				}),
			);
		}

		assert.equal(aggregateWorkflowRootRunId(localStore, "live"), "root-owner");
		assert.equal(aggregateWorkflowRootRunId(localStore, "stale"), "stale");
		assert.equal(aggregateWorkflowRootRunId(localStore, "failed"), "failed");
		assert.equal(aggregateWorkflowRootRunId(localStore, "skipped"), "skipped");
	});

	test("public controls and inspection route an exact virtual ID to the true child owner", async () => {
		const leftCalls: HandleCalls = { pauses: 0, resumes: [], prompts: [] };
		const rightCalls: HandleCalls = { pauses: 0, resumes: [], prompts: [] };
		stageControlRegistry.register(liveHandle(fixtureRunId("child-left"), "shared", leftCalls));
		stageControlRegistry.register(liveHandle(fixtureRunId("child-right"), "shared", rightCalls));
		const target = { runId: fixtureRunId("root-run"), stageId: `${fixtureRunId("child-right")}:shared` };

		const inspected = workflowStageResult({ action: "stage", ...target });
		assert.equal(inspected.action, "stage");
		if (inspected.action !== "stage") return;
		assert.equal(inspected.runId, fixtureRunId("child-right"));
		assert.equal(inspected.stage?.id, "shared");

		const transcript = workflowTranscriptResult({ action: "transcript", ...target });
		assert.equal(transcript.action, "transcript");
		if (transcript.action !== "transcript") return;
		assert.equal(transcript.runId, fixtureRunId("child-right"));
		assert.equal(transcript.stageId, "shared");
		assert.equal(transcript.source, "live");

		const sent = await workflowSendAction({ action: "send", ...target, text: "right only" });
		assert.deepEqual(
			{ runId: sent.runId, stageId: sent.stageId, status: sent.status },
			{
				runId: fixtureRunId("child-right"),
				stageId: "shared",
				status: "ok",
			},
		);
		assert.deepEqual(leftCalls.prompts, []);
		assert.deepEqual(rightCalls.prompts, ["right only"]);

		const paused = await workflowPauseAction({ action: "pause", ...target });
		assert.equal(paused.action, "pause");
		assert.equal("runId" in paused ? paused.runId : undefined, fixtureRunId("child-right"));
		assert.equal(leftCalls.pauses, 0);
		assert.equal(rightCalls.pauses, 1);

		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: fixtureRunId("root-run"),
			rootWorkflowId: fixtureRunId("root-run"),
			name: "root",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		setDurableBackend(backend);
		const resumed = await workflowResumeAction(
			{ action: "resume", ...target, message: "continue right" },
			{
				getRuntime: () => {
					throw new Error("runtime should not be used for a live paused stage");
				},
				policy: {} as never,
				ensureWorkflowResourcesLoaded: () => {},
			},
		);
		assert.equal(resumed.action, "resume");
		assert.equal("runId" in resumed ? resumed.runId : undefined, fixtureRunId("child-right"));
		assert.deepEqual(rightCalls.resumes, ["continue right"]);

		const interrupted = await workflowInterruptAction({ action: "interrupt", ...target });
		assert.equal(interrupted.action, "interrupt");
		assert.equal("runId" in interrupted ? interrupted.runId : undefined, fixtureRunId("child-right"));
		assert.equal(leftCalls.pauses, 0);
		assert.equal(rightCalls.pauses, 2);
	});

	test("every public control surface reports ambiguity instead of routing duplicate local IDs", async () => {
		const target = { runId: fixtureRunId("root-run"), stageId: "shared" };
		const expected = `Ambiguous stage identifier "shared" matches: worker:duplicate name (${fixtureRunId("child-left")}/shared), worker:duplicate name (${fixtureRunId("child-right")}/shared)`;
		const pause = await workflowPauseAction({ action: "pause", ...target });
		const interrupt = await workflowInterruptAction({ action: "interrupt", ...target });
		const resume = await workflowResumeAction(
			{ action: "resume", ...target },
			{
				getRuntime: () => {
					throw new Error("ambiguous target must not reach runtime");
				},
				policy: {} as never,
				ensureWorkflowResourcesLoaded: () => {},
			},
		);
		const send = await workflowSendAction({ action: "send", ...target, text: "do not deliver" });
		const inspected = workflowStageResult({ action: "stage", ...target });
		const transcript = workflowTranscriptResult({ action: "transcript", ...target });

		assert.equal("message" in pause ? pause.message : undefined, expected);
		assert.equal("message" in interrupt ? interrupt.message : undefined, expected);
		assert.equal("message" in resume ? resume.message : undefined, expected);
		assert.equal(send.message, expected);
		assert.equal(inspected.action === "stage" ? inspected.error : undefined, expected);
		assert.equal(transcript.action === "transcript" ? transcript.entries[0]?.text : undefined, expected);
	});

	test("post-mortem revival dependencies are resolved for the nested stage owner", async () => {
		const nestedStage = store.runs().find((run) => run.id === fixtureRunId("child-right"))?.stages[0];
		assert.ok(nestedStage);
		store.recordStageEnd(fixtureRunId("child-right"), { ...nestedStage, status: "completed", result: "done" });
		let dependencyRunId: string | undefined;

		const result = await workflowSendAction(
			{
				action: "send",
				runId: fixtureRunId("root-run"),
				stageId: `${fixtureRunId("child-right")}:shared`,
				text: "continue retained chat",
			},
			{
				resolvePostMortemDeps: (runId) => {
					dependencyRunId = runId;
					return {
						registry: createStageControlRegistry(),
						adapters: {
							agentSession: {
								async create() {
									throw new Error("missing retained session must not create an agent");
								},
							},
						},
						cwd: process.cwd(),
					};
				},
			},
		);

		assert.equal(dependencyRunId, fixtureRunId("child-right"));
		assert.equal(result.runId, fixtureRunId("child-right"));
		assert.equal(result.stageId, "shared");
		assert.equal(result.status, "noop");
	});

	test("top-level expanded listings exclude both child and grandchild implementation runs", () => {
		store.recordRunStart(
			run({
				id: fixtureRunId("grandchild-run"),
				name: "grandchild",
				parentRunId: fixtureRunId("child-right"),
				parentStageId: "shared",
				rootRunId: fixtureRunId("root-run"),
				stages: [stage("grandchild-stage")],
			}),
		);

		assert.deepEqual(
			topLevelExpandedSnapshots().map((snapshot) => snapshot.id),
			[fixtureRunId("root-run")],
		);
	});
});
