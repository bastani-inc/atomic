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
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const WORKFLOW_NAME = "replay-edges";
/** Short enough that a stage held idle is released within the test, long enough that its own call ends first. */
const IDLE_AFTER_MS = 50;

interface Seeded {
	readonly runId: string;
	readonly backend: JournalDurableBackend;
	readonly sessionStore: MemorySessionStore;
}

/**
 * What a process leaves when it stops while the stage `alpha` waits released between turns after `promptsCompleted`
 * calls; with `recorded`, the stage's completion was recorded with that text, else no completion was.
 */
async function seedReleasedStage(promptsCompleted: number, recorded?: string): Promise<Seeded> {
	const runId = crypto.randomUUID();
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const sessionStore = new MemorySessionStore();
	const manager = await SessionManager.create(sessionStore, "/");
	await manager.appendMessage({ role: "user", content: "plan alpha", timestamp: 1 });
	const deps = (now: number): DurableStageDeps => ({
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => now,
	});
	const stage: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		sessionId: manager.getSessionId(),
		...(recorded === undefined ? {} : { result: recorded }),
	};
	if (recorded !== undefined) await recordStageCheckpoint(deps(2_000), stage);
	await recordStageSessionCheckpoint(
		deps(3_000),
		{ ...stage, status: "suspended", result: undefined, wait: { kind: "release", since: 3_000, promptsCompleted } },
		{ force: true },
	);
	return { runId, backend, sessionStore };
}

interface Resumed {
	readonly status: string;
	readonly error?: string;
	readonly created: number;
	readonly prompts: number;
	readonly events: StageLifecycleEvent[];
	/** The status the run reported to `onStageEnd` for alpha, each time it did. */
	readonly ended: string[];
}

/** Resume the stopped run with `body` as the workflow's use of `alpha`. */
async function resume(
	seeded: Seeded,
	body: (stage: StageContext, store: ReturnType<typeof createStore>) => Promise<void>,
	releaseAfterMs = 600_000,
	events: StageLifecycleEvent[] = [],
): Promise<Resumed> {
	const seen = counters();
	const store = createStore();
	const ended: string[] = [];
	const definition = workflow({
		name: WORKFLOW_NAME,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await body(ctx.stage("alpha"), store);
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
			adapters: {
				...detachingAdapters(new FakeCiService(), seen, { detach: false }),
				sessionStore: seeded.sessionStore,
			},
			releaseWhenWaiting: { afterMs: releaseAfterMs },
			onStageLifecycleEvent: (_runId, event) => events.push(event),
			onStageEnd: (_runId, snapshot) => {
				if (snapshot.name === "alpha") ended.push(snapshot.status);
			},
		},
	);
	await seeded.backend.close();
	return {
		status: result.status,
		...(result.error === undefined ? {} : { error: result.error }),
		created: seen.created,
		prompts: seen.userPrompts.get("alpha") ?? 0,
		events,
		ended,
	};
}

function alphaOf(store: ReturnType<typeof createStore>): StageSnapshot | undefined {
	return store.runs()[0]?.stages.find((stage) => stage.name === "alpha");
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("a stage resumed released between turns (#4309)", () => {
	test("whose previous process finished no call runs its first call on its reopened session, not from a record (#4309)", async () => {
		const seeded = await seedReleasedStage(0);
		let answer: string | undefined;

		const resumed = await resume(seeded, async (stage) => {
			answer = await stage.complete("plan alpha");
		});

		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(resumed.created, 1);
		assert.equal(resumed.prompts, 1);
		assert.equal(typeof answer, "string");
	});

	test("completes from the record as completed, without a result or output field the record does not hold (#4309)", async () => {
		const seeded = await seedReleasedStage(1, "planned alpha");
		let afterReplay: StageSnapshot | undefined;

		const resumed = await resume(seeded, async (stage, store) => {
			await stage.prompt("plan alpha");
			afterReplay = structuredClone(alphaOf(store));
		});

		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(resumed.ended, ["completed"]);
		assert.equal(afterReplay?.result, "planned alpha");
		assert.equal(Object.hasOwn(afterReplay!, "structured"), false);
		assert.equal(resumed.created, 0);
	});

	test("reopened by its author before its first call shows its own status once the call is answered from the record (#4309)", async () => {
		const seeded = await seedReleasedStage(1, "planned alpha");
		let afterReplay: { status?: string; wait?: string } | undefined;

		const resumed = await resume(seeded, async (stage, store) => {
			await stage.rehydrate();
			await stage.prompt("plan alpha");
			const snapshot = alphaOf(store);
			afterReplay = { status: snapshot?.status, wait: snapshot?.wait?.kind };
		});

		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(afterReplay, { status: "completed", wait: undefined });
	});

	test("counts the call answered from the record with its later calls in the next wait it records (#4309)", async () => {
		const seeded = await seedReleasedStage(1, "planned alpha");
		let promptsCompleted: number | undefined;

		const resumed = await resume(seeded, async (stage, store) => {
			await stage.prompt("plan alpha");
			await stage.sendUserMessage("report");
			await stage.release();
			promptsCompleted = alphaOf(store)?.wait?.promptsCompleted;
		});

		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(promptsCompleted, 2);
	});

	test("once reopened after its call was answered from the record, is released again when the workflow holds it idle (#4309)", async () => {
		const seeded = await seedReleasedStage(1, "planned alpha");
		const events: StageLifecycleEvent[] = [];

		const resumed = await resume(
			seeded,
			async (stage) => {
				await stage.prompt("plan alpha");
				await stage.rehydrate();
				const reopened = events.length;
				await until(() => events.slice(reopened).some((event) => event.type === "stage_waiting"));
			},
			IDLE_AFTER_MS,
			events,
		);

		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(
			resumed.events.map((event) => `${event.type}:${event.wait.kind}`),
			["stage_waiting:release", "stage_rehydrated:release", "stage_waiting:idle"],
		);
	});
});
