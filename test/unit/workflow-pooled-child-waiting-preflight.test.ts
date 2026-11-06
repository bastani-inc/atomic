import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import {
	createStageReplayKeyGenerator,
	durableRecordedToolResults,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { StageWaitKind } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageWaitToolResult } from "../../packages/workflows/src/shared/stage-wait.js";
import {
	isStageRehydrationError,
	StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { rehydrateTypedFailure } from "../../packages/workflows/src/shared/typed-failure-detail.js";
import {
	failedOnPoolFault,
	isRetryableWorkflowError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { openWorkerJournals } from "../../packages/workflows/src/workers/local-worker.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import { workerSessionStore } from "../../packages/workflows/src/workers/session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT_RUN_ID = "44400000-0000-4000-8000-000000000001";
const CHILD_RUN_ID = "44400000-0000-4000-8000-000000000002";
const SCOPE = "workflow:pooled-child:1";
const CHILD_NAME = "pooled-child";
/** The root journal a worker reads, and the pool session store it hands the child, as one kind of worker host keeps them. */
interface WorkerHost {
	readonly journal: RunJournal;
	readonly sessions: SessionStore;
	close(): Promise<void>;
}

type HostKind = "memory" | "local" | "shared";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function openHost(kind: HostKind): Promise<WorkerHost> {
	if (kind === "memory")
		return { journal: new MemoryRunJournal(), sessions: new MemorySessionStore(), close: async () => {} };
	const directory = makeTempDirectory(`pooled-child-preflight-${kind}-`);
	directories.push(directory);
	const path = join(directory, "journal.sqlite");
	// A local pool's workers open its journal by path; a shared pool's open the durable journal by its selection.
	let selection: string | undefined;
	if (kind === "shared") {
		const durable = await resolveRunJournal({ journal: { path } });
		selection = JSON.stringify(poolDurableJournal(durable));
		await durable.close();
	}
	const opened = await openWorkerJournals(kind === "local" ? { journalPath: path } : {}, selection);
	return {
		journal: opened.journal,
		sessions: opened.sessions,
		close: async () => {
			await opened.sessions.close();
			await opened.journal.close();
		},
	};
}

interface SeededStage {
	readonly name: string;
	readonly kind: StageWaitKind;
	/** False: the session the record names is not in the pool's session store. */
	readonly saved: boolean;
	/** Results the stage's detached calls delivered, recorded with its wait before its transcript held them. */
	readonly waitResults?: readonly StageWaitToolResult[];
}

interface SeededChild {
	readonly backend: JournalDurableBackend;
	readonly scoped: ScopedDurableBackend;
	/** Each seeded stage's session id, in seeding order. */
	readonly sessionIds: readonly string[];
}

/**
 * The root journal and pool session store a pooled child leaves when its process stops while its stages wait: each
 * stage's wait recorded under the child's scope in the root's journal, as the child's scoped backend writes it.
 */
async function seedWaitingChild(host: WorkerHost, stages: readonly SeededStage[]): Promise<SeededChild> {
	const backend = await JournalDurableBackend.open(host.journal);
	await backend.commitWorkflowRegistration({
		workflowId: ROOT_RUN_ID,
		name: "pooled-root",
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const scoped = new ScopedDurableBackend(backend, { rootWorkflowId: ROOT_RUN_ID, scopePrefix: SCOPE });
	const sessionIds: string[] = [];
	for (const [index, seeded] of stages.entries()) {
		const sessionId = `pooled-session-${index}-${seeded.name}`;
		sessionIds.push(sessionId);
		if (seeded.saved)
			await host.sessions.create(
				{ id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: new Date(0).toISOString(), cwd: "/" },
				[],
			);
		const stage: StageSnapshot = {
			id: `stage-${index}`,
			name: seeded.name,
			replayKey: `stage:${seeded.name}:1`,
			status: "waiting",
			parentIds: [],
			toolEvents: [],
			startedAt: 1_000,
			sessionId,
			wait: { kind: seeded.kind, since: 3_000, promptsCompleted: seeded.kind === "tool" ? 0 : 1 },
			...(seeded.waitResults === undefined ? {} : { waitResults: seeded.waitResults }),
		};
		await recordStageSessionCheckpoint(
			{
				workflowId: CHILD_RUN_ID,
				backend: scoped,
				nextCheckpointId: createCheckpointIdGenerator(),
				nextReplayKey: createStageReplayKeyGenerator(CHILD_RUN_ID),
				now: () => 3_000,
				runTopology: { runId: CHILD_RUN_ID, runName: CHILD_NAME, parentRunId: ROOT_RUN_ID, rootRunId: ROOT_RUN_ID },
			},
			stage,
			{ force: true },
		);
	}
	return { backend, scoped, sessionIds };
}

/** What the root's journal holds: its runs, and every entry of the root run, in order. */
async function journalContents(journal: RunJournal): Promise<readonly string[]> {
	const contents = (await journal.listRuns()).map((summary) => `run ${summary.runId}`);
	for await (const entry of journal.read(ROOT_RUN_ID)) contents.push(`${entry.seq} ${entry.event.type}`);
	return contents;
}

interface ChildAttempt {
	readonly result: Awaited<ReturnType<typeof run>>;
	readonly store: ReturnType<typeof createStore>;
	readonly bodyRan: boolean;
	readonly toolCalls: number;
	readonly sessionsCreated: number;
	readonly prompts: number;
	readonly sessionWrites: number;
	/** How many times the root's checkpoints were listed before the child's body ran. */
	readonly listingsBeforeBody: number | undefined;
}

/**
 * Run the child the way a worker does: under its own run id, through a scoped view of the root's journal, handed the
 * pool's session store wrapped as the worker wraps it.
 */
async function runChildAttempt(host: WorkerHost, seeded: SeededChild): Promise<ChildAttempt> {
	const store = createStore();
	const listings = vi.spyOn(seeded.backend, "listCheckpoints");
	let listingsBeforeBody: number | undefined;
	let bodyRan = false;
	let toolCalls = 0;
	let sessionsCreated = 0;
	let prompts = 0;
	let sessionWrites = 0;
	const child = workflow({
		name: CHILD_NAME,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			listingsBeforeBody = listings.mock.calls.length;
			bodyRan = true;
			await ctx.tool("side-effect", {}, async () => {
				toolCalls += 1;
				return 1;
			});
			return {};
		},
	});
	const result = await run(
		child,
		{},
		{
			runId: CHILD_RUN_ID,
			store,
			durableBackend: seeded.backend,
			durableRootBackend: seeded.backend,
			durableScope: { rootWorkflowId: ROOT_RUN_ID, scopePrefix: SCOPE },
			parentRun: { runId: ROOT_RUN_ID, stageId: "boundary", rootRunId: ROOT_RUN_ID },
			adapters: {
				sessionStore: workerSessionStore({
					reader: host.sessions,
					backend: seeded.backend,
					store,
					root: ROOT_RUN_ID,
					commit: async () => {
						sessionWrites += 1;
						throw new Error("no pool session may be written");
					},
				}),
				agentSession: {
					create: async () => {
						sessionsCreated += 1;
						throw new Error("no session may be created");
					},
				},
				prompt: {
					prompt: async () => {
						prompts += 1;
						return "done";
					},
				},
			},
		},
	);
	listings.mockRestore();
	return { result, store, bodyRan, toolCalls, sessionsCreated, prompts, sessionWrites, listingsBeforeBody };
}

const HOSTS: readonly HostKind[] = ["memory", "local", "shared"];

/** How many times a child lists the root's checkpoints before its body runs, measured before the check was added. */
const LISTINGS_BEFORE_CHILD_BODY = 3;

describe("a pooled child checks the sessions of its waiting stages before it runs (#4440)", () => {
	for (const kind of HOSTS) {
		test(`on a ${kind} worker host, a child whose waiting stages' sessions are gone fails typed before any work, as a failed run (#4440)`, async () => {
			const host = await openHost(kind);
			try {
				const seeded = await seedWaitingChild(host, [
					{ name: "alpha", kind: "release", saved: false },
					{ name: "beta", kind: "tool", saved: true },
					{ name: "gamma", kind: "idle", saved: false },
				]);
				const reads = vi.spyOn(host.sessions, "readHeader");
				const journalBefore = await journalContents(host.journal);

				const attempt = await runChildAttempt(host, seeded);

				// The refusal is the child's outcome, not a fault of the pool: the worker completes the attempt with it.
				assert.equal(attempt.result.status, "failed", JSON.stringify(attempt.result));
				assert.equal(failedOnPoolFault(attempt.result), false);
				const detail = attempt.result.failureDetail;
				assert.ok(detail?.family === "StageWaitError", JSON.stringify(detail));
				assert.equal(detail.name, "StageRehydrationError");
				assert.equal(detail.code, "session-not-found");
				assert.equal(detail.retryable, false);
				assert.deepEqual(detail.fields, {
					runId: CHILD_RUN_ID,
					rootRunId: ROOT_RUN_ID,
					sessionIds: [seeded.sessionIds[0], seeded.sessionIds[2]],
					storage: `child workflow session store: ${host.sessions.descriptor.adapter}`,
				});
				// One header read per waiting stage, and nothing else: no session, prompt, tool, write or workflow code.
				assert.deepEqual(
					reads.mock.calls.map(([sessionId]) => sessionId),
					seeded.sessionIds,
				);
				assert.equal(attempt.bodyRan, false);
				assert.equal(attempt.toolCalls, 0);
				assert.equal(attempt.sessionsCreated, 0);
				assert.equal(attempt.prompts, 0);
				assert.equal(attempt.sessionWrites, 0);
				assert.deepEqual(await journalContents(host.journal), journalBefore);
				assert.deepEqual(attempt.result.stages, []);
				assert.equal(attempt.store.runs().find((snapshot) => snapshot.id === CHILD_RUN_ID)?.status, "failed");
				await seeded.backend.close();
			} finally {
				await host.close();
			}
		});

		test(`on a ${kind} worker host, a child whose waiting stages' sessions are in the pool's store runs, after one header read each (#4440)`, async () => {
			const host = await openHost(kind);
			try {
				const seeded = await seedWaitingChild(host, [
					{ name: "alpha", kind: "release", saved: true },
					{ name: "beta", kind: "tool", saved: true },
				]);
				const reads = vi.spyOn(host.sessions, "readHeader");
				const closes = vi.spyOn(host.sessions, "close");

				const attempt = await runChildAttempt(host, seeded);

				assert.equal(attempt.result.status, "completed", attempt.result.error);
				assert.equal(attempt.bodyRan, true);
				assert.equal(attempt.toolCalls, 1);
				assert.equal(attempt.sessionsCreated, 0);
				assert.deepEqual(
					reads.mock.calls.map(([sessionId]) => sessionId),
					seeded.sessionIds,
				);
				// The pool's store belongs to the worker, which serves the next child with it.
				assert.equal(closes.mock.calls.length, 0);
				await seeded.backend.close();
			} finally {
				await host.close();
			}
		});
	}

	test("the check reads the child's waiting stages from the pass over its checkpoints it already makes for its recorded results (#4440)", async () => {
		const host = await openHost("memory");
		const seeded = await seedWaitingChild(host, [{ name: "alpha", kind: "release", saved: true }]);
		const attempt = await runChildAttempt(host, seeded);
		assert.equal(attempt.result.status, "completed", attempt.result.error);
		// As many listings of the root's checkpoints before the child's body runs as before the check existed.
		assert.equal(attempt.listingsBeforeBody, LISTINGS_BEFORE_CHILD_BODY);
		await seeded.backend.close();
	});

	test("a refused child keeps the results its detached calls recorded, and a later attempt with its session back runs (#4440)", async () => {
		const host = await openHost("memory");
		const results: readonly StageWaitToolResult[] = [
			{
				toolCallId: "call-alpha",
				toolName: "wait_for_ci",
				isError: false,
				content: [{ type: "text", text: "ci passed" }],
			},
		];
		const seeded = await seedWaitingChild(host, [
			{ name: "alpha", kind: "tool", saved: false, waitResults: results },
		]);
		const recordedBefore = durableRecordedToolResults(seeded.scoped, CHILD_RUN_ID);
		assert.deepEqual([...recordedBefore.values()], [results]);

		const refused = await runChildAttempt(host, seeded);
		assert.equal(refused.result.status, "failed");
		assert.equal(refused.result.failureDetail?.code, "session-not-found");
		assert.deepEqual(durableRecordedToolResults(seeded.scoped, CHILD_RUN_ID), recordedBefore);

		await host.sessions.create(
			{ id: seeded.sessionIds[0]!, version: SESSION_FORMAT_VERSION, createdAt: new Date(0).toISOString(), cwd: "/" },
			[],
		);
		const resumed = await runChildAttempt(host, seeded);
		assert.equal(resumed.result.status, "completed", resumed.result.error);
		assert.equal(resumed.bodyRan, true);
		assert.deepEqual(durableRecordedToolResults(seeded.scoped, CHILD_RUN_ID), recordedBefore);
		await seeded.backend.close();
	});

	test("the refusal crosses to the root as a StageRehydrationError with its fields, naming the root run to resume (#4440)", async () => {
		const host = await openHost("memory");
		const seeded = await seedWaitingChild(host, [{ name: "alpha", kind: "release", saved: false }]);
		const attempt = await runChildAttempt(host, seeded);

		// The worker sends its result through the pool's journal as JSON; the root rebuilds the typed error from it.
		const crossed = JSON.parse(JSON.stringify(attempt.result)) as typeof attempt.result;
		const reading = rehydrateTypedFailure(crossed.failureDetail);
		assert.ok(reading.ok, reading.ok ? "" : reading.reason);
		const error = reading.error;
		assert.ok(error instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "session-not-found");
		assert.equal(error.retryable, false);
		assert.equal(isRetryableWorkflowError(error), false);
		assert.deepEqual(error.fields, {
			runId: CHILD_RUN_ID,
			rootRunId: ROOT_RUN_ID,
			sessionIds: [seeded.sessionIds[0]],
			storage: "child workflow session store: memory",
		});
		assert.ok(
			error.hint.startsWith(`Resume root run ${ROOT_RUN_ID} with the storage it was started with`),
			error.hint,
		);
		assert.equal(error.message, attempt.result.failureDetail?.message);
		await seeded.backend.close();
	});
});
