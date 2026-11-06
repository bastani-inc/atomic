import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	type WorkflowPendingStageRouteReadiness,
	workflowPendingStageRouteReady,
} from "../../packages/workflows/src/shared/pending-stage-route-readiness.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const ROUTE_EVENT = "atomic:workflow-pending-stage-route";
/** The run size #4376 reported timing out, where 1,000 stages still registered. */
const STAGES = 2_500;
/**
 * Route publications a run of that size may make: its first and last, and for each burst of stages the run's
 * concurrency admits together, the one a stage announces at once and the one every other stage of the burst shares.
 * When each starting stage announced the run's roster itself, the run made 2,501 announcements, 1,478 of them
 * published with 3,695,000 roster rows.
 */
const PUBLICATION_LIMIT = 8;
/** 2,500 stages run through the real executor, which is the structural cost of this test. */
const SCALE_RUN_TIMEOUT_MS = 120_000;
/** Event-loop turns a test lets pass before it concludes that nothing more goes out. */
const SETTLE_TURNS = 5;

useTemporaryAgentDir();

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settleTurns(): Promise<void> {
	for (let turn = 0; turn < SETTLE_TURNS; turn++) await nextTurn();
}

/** Runs every queued promise reaction without letting the event loop turn. */
async function settleMicrotasks(): Promise<void> {
	for (let reaction = 0; reaction < 20; reaction++) await Promise.resolve();
}

interface RoutePayload extends Record<string, unknown> {
	readonly stages: readonly { readonly stageId: string }[];
	completion?: Promise<void>;
}

const answerTimings = {
	"answers at once": () => Promise.resolve(),
	"answers a turn later": nextTurn,
} as const;

for (const [timing, answer] of Object.entries(answerTimings)) {
	test(
		`a run of 2,500 starting stages publishes its route a bounded number of times when the consumer ${timing} (#4376)`,
		async () => {
			const store = createStore();
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			let publications = 0;
			let rows = 0;
			let announcements = 0;
			let creations = 0;
			const dispose = registerPendingStageIntercomBridge(
				{
					events: {
						emit(event, payload) {
							if (event !== ROUTE_EVENT) return;
							publications++;
							rows += (payload as RoutePayload).stages.length;
							payload.completion = answer();
						},
					},
				},
				store,
				// Each announcement asks this of every run it announces, whether or not its roster changed.
				() => {
					announcements++;
					return true;
				},
			);
			const definition = workflow({
				name: "pending-stage-route-scale",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await Promise.all(
						Array.from({ length: STAGES }, (_, index) => ctx.stage(`stage-${index}`).prompt("work")),
					);
					return {};
				},
			});
			try {
				const result = await run(
					definition,
					{},
					{
						runId: testRunId(`pending-stage-route-scale-${timing}`),
						store,
						durableBackend: backend,
						adapters: {
							agentSession: {
								async create() {
									creations++;
									return makeMockSession({
										async prompt() {
											return "done";
										},
									}).session;
								},
							},
						},
					},
				);
				assert.equal(result.status, "completed");
				assert.equal(creations, STAGES);
				assert.ok(publications <= PUBLICATION_LIMIT, `${publications} route publications`);
				assert.ok(announcements <= PUBLICATION_LIMIT, `${announcements} route announcements`);
				assert.ok(rows <= PUBLICATION_LIMIT * STAGES, `${rows} roster rows published`);
			} finally {
				dispose();
			}
		},
		SCALE_RUN_TIMEOUT_MS,
	);
}

const RUN_ID = testRunId("pending-stage-route-readiness");

function stage(id: string): StageSnapshot {
	return { id, name: id, status: "running", parentIds: [], toolEvents: [], pendingStageDeliveryAvailable: true };
}

function runSnapshot(stages: readonly StageSnapshot[]): RunSnapshot {
	return {
		id: RUN_ID,
		name: "readiness",
		inputs: {},
		status: "running",
		stages: [...stages],
		toolNodes: [],
		startedAt: 1,
	};
}

interface Publication {
	readonly stageIds: readonly string[];
	readonly answer: PromiseWithResolvers<void>;
}

/**
 * A bridge whose consumer holds every publication until the test answers it, unless `answerAtOnce`. The store's own
 * batched announcement waits on a timer the fixture never advances, so only stage readiness publishes.
 */
