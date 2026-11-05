import { describe } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	createStageReplayKeyGenerator,
	type DurableStageDeps,
	recordStageCheckpoint,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import {
	createCheckpointIdGenerator,
	recordCheckpointDurably,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const WORKFLOW_NAME = "replay-from-record";
const STARTED_AT = 1_000;

interface Recorded {
	/** The stage's recorded display text; absent for a record that has none. */
	readonly result?: string;
	readonly structured?: WorkflowSerializableValue;
	/** A recorded output that is not the display text, as a record written by another path may hold. */
	readonly output?: WorkflowSerializableValue;
}

interface Seeded {
	readonly runId: string;
	readonly backend: JournalDurableBackend;
	readonly sessionStore: MemorySessionStore;
}

/**
 * What a process leaves when it stops while the stage `alpha` waits released after finishing `promptsCompleted` calls,
 * whose answer it recorded as `recorded` says.
 */
async function seedStoppedStage(promptsCompleted: number, recorded: Recorded): Promise<Seeded> {
	const runId = crypto.randomUUID();
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: STARTED_AT,
		status: "running",
	});
	const sessionStore = new MemorySessionStore();
	const manager = await SessionManager.create(sessionStore, "/");
	await manager.appendMessage({ role: "user", content: "plan alpha", timestamp: 1 });
	const sessionId = manager.getSessionId();
	const deps = (now: number): DurableStageDeps => ({
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => now,
	});
	const replayKey = "stage:alpha:1";
	const stage: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey,
		status: "completed",
		parentIds: [],
		toolEvents: [],
		startedAt: STARTED_AT,
		endedAt: 2_000,
		durationMs: 1_000,
		sessionId,
		...(recorded.result === undefined ? {} : { result: recorded.result }),
		...(recorded.structured === undefined ? {} : { structured: recorded.structured }),
	};
	if (recorded.output === undefined) await recordStageCheckpoint(deps(2_000), stage);
	else
		await recordCheckpointDurably(backend, {
			kind: "stage",
			workflowId: runId,
			checkpointId: "recorded-output",
			name: "alpha",
			replayKey,
			output: recorded.output,
			completedAt: 2_000,
			...(recorded.result === undefined ? {} : { result: recorded.result }),
		});
	await recordStageSessionCheckpoint(
		deps(3_000),
		{
			...stage,
			status: "waiting",
			result: undefined,
			structured: undefined,
			wait: { kind: "release", since: 3_000, promptsCompleted },
		},
		{ force: true },
	);
	return { runId, backend, sessionStore };
}

type Call = "prompt" | "complete" | "send";

interface Observed {
	/** What each call answered, in call order. */
	readonly answers: unknown[];
	/** Sessions created after each call, in call order. */
	readonly createdAfter: number[];
	/** The stage's snapshot right after its first call. */
	readonly afterFirst: Pick<StageSnapshot, "status" | "result" | "structured" | "startedAt"> & {
		readonly wait?: string;
	};
	readonly final: Pick<StageSnapshot, "status" | "result" | "structured">;
	/** Each state of the stage the store was told of, as `status/wait`, with `answered` marking where each call returned. */
	readonly told: string[];
}

/** Resume the stopped run with a workflow that makes `calls` on `alpha`, in order. */
async function resumeCalling(
	seeded: Seeded,
	calls: readonly Call[],
): Promise<{ observed: Observed; status: string; error?: string }> {
	const service = new FakeCiService();
	const seen = counters();
	const store = createStore();
	const told: string[] = [];
	const recordStageStart = store.recordStageStart.bind(store);
	store.recordStageStart = (runId: string, stage: StageSnapshot) => {
		if (stage.name === "alpha") told.push(`${stage.status}/${stage.wait?.kind ?? "-"}`);
		recordStageStart(runId, stage);
	};
	const answers: unknown[] = [];
	const createdAfter: number[] = [];
	let afterFirst: Observed["afterFirst"] | undefined;
	const stageNow = (): StageSnapshot | undefined => store.runs()[0]?.stages.find((stage) => stage.name === "alpha");
	const definition = workflow({
		name: WORKFLOW_NAME,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("alpha");
			for (const call of calls) {
				if (call === "prompt") answers.push(await stage.prompt("plan alpha"));
				else if (call === "complete") answers.push(await stage.complete("again"));
				else answers.push(await stage.sendUserMessage("report"));
				createdAfter.push(seen.created);
				told.push("answered");
				const snapshot = stageNow();
				afterFirst ??= {
					status: snapshot?.status ?? "pending",
					result: snapshot?.result,
					structured: snapshot?.structured,
					startedAt: snapshot?.startedAt,
					wait: snapshot?.wait?.kind,
				};
			}
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			runId: seeded.runId,
			store,
			durableBackend: seeded.backend,
			adapters: { ...detachingAdapters(service, seen, { detach: false }), sessionStore: seeded.sessionStore },
			releaseWhenWaiting: { afterMs: 600_000 },
		},
	);
	const final = stageNow();
	return {
		status: result.status,
		...(result.error === undefined ? {} : { error: result.error }),
		observed: {
			answers,
			createdAfter,
			told,
			afterFirst: afterFirst ?? {
				status: "pending",
				result: undefined,
				structured: undefined,
				startedAt: undefined,
			},
			final: { status: final?.status ?? "pending", result: final?.result, structured: final?.structured },
		},
	};
}

