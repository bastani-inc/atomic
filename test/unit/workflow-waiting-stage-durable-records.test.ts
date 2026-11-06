import { beforeEach, describe, test } from "vitest";
import {
	createDurableStagePrimitive,
	createStageReplayKeyGenerator,
	type DurableStageDeps,
	durableRecordedToolResults,
	durableWaitingStages,
	latestStageSessionCheckpoints,
	recordStageCheckpoint,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import {
	createCheckpointIdGenerator,
	recordCheckpointDurably,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableReleasedStageResume, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { StageWaitKind } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { StageContext, StageOptions } from "../../packages/workflows/src/shared/types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert } from "./executor-shared.js";

const WORKFLOW_ID = "wf-waiting-records";

type Backend = Awaited<ReturnType<typeof createMemoryTestBackend>>;

let backend: Backend;

beforeEach(async () => {
	backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: WORKFLOW_ID,
		name: "waiting-records",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
});

function deps(now: number): DurableStageDeps {
	return {
		workflowId: WORKFLOW_ID,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
		now: () => now,
	};
}

function stageSnapshot(name: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id: `id-${name}`,
		name,
		replayKey: `stage:${name}:1`,
		status: "completed",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		result: `${name} done`,
		sessionId: `session-${name}`,
		...overrides,
	};
}

/** The record `stage_waiting` writes: the stage waits released, its session named, `since` the moment it released. */
function waitingSnapshot(
	name: string,
	kind: StageWaitKind,
	since: number,
	promptsCompleted: number | undefined,
	overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
	return stageSnapshot(name, {
		status: "waiting",
		wait: { kind, since, ...(promptsCompleted === undefined ? {} : { promptsCompleted }) },
		...overrides,
	});
}

function rawSessionRecord(
	replayKey: string,
	checkpointId: string,
	completedAt: number,
	overrides: Partial<DurableStageCheckpoint> = {},
): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: WORKFLOW_ID,
		checkpointId,
		name: replayKey,
		replayKey,
		sessionId: `session-of-${replayKey}`,
		completedAt,
		...overrides,
	};
}

describe("the stages a stopped run left waiting, from its records (#4309)", () => {
	test("the latest session record of each stage says whether it still waits, and on what (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(1_000), stageSnapshot("alpha", { status: "running" }), { force: true });
		await recordStageSessionCheckpoint(
			deps(2_000),
			waitingSnapshot("alpha", "release", 2_000, 1, { sessionFile: "/sessions/alpha.jsonl" }),
			{ force: true },
		);
		await recordStageSessionCheckpoint(deps(2_000), waitingSnapshot("beta", "tool", 2_000, 0), { force: true });
		// Woken since: its latest record has no wait.
		await recordStageSessionCheckpoint(deps(2_000), waitingSnapshot("gamma", "idle", 2_000, 1), { force: true });
		await recordStageSessionCheckpoint(deps(3_000), stageSnapshot("gamma", { status: "running" }), { force: true });
		// A completed record with no session, and a tool record, say nothing about waiting.
		await recordStageCheckpoint(deps(2_500), stageSnapshot("delta", { sessionId: undefined }));

		const waiting = durableWaitingStages(backend, WORKFLOW_ID);
		assert.deepEqual(
			waiting.map((stage) => stage.stageName),
			["alpha", "beta"],
		);
		assert.deepEqual(waiting[0], {
			replayKey: "stage:alpha:1",
			stageName: "alpha",
			stageId: "id-alpha",
			sessionId: "session-alpha",
			sessionFile: "/sessions/alpha.jsonl",
			wait: { kind: "release", since: 2_000, promptsCompleted: 1 },
		});
		// No file kept: the key is absent, not undefined.
		assert.deepEqual(waiting[1], {
			replayKey: "stage:beta:1",
			stageName: "beta",
			stageId: "id-beta",
			sessionId: "session-beta",
			wait: { kind: "tool", since: 2_000, promptsCompleted: 0 },
		});
		assert.equal(Object.hasOwn(waiting[1]!, "sessionFile"), false);
	});

	test("a record that arrives later wins, and of two records written at the same time the later one wins (#4309)", async () => {
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:tie:1", "c1", 5_000, { wait: { kind: "release", since: 5_000 } }),
		);
		await recordCheckpointDurably(backend, rawSessionRecord("stage:tie:1", "c2", 5_000));
		await recordCheckpointDurably(backend, rawSessionRecord("stage:newer:1", "c3", 9_000));
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:newer:1", "c4", 8_000, { wait: { kind: "release", since: 8_000 } }),
		);
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:nosession:1", "c5", 5_000, {
				sessionId: undefined,
				wait: { kind: "idle", since: 5_000 },
			}),
		);

		const latest = latestStageSessionCheckpoints(backend, WORKFLOW_ID);
		assert.deepEqual([...latest.keys()].sort(), ["stage:newer:1", "stage:tie:1"]);
		assert.equal(latest.get("stage:tie:1")?.checkpointId, "c2");
		assert.equal(latest.get("stage:newer:1")?.checkpointId, "c3");
		assert.deepEqual(durableWaitingStages(backend, WORKFLOW_ID), []);
	});

	test("a wait without a session, or a session without a wait, is not a waiting stage (#4309)", async () => {
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:no-wait:1", "c1", 5_000, { sessionId: "session-no-wait" }),
		);
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:waiting:1", "c2", 5_000, {
				sessionId: "session-waiting",
				wait: { kind: "idle", since: 5_000 },
			}),
		);
		const listed = durableWaitingStages(backend, WORKFLOW_ID);
		assert.deepEqual(
			listed.map((stage) => stage.sessionId),
			["session-waiting"],
		);
		// A record that carries no file lists none, rather than listing it as undefined.
		assert.equal(Object.hasOwn(listed[0] ?? {}, "sessionFile"), false);
	});

	test("the results a stage recorded before it reopened come back by replay key, and only while the latest record still holds them (#4309)", async () => {
		const results = [
			{
				toolCallId: "call-1",
				toolName: "wait_for_ci",
				content: [{ type: "text" as const, text: "ci passed" }],
				isError: false,
			},
		];
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:holding:1", "c1", 5_000, {
				wait: { kind: "tool", since: 5_000 },
				waitResults: results,
			}),
		);
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:empty:1", "c2", 5_000, { wait: { kind: "tool", since: 5_000 }, waitResults: [] }),
		);
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:without:1", "c3", 5_000, { wait: { kind: "tool", since: 5_000 } }),
		);
		await recordCheckpointDurably(
			backend,
			rawSessionRecord("stage:delivered:1", "c4", 5_000, {
				wait: { kind: "tool", since: 5_000 },
				waitResults: results,
			}),
		);
		await recordCheckpointDurably(backend, rawSessionRecord("stage:delivered:1", "c5", 6_000));

		const recorded = durableRecordedToolResults(backend, WORKFLOW_ID);
		assert.deepEqual([...recorded.keys()], ["stage:holding:1"]);
		assert.deepEqual(recorded.get("stage:holding:1"), results);
	});
});

