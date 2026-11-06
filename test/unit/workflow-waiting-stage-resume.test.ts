import { SHARED_STORAGE_JOIN_HINT } from "@bastani/atomic/storage";
import { describe, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import {
	createStageReplayKeyGenerator,
	type DurableStageDeps,
	recordStageCheckpoint,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import type {
	StageLifecycleEvent,
	StageWaitKind,
} from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	isStageRehydrationError,
	StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const WORKFLOW_NAME = "resume-between-turns";
/** Journal calls that change it: none may happen when a resume fails its preflight. */
const JOURNAL_WRITES = [
	"createRun",
	"acquire",
	"takeover",
	"takeoverExpired",
	"renew",
	"release",
	"append",
	"deleteRun",
	"deleteOwnedRun",
] as const;

interface SeededStage {
	readonly name: string;
	readonly kind: StageWaitKind;
	/** Calls the stage finished before its process stopped; 1 means its first prompt completed. */
	readonly promptsCompleted: number;
	/** False: the session the record names is not in the store. */
	readonly saved?: boolean;
	/** The run that owns the stage when it is not the seeded run, as for a pooled child whose root holds its records. */
	readonly ownerRunId?: string;
}

interface SeededRun {
	readonly runId: string;
	readonly journal: MemoryRunJournal;
	readonly backend: JournalDurableBackend;
	readonly sessionStore: MemorySessionStore;
	/** Each seeded stage's session id, in seeding order. */
	readonly sessionIds: readonly string[];
}

/**
 * The journal and session store a process leaves behind when it stops while its stages wait between turns: each stage
 * prompted once (its answer recorded) and then waited released, as `stage_waiting` records it. `failed`: the run was
 * left failed and resumable instead, as `/workflow resume` finds a run that failed or blocked.
 */
async function seedStoppedRun(stages: readonly SeededStage[], failed = false): Promise<SeededRun> {
	const runId = crypto.randomUUID();
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1_000,
		...(failed
			? { status: "failed", resumable: true, error: "the stage's store was unreachable" }
			: { status: "running" }),
	});
	const sessionStore = new MemorySessionStore();
	const sessionIds: string[] = [];
	for (const [index, seeded] of stages.entries()) {
		const manager = await SessionManager.create(
			seeded.saved === false ? new MemorySessionStore() : sessionStore,
			"/",
		);
		await manager.appendMessage({ role: "user", content: `plan ${seeded.name}`, timestamp: 1 });
		await manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `planned ${seeded.name}` }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionId = manager.getSessionId();
		sessionIds.push(sessionId);
		const deps = (now: number): DurableStageDeps => ({
			workflowId: runId,
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			nextReplayKey: createStageReplayKeyGenerator(runId),
			now: () => now,
			...(seeded.ownerRunId === undefined
				? {}
				: {
						runTopology: {
							runId: seeded.ownerRunId,
							runName: "pool child",
							parentRunId: runId,
							rootRunId: runId,
						},
					}),
		});
		const stage: StageSnapshot = {
			id: `stage-${index}`,
			name: seeded.name,
			replayKey: `stage:${seeded.name}:1`,
			status: "completed",
			parentIds: [],
			toolEvents: [],
			startedAt: 1_000,
			endedAt: 2_000,
			durationMs: 1_000,
			result: `planned ${seeded.name}`,
			sessionId,
		};
		if (seeded.promptsCompleted > 0) await recordStageCheckpoint(deps(2_000), stage);
		await recordStageSessionCheckpoint(
			deps(3_000),
			{
				...stage,
				status: "waiting",
				wait: { kind: seeded.kind, since: 3_000, promptsCompleted: seeded.promptsCompleted },
			},
			{ force: true },
		);
	}
	return { runId, journal, backend, sessionStore, sessionIds };
}

function countJournalWrites(journal: MemoryRunJournal): () => number {
	const spies = JOURNAL_WRITES.map((method) => vi.spyOn(journal, method));
	return () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

/** A workflow whose body notes that it ran and prompts one new stage, which {@link PROMPT_ONLY} answers. */
function bodyOnly(): { readonly definition: Parameters<typeof run>[0]; readonly ran: () => boolean } {
	let ran = false;
	return {
		definition: workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				ran = true;
				await ctx.stage("plain").prompt("go");
				return {};
			},
		}),
		ran: () => ran,
	};
}

/** The live snapshot `/workflow resume` continues a failed or blocked run from. */
function failedSource(runId: string): RunSnapshot {
	return {
		id: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		startedAt: 1_000,
		status: "failed",
		stages: [],
		toolNodes: [],
		resumable: true,
	};
}

/** Answers prompts without a session, so any read of the store is the preflight's. */
const PROMPT_ONLY: Pick<NonNullable<RunOpts["adapters"]>, "prompt"> = { prompt: { prompt: async () => "done" } };