describe("a resumed stage answers its finished calls from the run's record (#4309)", () => {
	test("a replayed prompt completes the stage from the recorded text while it still shows its released wait, and the next message reopens the session (#4309)", async () => {
		const seeded = await seedStoppedStage(1, { result: "planned alpha", structured: { verdict: "ok" } });
		const { observed, status, error } = await resumeCalling(seeded, ["prompt", "send"]);

		assert.equal(status, "completed", error);
		assert.deepEqual(observed.answers, ["planned alpha", undefined]);
		assert.deepEqual(observed.afterFirst, {
			status: "waiting",
			result: "planned alpha",
			structured: { verdict: "ok" },
			startedAt: observed.afterFirst.startedAt,
			wait: "release",
		});
		assert.equal(typeof observed.afterFirst.startedAt, "number");
		// The replayed call touched no session; the message after it reopened the stage's own.
		assert.deepEqual(observed.createdAfter, [0, 1]);
		assert.deepEqual(observed.final, { status: "completed", result: "planned alpha", structured: { verdict: "ok" } });
		await seeded.backend.close();
	});

	test("a replayed completion answers with the recorded text too (#4309)", async () => {
		const seeded = await seedStoppedStage(1, { result: "planned alpha" });
		const { observed, status, error } = await resumeCalling(seeded, ["complete"]);

		assert.equal(status, "completed", error);
		assert.deepEqual(observed.answers, ["planned alpha"]);
		assert.deepEqual(observed.createdAfter, [0]);
		await seeded.backend.close();
	});

	test("a replayed message answers nothing, and the stage still completes from the record without a session (#4309)", async () => {
		const seeded = await seedStoppedStage(1, { result: "planned alpha" });
		const { observed, status, error } = await resumeCalling(seeded, ["send"]);

		assert.equal(status, "completed", error);
		assert.deepEqual(observed.answers, [undefined]);
		assert.deepEqual(observed.createdAfter, [0]);
		assert.equal(observed.afterFirst.result, "planned alpha");
		assert.equal(observed.afterFirst.status, "waiting");
		await seeded.backend.close();
	});

	test("two finished calls are both answered from the record, the stage completing with the first, and the third reopens the session (#4309)", async () => {
		const seeded = await seedStoppedStage(2, { result: "planned alpha" });
		const { observed, status, error } = await resumeCalling(seeded, ["prompt", "complete", "send"]);

		assert.equal(status, "completed", error);
		// The stage finished with the first call; the second has nothing left to answer with.
		assert.deepEqual(observed.answers, ["planned alpha", "", undefined]);
		assert.deepEqual(observed.createdAfter, [0, 0, 1]);
		await seeded.backend.close();
	});

	test("a record whose output is text and has no display text answers with that text and shows it (#4309)", async () => {
		const seeded = await seedStoppedStage(1, { output: "raw recorded text" });
		const { observed, status, error } = await resumeCalling(seeded, ["complete"]);

		assert.equal(status, "completed", error);
		assert.deepEqual(observed.answers, ["raw recorded text"]);
		assert.equal(observed.afterFirst.result, "raw recorded text");
		await seeded.backend.close();
	});

	test("a record with a display text answers a completion with that text, not with its output (#4309)", async () => {
		const seeded = await seedStoppedStage(1, { output: { verdict: "ok" }, result: "the display text" });
		const { observed, status, error } = await resumeCalling(seeded, ["complete"]);

		assert.equal(status, "completed", error);
		assert.deepEqual(observed.answers, ["the display text"]);
		assert.equal(observed.afterFirst.result, "the display text");
		await seeded.backend.close();
	});

	test("a record whose output is not text answers a prompt with it and a completion with its JSON, and shows no text (#4309)", async () => {
		const output = { verdict: "ok", items: [1, 2] };
		const promptedSeed = await seedStoppedStage(1, { output });
		const prompted = await resumeCalling(promptedSeed, ["prompt"]);
		assert.equal(prompted.status, "completed", prompted.error);
		assert.deepEqual(prompted.observed.answers, [output]);
		assert.equal(prompted.observed.afterFirst.result, undefined);

		const completedSeed = await seedStoppedStage(1, { output });
		const completed = await resumeCalling(completedSeed, ["complete"]);
		assert.equal(completed.status, "completed", completed.error);
		assert.deepEqual(completed.observed.answers, [JSON.stringify(output)]);
		assert.equal(completed.observed.afterFirst.result, undefined);
		await promptedSeed.backend.close();
		await completedSeed.backend.close();
	});
});

describe("what the store is told while a resumed stage answers from the record (#4309)", () => {
	test("the stage is shown waiting released from the moment it exists, and shown waiting again once the recorded answer has completed it (#4309)", async () => {
		const seeded = await seedStoppedStage(1, { result: "planned alpha" });
		const { observed, status, error } = await resumeCalling(seeded, ["prompt", "send"]);

		assert.equal(status, "completed", error);
		const beforeFirstAnswer = observed.told.slice(0, observed.told.indexOf("answered"));
		// Started pending; resumed released, shown at once; completed from the record, shown released again.
		assert.deepEqual(beforeFirstAnswer, ["pending/-", "waiting/release", "waiting/release"]);
		// The message that follows reopens the session: the stage is no longer shown waiting until the run ends.
		const afterFirstAnswer = observed.told.slice(observed.told.indexOf("answered") + 1);
		assert.ok(afterFirstAnswer.every((state) => state === "completed/-" || state === "answered"));
		await seeded.backend.close();
	});
});