function readinessFixture(answerAtOnce = false) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const store = createStore();
	const publications: Publication[] = [];
	const dispose = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event, payload) {
					if (event !== ROUTE_EVENT) return;
					const answer = Promise.withResolvers<void>();
					if (answerAtOnce) answer.resolve();
					publications.push({ stageIds: (payload as RoutePayload).stages.map((row) => row.stageId), answer });
					payload.completion = answer.promise;
				},
			},
		},
		store,
	);
	const ready = (): WorkflowPendingStageRouteReadiness => {
		const readiness = workflowPendingStageRouteReady(store, RUN_ID);
		assert.ok(readiness, "the bridge owns the run's route readiness");
		return readiness;
	};
	return { store, publications, ready, dispose };
}

function startStage(store: Store, id: string): void {
	store.recordStageStart(RUN_ID, stage(id));
}

async function publicationCount(publications: readonly Publication[], count: number): Promise<void> {
	for (let turn = 0; turn < SETTLE_TURNS && publications.length < count; turn++) await nextTurn();
	assert.equal(publications.length, count);
}

function settlement(readiness: WorkflowPendingStageRouteReadiness): { settled: boolean } {
	const observed = { settled: false };
	void readiness.completion.then(
		() => {
			observed.settled = true;
		},
		() => {
			observed.settled = true;
		},
	);
	return observed;
}

test("stages that start while their run's publication is unanswered share the next publication (#4376)", async () => {
	const { store, publications, ready, dispose } = readinessFixture();
	try {
		store.recordRunStart(runSnapshot([stage("first")]));
		const first = ready();
		assert.deepEqual(
			publications.map((publication) => publication.stageIds),
			[["first"]],
		);
		const joined = ["second", "third", "fourth"].map((id) => {
			startStage(store, id);
			return ready();
		});
		await settleTurns();
		assert.equal(publications.length, 1, "nothing more goes out while the first publication is unanswered");
		const observed = joined.map(settlement);
		publications[0]?.answer.resolve();
		await first.completion;
		await publicationCount(publications, 2);
		assert.deepEqual(publications[1]?.stageIds, ["first", "second", "third", "fourth"]);
		await settleTurns();
		assert.deepEqual(
			observed.map(({ settled }) => settled),
			[false, false, false],
			"each stage waits for the publication that carries its row",
		);
		publications[1]?.answer.resolve();
		await Promise.all(joined.map((readiness) => readiness.completion));
		assert.equal(publications.length, 2);
	} finally {
		dispose();
	}
});

test("a stage that joined a refused publication waits for the next publication, not the refusal (#4376)", async () => {
	const { store, publications, ready, dispose } = readinessFixture();
	try {
		store.recordRunStart(runSnapshot([stage("first")]));
		const first = ready();
		startStage(store, "second");
		const second = ready();
		const refusal = new Error("pending-stage route refused");
		publications[0]?.answer.reject(refusal);
		await assert.rejects(first.completion, (error) => error === refusal);
		await publicationCount(publications, 2);
		assert.deepEqual(publications[1]?.stageIds, ["first", "second"]);
		publications[1]?.answer.resolve();
		await second.completion;
	} finally {
		dispose();
	}
});

test("a stage starting after its run's publication was answered announces at once (#4376)", async () => {
	const { store, publications, ready, dispose } = readinessFixture();
	try {
		store.recordRunStart(runSnapshot([stage("first")]));
		const first = ready();
		publications[0]?.answer.resolve();
		await first.completion;
		await settleTurns();
		startStage(store, "second");
		const second = ready();
		assert.deepEqual(publications[1]?.stageIds, ["first", "second"], "the stage announces its row at once");
		const observed = settlement(second);
		await settleTurns();
		assert.equal(observed.settled, false, "the stage waits for its own publication");
		publications[1]?.answer.resolve();
		await second.completion;
		assert.equal(publications.length, 2);
	} finally {
		dispose();
	}
});

test("a publication answered at once still holds a stage that starts before the event loop turns (#4376)", async () => {
	const { store, publications, ready, dispose } = readinessFixture(true);
	try {
		store.recordRunStart(runSnapshot([stage("first")]));
		await ready().completion;
		await settleMicrotasks();
		startStage(store, "second");
		const second = ready();
		assert.equal(publications.length, 1, "a stage starting in the same turn joins the next publication");
		await second.completion;
		assert.deepEqual(
			publications.map((publication) => publication.stageIds),
			[["first"], ["first", "second"]],
		);
	} finally {
		dispose();
	}
});