describe("resuming stages that waited between turns (#4309)", () => {
	test("a resumed stage that waited after stage.release() answers its finished prompt from the record and sends its next message as written (#4309)", async () => {
		const seeded = await seedStoppedRun([
			{ name: "alpha", kind: "release", promptsCompleted: 1 },
			{ name: "beta", kind: "idle", promptsCompleted: 1 },
		]);
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const events: StageLifecycleEvent[] = [];
		const answers: string[] = [];
		const shownBeforeFirstCall: (string | undefined)[] = [];
		const definition = workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				for (const name of ["alpha", "beta"]) {
					const stage = ctx.stage(name);
					shownBeforeFirstCall.push(
						store.runs()[0]?.stages.find((snapshot) => snapshot.name === name)?.wait?.kind,
					);
					answers.push(await stage.prompt(`plan ${name}`));
					if (name === "alpha") await stage.release();
					await stage.sendUserMessage(`report ${name}`);
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
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);

		assert.equal(result.status, "completed", result.error);
		// Each stage showed its wait as soon as it existed, before any of its calls ran.
		assert.deepEqual(shownBeforeFirstCall, ["release", "idle"]);
		assert.deepEqual(answers, ["planned alpha", "planned beta"]);
		// Nothing was prompted again: each stage was sent only its next message, in its own reopened session.
		assert.deepEqual(Object.fromEntries(seen.userPrompts), { alpha: 1, beta: 1 });
		assert.equal(seen.created, 2);
		const transcript = await seeded.sessionStore.load(seeded.sessionIds[0]!);
		assert.deepEqual(
			transcript.entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
			),
			["plan alpha", "report alpha"],
		);
		assert.deepEqual(
			events.map((event) => [event.type, event.stageName, event.wait.kind]),
			[
				["stage_waiting", "alpha", "release"],
				["stage_rehydrated", "alpha", "release"],
				["stage_waiting", "beta", "idle"],
				["stage_rehydrated", "beta", "idle"],
			],
		);
		assert.deepEqual(
			result.stages.map((stage) => [stage.name, stage.status, stage.result]),
			[
				["alpha", "completed", "planned alpha"],
				["beta", "completed", "planned beta"],
			],
		);
	});

	test("a resume fails before taking its lease or writing when waiting stages' sessions are gone, naming every one (#4309)", async () => {
		const seeded = await seedStoppedRun([
			{ name: "alpha", kind: "release", promptsCompleted: 1, saved: false },
			{ name: "beta", kind: "tool", promptsCompleted: 0 },
			{ name: "gamma", kind: "idle", promptsCompleted: 1, saved: false },
		]);
		const reads = vi.spyOn(seeded.sessionStore, "readHeader");
		const journalWrites = countJournalWrites(seeded.journal);
		let sessionsCreated = 0;
		let bodyRan = false;
		const store = createStore();

		const failure = await run(
			workflow({
				name: WORKFLOW_NAME,
				description: "",
				inputs: {},
				outputs: {},
				run: async () => {
					bodyRan = true;
					return {};
				},
			}),
			{},
			{
				runId: seeded.runId,
				store,
				durableBackend: seeded.backend,
				adapters: {
					sessionStore: seeded.sessionStore,
					agentSession: {
						create: async () => {
							sessionsCreated += 1;
							throw new Error("no session may be created");
						},
					},
				},
			},
		).then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(failure instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(failure));
		assert.equal(failure.code, "session-not-found");
		assert.equal(failure.retryable, false);
		assert.deepEqual(failure.fields.sessionIds, [seeded.sessionIds[0], seeded.sessionIds[2]]);
		assert.equal(failure.fields.storage, "SDK sessionStore option: memory");
		assert.ok(failure.hint.includes("SDK sessionStore option: memory"));
		assert.ok(failure.hint.includes(SHARED_STORAGE_JOIN_HINT), failure.hint);
		// One header read per waiting stage, and nothing else: no write, no lease, no session, no workflow code.
		assert.equal(reads.mock.calls.length, 3);
		assert.equal(journalWrites(), 0);
		assert.equal(sessionsCreated, 0);
		assert.equal(bodyRan, false);
		assert.equal(store.runs().length, 0);
		await seeded.backend.close();
	});

	test("a run with no waiting stages reads no session before it starts (#4309)", async () => {
		const seeded = await seedStoppedRun([]);
		const reads = vi.spyOn(seeded.sessionStore, "readHeader");
		const result = await run(
			workflow({
				name: WORKFLOW_NAME,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("plain").prompt("go");
					return {};
				},
			}),
			{},
			{
				runId: seeded.runId,
				store: createStore(),
				durableBackend: seeded.backend,
				// Answered without a session, so any read of the store would be the preflight's.
				adapters: { sessionStore: seeded.sessionStore, prompt: { prompt: async () => "done" } },
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(reads.mock.calls.length, 0);
		await seeded.backend.close();
	});

	test("a resume that continues a failed or blocked run fails the same preflight before taking its lease or writing (#4309)", async () => {
		const seeded = await seedStoppedRun([
			{ name: "alpha", kind: "release", promptsCompleted: 1, saved: false },
			{ name: "beta", kind: "tool", promptsCompleted: 0 },
			{ name: "gamma", kind: "idle", promptsCompleted: 1, saved: false },
		]);
		const reads = vi.spyOn(seeded.sessionStore, "readHeader");
		const journalWrites = countJournalWrites(seeded.journal);
		const body = bodyOnly();
		const store = createStore();

		const failure = await run(
			body.definition,
			{},
			{
				runId: seeded.runId,
				store,
				durableBackend: seeded.backend,
				continuation: { source: failedSource(seeded.runId) },
				adapters: { sessionStore: seeded.sessionStore, ...PROMPT_ONLY },
			},
		).then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(isStageRehydrationError(failure));
		assert.equal(failure.code, "session-not-found");
		assert.deepEqual(failure.fields.sessionIds, [seeded.sessionIds[0], seeded.sessionIds[2]]);
		assert.equal(reads.mock.calls.length, 3);
		assert.equal(journalWrites(), 0);
		assert.equal(body.ran(), false);
		assert.equal(store.runs().length, 0);
		await seeded.backend.close();
	});

	test("a child run reads no session of the stages its root left waiting (#4309)", async () => {
		const seeded = await seedStoppedRun([{ name: "alpha", kind: "release", promptsCompleted: 1, saved: false }]);
		const reads = vi.spyOn(seeded.sessionStore, "readHeader");
		const body = bodyOnly();

		await run(
			body.definition,
			{},
			{
				runId: seeded.runId,
				store: createStore(),
				durableBackend: seeded.backend,
				parentRun: { runId: crypto.randomUUID(), stageId: "parent-stage", rootRunId: crypto.randomUUID() },
				adapters: { sessionStore: seeded.sessionStore, ...PROMPT_ONLY },
			},
		).catch((error: Error) => assert.ok(!isStageRehydrationError(error), error.message));

		assert.equal(reads.mock.calls.length, 0);
		assert.equal(body.ran(), true);
		await seeded.backend.close();
	});

	test("a pooled root is not refused for a waiting stage of its pool, whose session the pool's store keeps (#4309)", async () => {
		const seeded = await seedStoppedRun([
			{ name: "own", kind: "release", promptsCompleted: 1 },
			{ name: "pooled", kind: "tool", promptsCompleted: 0, saved: false, ownerRunId: crypto.randomUUID() },
		]);
		const reads = vi.spyOn(seeded.sessionStore, "readHeader");
		const body = bodyOnly();

		const result = await run(
			body.definition,
			{},
			{
				runId: seeded.runId,
				store: createStore(),
				durableBackend: seeded.backend,
				continuation: { source: failedSource(seeded.runId) },
				adapters: { sessionStore: seeded.sessionStore, ...PROMPT_ONLY },
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(body.ran(), true);
		// Only the root's own waiting stage was looked up; the pool's stage reopens from the pool's store.
		assert.deepEqual(
			reads.mock.calls.map(([sessionId]) => sessionId),
			[seeded.sessionIds[0]],
		);
		await seeded.backend.close();
	});

	test("/workflow resume of a run whose waiting stages' sessions are gone fails at startup with the typed reason, having written nothing (#4309)", async () => {
		const seeded = await seedStoppedRun(
			[
				{ name: "alpha", kind: "release", promptsCompleted: 1, saved: false },
				{ name: "beta", kind: "tool", promptsCompleted: 0 },
			],
			true,
		);
		// The next process opens the journal its predecessor left.
		const backend = await JournalDurableBackend.open(seeded.journal);
		const reads = vi.spyOn(seeded.sessionStore, "readHeader");
		const journalWrites = countJournalWrites(seeded.journal);
		const statusCommits = vi.spyOn(backend, "commitWorkflowStatusTransition");
		const body = bodyOnly();
		const store = createStore();
		let beforeResume = 0;

		const result = await resumeDurableWorkflow(seeded.runId, {
			registry: createRegistry([body.definition as unknown as WorkflowDefinition]),
			durableBackend: backend,
			onBeforeResume: async () => {
				beforeResume += 1;
			},
			baseRunOpts: {
				store,
				adapters: { sessionStore: seeded.sessionStore, ...PROMPT_ONLY },
				continuation: { source: failedSource(seeded.runId) },
			},
		});

		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.reason === "startup_failed");
		assert.ok(result.message.includes("(session-not-found)"), result.message);
		assert.ok(result.message.includes(SHARED_STORAGE_JOIN_HINT), result.message);
		assert.ok(result.message.includes(seeded.sessionIds[0]!), result.message);
		assert.equal(reads.mock.calls.length, 2);
		assert.equal(journalWrites(), 0);
		assert.equal(statusCommits.mock.calls.length, 0);
		assert.equal(beforeResume, 0);
		assert.equal(body.ran(), false);
		assert.equal(backend.getWorkflow(seeded.runId)?.status, "failed");
		// One close for both: the journal they share closes with it.
		await backend.close();
	});
});