describe("session records of a stage that waits (#4309)", () => {
	function waitRecords(): DurableStageCheckpoint[] {
		return backend
			.listCheckpoints(WORKFLOW_ID)
			.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
	}

	test("a forced record is always new, so a later one at another time supersedes it, and the same record unforced is not written again (#4309)", async () => {
		const waiting = waitingSnapshot("alpha", "release", 2_000, 1);
		assert.equal(await recordStageSessionCheckpoint(deps(2_000), waiting, { force: true }), true);
		assert.equal(await recordStageSessionCheckpoint(deps(2_000), waiting), false);
		assert.equal(await recordStageSessionCheckpoint(deps(2_001), waiting, { force: true }), true);
		assert.equal(await recordStageSessionCheckpoint(deps(2_001), waiting, { force: false }), false);
		assert.equal(waitRecords().length, 2);
		assert.equal(new Set(waitRecords().map((record) => record.checkpointId)).size, 2);
	});

	test("the record that ends a wait lands even in the millisecond the wait began, and the stage no longer waits (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(2_000), waitingSnapshot("alpha", "release", 2_000, 1), { force: true });
		assert.equal(durableWaitingStages(backend, WORKFLOW_ID).length, 1);
		await recordStageSessionCheckpoint(deps(2_000), stageSnapshot("alpha", { status: "running" }), { force: true });
		assert.equal(waitRecords().length, 2);
		assert.deepEqual(durableWaitingStages(backend, WORKFLOW_ID), []);
	});

	test("two waits of one stage that began at different times are two records even when forced at the same moment (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(5_000), waitingSnapshot("alpha", "release", 2_000, 1), { force: true });
		await recordStageSessionCheckpoint(deps(5_000), waitingSnapshot("alpha", "idle", 3_000, 2), { force: true });
		assert.equal(waitRecords().length, 2);
		assert.deepEqual(
			durableWaitingStages(backend, WORKFLOW_ID).map((stage) => stage.wait),
			[{ kind: "idle", since: 3_000, promptsCompleted: 2 }],
		);
	});
});

interface StartedStage {
	readonly name: string;
	readonly options: StageOptions | undefined;
	readonly replayKey: string;
	readonly resumed: DurableReleasedStageResume[];
	readonly prompts: string[];
}

/** A durable stage primitive over `backend` whose live stages record what they were started with and told. */
function primitive(): {
	readonly create: (name: string, options?: StageOptions, replayKey?: string) => StageContext;
	readonly started: StartedStage[];
} {
	const started: StartedStage[] = [];
	const create = createDurableStagePrimitive({
		workflowId: WORKFLOW_ID,
		backend,
		nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
		stage: (name, options, replayKey) => {
			const live: StartedStage = { name, options, replayKey, resumed: [], prompts: [] };
			started.push(live);
			return {
				name,
				prompt: async (text: string) => {
					live.prompts.push(text);
					return `live ${text}`;
				},
				__resumeReleased: (resume: DurableReleasedStageResume) => live.resumed.push(resume),
			} as unknown as StageContext & { readonly __resumeReleased: (resume: DurableReleasedStageResume) => void };
		},
	});
	return { create, started };
}

describe("a durable resume of a stage that waited between turns (#4309)", () => {
	test("a stage that finished a prompt before it waited released resumes live, answering that prompt from its recorded result (#4309)", async () => {
		await recordStageCheckpoint(deps(2_000), stageSnapshot("alpha", { structured: { verdict: "ok" } }));
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "release", 3_000, 2), { force: true });
		const { create, started } = primitive();
		const stage = create("alpha", undefined, "stage:alpha:1");
		assert.equal(started.length, 1, "the stage runs live, not from the cache");
		assert.deepEqual(started[0]?.resumed, [
			{
				wait: { kind: "release", since: 3_000, promptsCompleted: 2 },
				sessionId: "session-alpha",
				promptsCompleted: 2,
				recorded: { output: "alpha done", result: "alpha done", structured: { verdict: "ok" } },
			},
		]);
		assert.equal(started[0]?.options?.resumeFromSessionId, "session-alpha");
		assert.equal(started[0]?.options?.durableReplayKey, "stage:alpha:1");
		// Resumed between turns, its next prompt is sent as written, not replaced by the continuation prompt.
		assert.equal(await stage.prompt("next question"), "live next question");
		assert.deepEqual(started[0]?.prompts, ["next question"]);
	});

	test("a recorded result without a text or a structured value answers with what it has (#4309)", async () => {
		await recordStageCheckpoint(deps(2_000), stageSnapshot("alpha", { result: undefined }));
		await recordStageSessionCheckpoint(
			deps(3_000),
			waitingSnapshot("alpha", "idle", 3_000, 1, { result: undefined }),
			{
				force: true,
			},
		);
		const { create, started } = primitive();
		create("alpha", undefined, "stage:alpha:1");
		const resume = started[0]?.resumed[0];
		assert.deepEqual(Object.keys(resume?.recorded ?? {}), ["output"]);
	});

	test("a stage that waited before any prompt finished resumes released with nothing to replay (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "idle", 3_000, 0), { force: true });
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("beta", "release", 3_000, undefined), {
			force: true,
		});
		const { create, started } = primitive();
		create("alpha", undefined, "stage:alpha:1");
		create("beta", undefined, "stage:beta:1");
		assert.deepEqual(
			started.map((live) => live.resumed),
			[
				[
					{
						wait: { kind: "idle", since: 3_000, promptsCompleted: 0 },
						sessionId: "session-alpha",
						promptsCompleted: 0,
					},
				],
				[{ wait: { kind: "release", since: 3_000 }, sessionId: "session-beta", promptsCompleted: 0 }],
			],
		);
		assert.equal(Object.hasOwn(started[0]?.resumed[0] ?? {}, "recorded"), false);
	});

	test("a completed stage whose record cannot answer its prompts is served from the record, not resumed live (#4309)", async () => {
		await recordStageCheckpoint(deps(2_000), stageSnapshot("alpha"));
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "release", 3_000, 0), { force: true });
		await recordStageCheckpoint(deps(2_000), stageSnapshot("beta"));
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("beta", "release", 3_000, undefined), {
			force: true,
		});
		const { create, started } = primitive();
		const alpha = create("alpha", undefined, "stage:alpha:1");
		const beta = create("beta", undefined, "stage:beta:1");
		assert.deepEqual(started, []);
		assert.equal(await alpha.prompt("again"), "alpha done");
		assert.equal(await beta.prompt("again"), "beta done");
	});

	test("a stage that waited on a tool, or on a prompt, is resumed inside its turn, not released (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "tool", 3_000, 0), { force: true });
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("beta", "prompt", 3_000, 0), { force: true });
		const { create, started } = primitive();
		const alpha = create("alpha", undefined, "stage:alpha:1");
		create("beta", undefined, "stage:beta:1");
		assert.deepEqual(
			started.map((live) => live.resumed),
			[[], []],
		);
		assert.equal(started[0]?.options?.resumeFromSessionId, "session-alpha");
		// Its next call is resumed inside its turn: the stage runner continues that turn, or finishes the call (#4375).
		assert.equal(started[0]?.options?.resumeInsideCall, true);
		await alpha.prompt("anything");
		assert.deepEqual(started[0]?.prompts, ["anything"]);
	});

	test("each stage reads the records its previous process left once: later records and later creations of the key do not resume it again (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "release", 3_000, 0), { force: true });
		const { create, started } = primitive();
		create("alpha", undefined, "stage:alpha:1");
		// A record the stage's own run writes after the previous process's were read is not a previous one.
		await recordStageSessionCheckpoint(deps(4_000), waitingSnapshot("beta", "release", 4_000, 0), { force: true });
		create("beta", undefined, "stage:beta:1");
		// The same key created again is a new stage of this process: nothing is resumed.
		create("alpha", undefined, "stage:alpha:1");
		assert.deepEqual(
			started.map((live) => [live.name, live.resumed.length]),
			[
				["alpha", 1],
				["beta", 0],
				["alpha", 0],
			],
		);
	});

	test("a stage that finished prompts but left no record of its answer cannot be resumed released, and is resumed inside its turn (#4309)", async () => {
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "release", 3_000, 2), { force: true });
		const { create, started } = primitive();
		const alpha = create("alpha", undefined, "stage:alpha:1");
		assert.deepEqual(started[0]?.resumed, []);
		assert.equal(started[0]?.options?.resumeFromSessionId, "session-alpha");
		assert.equal(started[0]?.options?.resumeInsideCall, true);
		await alpha.prompt("anything");
		assert.deepEqual(started[0]?.prompts, ["anything"]);
	});

	test("a stage with no earlier session starts with no resume options, and one with a session record resumes it with the file, time and routing it kept (#4309)", async () => {
		const fresh = primitive();
		fresh.create("fresh", { model: "some-model" }, "stage:fresh:1");
		assert.equal(Object.hasOwn(fresh.started[0]?.options ?? {}, "resumeFromSessionId"), false);
		assert.equal(Object.hasOwn(fresh.started[0]?.options ?? {}, "resumeFromLegacySessionFile"), false);
		assert.equal(Object.hasOwn(fresh.started[0]?.options ?? {}, "durableAccumulatedDurationMs"), false);
		assert.equal(fresh.started[0]?.options?.model, "some-model");
		assert.equal(fresh.started[0]?.options?.durableReplayKey, "stage:fresh:1");

		const routerSelection = { model: "routed", reason: "cheapest" } as unknown as StageSnapshot["routerSelection"];
		await recordStageSessionCheckpoint(
			deps(3_000),
			stageSnapshot("filed", { status: "running", sessionFile: "/sessions/filed.jsonl", routerSelection }),
			{ force: true },
		);
		await recordStageSessionCheckpoint(
			deps(3_000),
			stageSnapshot("plain", { status: "running", durationMs: 4_000 }),
			{
				force: true,
			},
		);
		const resumed = primitive();
		resumed.create("filed", undefined, "stage:filed:1");
		resumed.create("plain", undefined, "stage:plain:1");
		const recorded = backend.getStageSession(WORKFLOW_ID, "stage:filed:1");
		assert.equal(resumed.started[0]?.options?.resumeFromSessionId, "session-filed");
		assert.equal(resumed.started[0]?.options?.resumeFromLegacySessionFile, "/sessions/filed.jsonl");
		assert.deepEqual(resumed.started[0]?.options?.routerSelection, routerSelection);
		assert.equal(resumed.started[0]?.options?.durableAccumulatedDurationMs, recorded?.durationMs);
		assert.equal(Object.hasOwn(resumed.started[1]?.options ?? {}, "resumeFromLegacySessionFile"), false);
		assert.equal(
			resumed.started[1]?.options?.durableAccumulatedDurationMs,
			backend.getStageSession(WORKFLOW_ID, "stage:plain:1")?.durationMs,
		);
		assert.ok((resumed.started[1]?.options?.durableAccumulatedDurationMs ?? 0) > 0);
	});

	test("a stage that cannot take the news of a released resume is started all the same (#4309)", async () => {
		await recordStageCheckpoint(deps(2_000), stageSnapshot("alpha"));
		await recordStageSessionCheckpoint(deps(3_000), waitingSnapshot("alpha", "release", 3_000, 1), { force: true });
		const create = createDurableStagePrimitive({
			workflowId: WORKFLOW_ID,
			backend,
			nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
			stage: (name) => ({ name, prompt: async () => "live" }) as unknown as StageContext,
		});
		assert.equal(await create("alpha", undefined, "stage:alpha:1").prompt("go"), "live");
	});
});
