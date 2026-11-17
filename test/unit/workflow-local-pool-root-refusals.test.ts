import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { QuestionnaireResult } from "../../packages/coding-agent/src/index.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { bindRunDurableBackend } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { PiUISurface } from "../../packages/workflows/src/extension/ui-surface.js";
import { bindWorkflowHumanInput } from "../../packages/workflows/src/extension/workflow-human-input.js";
import {
	rehydrateError,
	type SerializedError,
	serializeError,
} from "../../packages/workflows/src/shared/error-codec.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { adoptStageUiBroker, type StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import type {
	CoordinatorCommand,
	CoordinatorEvent,
	CoordinatorInbound,
	CoordinatorRequestBody,
	PoolActivityUpdate,
	PoolWorkToken,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { type HeldPromptAnswers, promptIdentity } from "../../packages/workflows/src/workers/held-prompt-answers.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { type PublishedRun, RunChangesEncoder } from "../../packages/workflows/src/workers/run-changes.js";
import { PoolStageHandoff, type PoolStageQueue } from "../../packages/workflows/src/workers/stage-handoff.js";
import type { PooledStageQuestion, PromptResult } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { publicationRejected, staleWorkLease } from "../helpers/pool-errors.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = testRunId("local-pool-root-refusals");
const fixture = poolWorkFixture();
const descriptor = fixture.work;
const boundary: DurableStageCheckpoint = JSON.parse(JSON.stringify(fixture.boundary).replaceAll('"root"', `"${ROOT}"`));
/** How long a reply of the root may take on a loaded runner; the replies this file waits for need only microtasks. */
const REPLY_TIMEOUT_MS = 10_000;

afterEach(() => {
	vi.restoreAllMocks();
});

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "running", parentIds: [], toolEvents: [], ...overrides };
}

function childRun(stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: descriptor.childRunId,
		name: descriptor.childRunId,
		inputs: {},
		status: "running",
		stages,
		toolNodes: [],
		startedAt: 0,
		parentRunId: ROOT,
		parentStageId: descriptor.boundaryId,
		rootRunId: ROOT,
		...overrides,
	};
}

/** The parts of a pool this file drives directly, as its coordinator and the root's store would. */
interface PoolInternals {
	root?: string;
	store?: Store;
	coordinator?: { readonly port: { send(message: CoordinatorInbound): void } };
	handoff?: PoolStageHandoff;
	questionBroker?: StageUiBroker;
	readonly works: Map<string, PoolWork>;
	readonly heldAnswers: HeldPromptAnswers;
	queueView(): PoolStageQueue;
	receive(event: CoordinatorEvent): Promise<void>;
	applyHeldAnswer(runId: string, stageId: string, heldGeneration: number): void;
}

type RequestReply = Extract<CoordinatorInbound, { readonly kind: "request-reply" }>;

interface RootPoolOptions {
	/** Whether the root has a store, and so a stage handoff; without one it only keeps a coordinator's work. */
	readonly handoff?: boolean;
	readonly question?: PooledStageQuestion;
	readonly answerResult?: () => PromptResult;
}

/** A pool bound to a root whose journal holds one claimed work, with a coordinator that only records what it is sent. */
async function rootPool(options: RootPoolOptions = {}) {
	const directory = makeTempDirectory("local-pool-root-refusals-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: ROOT,
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire(ROOT, backend.holderId);
	if (acquired.status !== "acquired") throw new Error("No root lease");
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(acquired.lease, 60_000);
	await queue.enqueue(acquired.lease, descriptor, boundary);
	const work = await queue.claim(acquired.lease, "worker-one", [descriptor], 60_000);
	assert.ok(work);
	const store = createStore();
	const root: RunSnapshot = {
		id: ROOT,
		name: ROOT,
		inputs: {},
		status: "running",
		rootRunId: ROOT,
		toolNodes: [],
		startedAt: 0,
		stages: [
			stage(descriptor.boundaryId, {
				name: "child",
				workflowChildRun: { alias: "child", workflow: "child", runId: descriptor.childRunId },
			}),
		],
	};
	bindRunDurableBackend(root, backend);
	bindStoreDurableBackend(store, backend);
	store.recordRunStart(root);
	const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
	const internals = pool as never as PoolInternals;
	const sent: CoordinatorInbound[] = [];
	let requestSequence = 0;
	// A pool hears its coordinator only once it prepared its root and connected to it.
	internals.root = ROOT;
	internals.store = store;
	internals.coordinator = {
		port: {
			send(message) {
				sent.push(message);
				if ("id" in message && "kind" in message && message.kind !== "request-reply")
					queueMicrotask(
						() =>
							void internals.receive({
								kind: "reply",
								id: message.id,
								value:
									message.kind === "stage-question"
										? options.question
										: message.kind === "stage-answer"
											? (options.answerResult?.() ?? { ok: true })
											: { ok: true },
							}),
					);
			},
		},
	};
	if (options.handoff !== false)
		internals.handoff = new PoolStageHandoff(backend, store, internals.queueView(), acquired.lease);
	let batch = 0;
	const tokenOf = (overrides: Partial<PoolWorkToken> = {}): PoolWorkToken => ({
		id: work.id,
		generation: work.generation,
		worker: work.worker,
		epoch: work.epoch,
		renewedAt: work.renewedAt,
		expiresAt: work.expiresAt,
		...overrides,
	});
	return {
		store,
		work,
		sent,
		internals,
		tokenOf,
		/** The root learns of the work from its enqueue, so a coordinator's attempt of it is tracked. */
		known: () => internals.works.set(work.id, work),
		/** The refusals the root sent for the activity of one attempt of the work. */
		async publish(runs: readonly PublishedRun[], token: PoolWorkToken = tokenOf()) {
			const entries: PoolActivityUpdate[] = [{ work: token, runs }];
			const id = ++batch;
			await internals.receive({ kind: "activity", batch: id, entries });
			const published = sent.find((message) => message.kind === "published" && message.batch === id);
			assert.ok(published?.kind === "published", `the root published batch ${id}`);
			return published.rejected;
		},
		/** The root's answer to one request of its coordinator. */
		async request(body: CoordinatorRequestBody): Promise<RequestReply> {
			const id = 1_000 + ++requestSequence;
			await internals.receive({ kind: "request", id, request: body });
			return await vi.waitFor(
				() => {
					const reply = sent.find(
						(message): message is RequestReply => message.kind === "request-reply" && message.id === id,
					);
					assert.ok(reply, `the root answered request ${id}`);
					return reply;
				},
				{ timeout: REPLY_TIMEOUT_MS, interval: 5 },
			);
		},
		/** The commands of one kind the root sent its coordinator. */
		commands: <K extends CoordinatorCommand["kind"]>(kind: K) =>
			sent.filter((message): message is Extract<CoordinatorCommand, { kind: K }> => message.kind === kind),
		async dispose() {
			// No coordinator ever ran to answer the pool's close.
			internals.coordinator = undefined;
			await pool.close();
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

/** A turn of the event loop: every promise the pool chained from what it just received has settled by then. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function rejection(reply: RequestReply): Error {
	assert.ok(reply.error !== undefined, "the root refused the request");
	return rehydrateError(reply.error);
}

test("a publication the stage handoff refuses reaches the coordinator typed, with the attempt it was refused for (#4327)", async () => {
	const pool = await rootPool();
	try {
		pool.known();
		const attempt = { root: ROOT, workId: pool.work.id, generation: pool.work.generation };
		const stray = childRun([stage("b")], {
			id: "stray-run",
			parentRunId: descriptor.childRunId,
			parentStageId: "no-such-stage",
		});
		const rejected = await pool.publish([childRun([stage("a")]), stray]);
		assert.equal(rejected.length, 1);
		const [refusal] = rejected;
		assert.deepEqual([refusal!.workId, refusal!.generation], [attempt.workId, attempt.generation]);
		publicationRejected({ ...attempt, reason: "outside-subtree", runId: "stray-run" })(
			rehydrateError(refusal!.error),
		);
		assert.equal(
			pool.store.run(descriptor.childRunId),
			undefined,
			"nothing of a refused publication reaches the store",
		);
	} finally {
		await pool.dispose();
	}
});

test("the root's view of the attempt refuses a publication of another attempt, worker or epoch, typed (#4327)", async () => {
	const pool = await rootPool();
	try {
		pool.known();
		const attempt = { root: ROOT, workId: pool.work.id };
		const refusedWith = async (
			token: ReturnType<typeof pool.tokenOf>,
			reason: "generation-mismatch" | "worker-mismatch" | "epoch-mismatch",
		) => {
			const rejected = await pool.publish([childRun([stage("a")])], token);
			assert.equal(rejected.length, 1, reason);
			assert.deepEqual([rejected[0]!.workId, rejected[0]!.generation], [attempt.workId, token.generation], reason);
			const error = rehydrateError(rejected[0]!.error);
			publicationRejected({ ...attempt, generation: token.generation, reason: "stale-lease" })(error);
			staleWorkLease({ ...attempt, generation: token.generation, reason })(error.cause);
		};
		const first = pool.tokenOf({ generation: 2 });
		assert.deepEqual(
			await pool.publish([childRun([stage("a")])], first),
			[],
			"the first attempt the root hears of is current",
		);
		await refusedWith(pool.tokenOf({ generation: 1 }), "generation-mismatch");
		await refusedWith({ ...first, worker: "worker-two" }, "worker-mismatch");
		await refusedWith({ ...first, epoch: first.epoch + 1 }, "epoch-mismatch");
		assert.deepEqual(
			await pool.publish([childRun([stage("a")])], first),
			[],
			"the current attempt is still accepted",
		);
	} finally {
		await pool.dispose();
	}
});

test("a request of a tracked attempt is answered by the stage handoff, with its own typed refusals (#4327)", async () => {
	const pool = await rootPool();
	try {
		pool.known();
		const sessionId = "session-a";
		assert.deepEqual(await pool.publish([childRun([stage("stage", { sessionId })])]), []);
		const token = pool.tokenOf();
		const run = descriptor.childRunId;
		const attempt = { root: ROOT, workId: token.id, generation: token.generation };

		const ready = await pool.request({
			kind: "ready",
			work: token,
			runId: run,
			stageId: "stage",
			stageName: "stage",
			sessionId,
		});
		assert.equal(ready.error, undefined, "a stage with nothing queued is ready at once");

		const unpublished = rejection(
			await pool.request({
				kind: "ready",
				work: token,
				runId: "unpublished-run",
				stageId: "stage",
				stageName: "stage",
			}),
		);
		publicationRejected({ ...attempt, reason: "outside-subtree", runId: "unpublished-run" })(unpublished);

		const recipient = { sessionId: "session-b", receivedMessageIds: [] };
		const mismatched = rejection(
			await pool.request({
				kind: "deliver",
				work: token,
				runId: run,
				stageId: "stage",
				stageName: "stage",
				recipient,
			}),
		);
		publicationRejected({
			...attempt,
			reason: "session-mismatch",
			runId: run,
			stageId: "stage",
			sessionId: "session-b",
		})(mismatched);
	} finally {
		await pool.dispose();
	}
});

test("a pool without a stage handoff refuses even a tracked attempt's request as a missing work lease (#4327)", async () => {
	const pool = await rootPool({ handoff: false });
	try {
		pool.known();
		const token = pool.tokenOf();
		const refused = rejection(
			await pool.request({
				kind: "ready",
				work: token,
				runId: descriptor.childRunId,
				stageId: "stage",
				stageName: "stage",
			}),
		);
		staleWorkLease({ root: ROOT, workId: token.id, generation: token.generation, reason: "missing" })(refused);
	} finally {
		await pool.dispose();
	}
});

test("a prompt failure held for an earlier attempt fails the replacement's routed prompt with that same typed error (#4327)", async () => {
	const pool = await rootPool();
	try {
		pool.known();
		const prompt: PendingPrompt = { id: "prompt-1", kind: "input", message: "Which branch?", createdAt: 0 };
		const replacement = pool.tokenOf({ generation: 2 });
		// The replacement attempt asks the prompt, and the root routes it to whoever answers it.
		assert.deepEqual(await pool.publish([childRun([stage("ask", { pendingPrompt: prompt })])], replacement), []);
		assert.deepEqual(pool.commands("stage-answer"), [], "nobody answered the prompt yet");

		// The earlier attempt's UI failure came back refused: it is held, and settles the prompt the replacement asks.
		const failure = new StaleWorkLeaseError({ root: ROOT, workId: pool.work.id, generation: 1, reason: "expired" });
		pool.internals.heldAnswers.hold(descriptor.childRunId, "ask", {
			kind: "prompt",
			generation: 1,
			promptId: prompt.id,
			identity: promptIdentity(prompt),
			error: failure,
		});
		pool.internals.applyHeldAnswer(descriptor.childRunId, "ask", 1);
		await settled();

		const [answer] = pool.commands("stage-answer");
		assert.ok(answer, "the prompt failed in its worker");
		assert.equal(answer.runId, descriptor.childRunId);
		assert.equal(answer.stageId, "ask");
		assert.equal(answer.answer.kind, "failed");
		assert.equal(answer.answer.promptId, prompt.id);
		const sent: SerializedError = (answer.answer as { readonly error: SerializedError }).error;
		staleWorkLease({ root: ROOT, workId: pool.work.id, generation: 1, reason: "expired" })(rehydrateError(sent));
		assert.equal(pool.commands("stage-answer").length, 1, "the prompt fails once");
	} finally {
		await pool.dispose();
	}
});

test.each([true, false])("an SDK host answers a worker-published stage dialog with %s (#5354)", async (response) => {
	const pool = await rootPool();
	const broker = adoptStageUiBroker({}, false, pool.store);
	const asked: string[] = [];
	const reply = Promise.withResolvers<boolean>();
	const unbind = bindWorkflowHumanInput(
		pool.store,
		{
			hasUI: false,
			hasHumanInput: true,
			ui: {
				confirm: async (title, message) => {
					asked.push(`${title}:${message}`);
					return reply.promise;
				},
			},
		},
		broker,
	);
	try {
		pool.known();
		const prompt: PendingPrompt = {
			id: "dialog-1",
			kind: "confirm",
			source: "stage-dialog",
			message: "Allow worker action?",
			createdAt: Date.now(),
		};
		assert.deepEqual(
			await pool.publish([childRun([stage("ask", { status: "awaiting_input", pendingPrompt: prompt })])]),
			[],
		);
		await settled();
		assert.equal(broker.hasStageDialog(descriptor.childRunId, "ask"), false);
		assert.deepEqual(asked, ["Workflow approval:Allow worker action?"]);
		assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt?.id, prompt.id);
		assert.deepEqual(pool.commands("stage-answer"), []);

		reply.resolve(response);
		await settled();
		const [answer] = pool.commands("stage-answer");
		assert.ok(answer, "the host's answer reaches the waiting worker");
		assert.equal(answer.runId, descriptor.childRunId);
		assert.equal(answer.stageId, "ask");
		assert.deepEqual(answer.answer, { kind: "prompt", promptId: prompt.id, response });
		assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt, undefined);
		assert.equal(pool.commands("stage-answer").length, 1);
		assert.deepEqual(asked, ["Workflow approval:Allow worker action?"]);
	} finally {
		unbind();
		await pool.dispose();
	}
});

test.each(["store", "SDK host"] as const)(
	"a worker receives consecutive dialog answers in one attempt through the %s (#5354)",
	async (answerPath) => {
		const pool = await rootPool();
		const broker = adoptStageUiBroker({}, false, pool.store);
		const asked: string[] = [];
		const replies: ReturnType<typeof Promise.withResolvers<boolean>>[] = [];
		const unbind =
			answerPath === "SDK host"
				? bindWorkflowHumanInput(
						pool.store,
						{
							hasUI: false,
							hasHumanInput: true,
							ui: {
								confirm: async (_title, message) => {
									asked.push(message);
									const reply = Promise.withResolvers<boolean>();
									replies.push(reply);
									return reply.promise;
								},
							},
						},
						broker,
					)
				: () => {};
		try {
			pool.known();
			for (const index of [1, 2]) {
				const prompt: PendingPrompt = {
					id: `dialog-${index}`,
					kind: "confirm",
					source: "stage-dialog",
					message: `Allow worker action ${index}?`,
					createdAt: Date.now(),
				};
				const publication = childRun([stage("ask", { status: "awaiting_input", pendingPrompt: prompt })]);
				assert.deepEqual(await pool.publish([publication]), []);
				await settled();
				assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt?.id, prompt.id);
				const response = index === 1;
				if (answerPath === "SDK host") {
					assert.equal(replies.length, index);
					replies[index - 1]!.resolve(response);
				} else {
					assert.equal(
						pool.store.resolveStagePendingPrompt(descriptor.childRunId, "ask", prompt.id, response),
						true,
					);
				}
				await settled();
				assert.deepEqual(
					pool.commands("stage-answer").map(({ answer }) => answer),
					[
						{ kind: "prompt", promptId: "dialog-1", response: true },
						...(index === 2 ? [{ kind: "prompt", promptId: "dialog-2", response: false }] : []),
					],
				);
				assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt, undefined);
				assert.deepEqual(await pool.publish([childRun([stage("ask")])]), []);
				await settled();
				assert.equal(pool.commands("stage-answer").length, index, "an answered prompt is not delivered twice");
			}
			assert.deepEqual(asked, answerPath === "SDK host" ? ["Allow worker action 1?", "Allow worker action 2?"] : []);
		} finally {
			unbind();
			await pool.dispose();
		}
	},
);

test.each(["SDK host", "store"] as const)(
	"a worker dialog answered through the %s is not asked again by a queued full publication (#5354)",
	async (answerPath) => {
		const pool = await rootPool();
		const broker = adoptStageUiBroker({}, false, pool.store);
		const encoder = new RunChangesEncoder();
		const replies: ReturnType<typeof Promise.withResolvers<boolean>>[] = [];
		const unbind = bindWorkflowHumanInput(
			pool.store,
			{
				hasUI: false,
				hasHumanInput: true,
				ui: {
					confirm: async () => {
						const reply = Promise.withResolvers<boolean>();
						replies.push(reply);
						return reply.promise;
					},
				},
			},
			broker,
		);
		try {
			pool.known();
			const prompt: PendingPrompt = {
				id: "dialog-1",
				kind: "confirm",
				source: "stage-dialog",
				message: "Allow worker action?",
				createdAt: Date.now(),
			};
			const parallel = stage("parallel", {
				workflowChildRun: { alias: "extra", workflow: "extra", runId: `${descriptor.childRunId}-extra` },
			});
			const publication = childRun([stage("ask", { status: "awaiting_input", pendingPrompt: prompt }), parallel]);
			assert.deepEqual(await pool.publish(encoder.encode(pool.work, [publication])), []);
			await settled();
			assert.equal(replies.length, 1);
			const extra = childRun([stage("extra")], {
				id: `${descriptor.childRunId}-extra`,
				parentRunId: descriptor.childRunId,
				parentStageId: "parallel",
			});
			const queued = encoder.encode(pool.work, [publication, extra]);
			if (answerPath === "SDK host") replies[0]!.resolve(true);
			else assert.equal(pool.store.resolveStagePendingPrompt(descriptor.childRunId, "ask", prompt.id, true), true);
			await settled();
			assert.equal(pool.commands("stage-answer").length, 1);

			assert.deepEqual(await pool.publish(queued), []);
			await settled();
			assert.equal(replies.length, 1, "the already answered dialog is not presented again");
			assert.equal(pool.commands("stage-answer").length, 1);

			const next = childRun([
				stage("ask", { status: "awaiting_input", pendingPrompt: { ...prompt, id: "dialog-2" } }),
				parallel,
			]);
			assert.deepEqual(await pool.publish(encoder.encode(pool.work, [next, extra])), []);
			await settled();
			assert.equal(replies.length, 2, "a genuinely new dialog with the same text is still presented");
			replies[1]!.resolve(false);
			await settled();
			assert.deepEqual(
				pool.commands("stage-answer").map(({ answer }) => answer),
				[
					{ kind: "prompt", promptId: "dialog-1", response: true },
					{ kind: "prompt", promptId: "dialog-2", response: false },
				],
			);
		} finally {
			unbind();
			await pool.dispose();
		}
	},
);

test.each(["question-first", "dialog-first", "same-publication"] as const)(
	"an SDK host keeps a worker's stacked requests live in %s order (#5354)",
	async (order) => {
		const question: PooledStageQuestion = {
			promptId: "question-1",
			kind: "ask_user_question",
			params: {
				questions: [
					{
						question: "Choose",
						header: "Choice",
						options: [
							{ label: "A", description: "First" },
							{ label: "B", description: "Second" },
						],
					},
				],
			},
		};
		const pool = await rootPool({ question });
		const broker = adoptStageUiBroker({}, false, pool.store);
		pool.internals.questionBroker = broker;
		const dialogReply = Promise.withResolvers<boolean>();
		const nextDialogReply = Promise.withResolvers<boolean>();
		const questionReply = Promise.withResolvers<QuestionnaireResult>();
		const dialogSignals: AbortSignal[] = [];
		const questionSignals: AbortSignal[] = [];
		const scopedSessions: Array<string | undefined> = [];
		const confirm = async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
			assert.ok(options?.signal);
			dialogSignals.push(options.signal);
			return dialogSignals.length === 1 ? dialogReply.promise : nextDialogReply.promise;
		};
		const ui = {
			confirm,
			[Symbol.for("atomic-coding-agent/workflow-input@1")]: {
				active: () => true,
				available: () => true,
				bindingRevision: () => 0,
				subscribe: () => () => {},
				scope: (_runId: string, _stageId: string, sessionId?: string) => {
					scopedSessions.push(sessionId);
					return {
						ui: { confirm },
						questionnaire: (_params: typeof question.params, signal: AbortSignal) => {
							questionSignals.push(signal);
							return questionReply.promise;
						},
					};
				},
			},
		} as PiUISurface;
		const unbind = bindWorkflowHumanInput(pool.store, { hasUI: false, hasHumanInput: true, ui }, broker);
		const prompt: PendingPrompt = {
			id: "dialog-1",
			kind: "confirm",
			source: "stage-dialog",
			message: "Allow worker action?",
			createdAt: Date.now(),
		};
		const inputRequest = buildStagePromptAdapter(
			question.promptId,
			question.kind,
			question.params,
			Date.now(),
		)!.prompt;
		const publish = async (withQuestion: boolean, withDialog: boolean, dialog = prompt) => {
			assert.deepEqual(
				await pool.publish([
					childRun([
						stage("ask", {
							sessionId: "worker-session",
							status: withQuestion || withDialog ? "awaiting_input" : "running",
							...(withQuestion ? { inputRequest } : {}),
							...(withDialog ? { pendingPrompt: dialog } : {}),
						}),
					]),
				]),
				[],
			);
			await settled();
		};
		try {
			pool.known();
			if (order === "question-first") {
				await publish(true, false);
				assert.equal(questionSignals.length, 1);
			} else if (order === "dialog-first") {
				await publish(false, true);
				assert.equal(dialogSignals.length, 1);
			}
			await publish(true, true);
			assert.equal(questionSignals.length, 1);
			assert.equal(dialogSignals.length, 1, "the worker dialog is presented alongside its question");
			assert.equal(questionSignals[0]!.aborted, false);
			assert.equal(dialogSignals[0]!.aborted, false, "adding the question must not withdraw the pending dialog");
			assert.deepEqual(scopedSessions, ["worker-session", "worker-session"]);

			const answer: QuestionnaireResult = {
				cancelled: false,
				answers: [{ questionIndex: 0, question: "Choose", kind: "option", answer: "A" }],
			};
			if (order === "question-first") {
				dialogReply.resolve(true);
				await settled();
				assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.status, "awaiting_input");
				assert.equal(
					questionSignals[0]!.aborted,
					false,
					"the questionnaire stays presented after the dialog answer",
				);
				assert.equal(questionSignals.length, 1);
				questionReply.resolve(answer);
			} else {
				questionReply.resolve(answer);
				await settled();
				assert.equal(dialogSignals[0]!.aborted, false);
				assert.equal(dialogSignals.length, 1, "answering the question must not ask the dialog again");
				assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt?.id, prompt.id);
				dialogReply.resolve(true);
			}
			await settled();
			const inputAnswer = {
				runId: descriptor.childRunId,
				stageId: "ask",
				answer: { kind: "input", promptId: question.promptId, answer: { raw: answer } },
			};
			const dialogAnswer = {
				runId: descriptor.childRunId,
				stageId: "ask",
				answer: { kind: "prompt", promptId: prompt.id, response: true },
			};
			assert.deepEqual(
				pool.commands("stage-answer").map(({ runId, stageId, answer }) => ({ runId, stageId, answer })),
				order === "question-first" ? [dialogAnswer, inputAnswer] : [inputAnswer, dialogAnswer],
			);
			assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt, undefined);
			assert.equal(dialogSignals.length, 1);

			await publish(false, false);
			const nextPrompt: PendingPrompt = { ...prompt, id: "dialog-2", message: "Allow the next worker action?" };
			await publish(false, true, nextPrompt);
			assert.equal(dialogSignals.length, 2);
			assert.equal(dialogSignals[1]!.aborted, false);
			nextDialogReply.resolve(false);
			await settled();
			assert.deepEqual(
				pool.commands("stage-answer").map(({ answer }) => answer),
				[
					...(order === "question-first"
						? [dialogAnswer.answer, inputAnswer.answer]
						: [inputAnswer.answer, dialogAnswer.answer]),
					{ kind: "prompt", promptId: nextPrompt.id, response: false },
				],
			);
			assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.pendingPrompt, undefined);
			assert.equal(questionSignals.length, 1);
		} finally {
			unbind();
			broker.cancelStagePrompt(descriptor.childRunId, "ask", new Error("cleanup"));
			await pool.dispose();
		}
	},
);

test.each([
	["question-then-dialog", "question-only"],
	["dialog-then-question", "question-only"],
	["question-then-dialog", "question-first"],
	["dialog-then-question", "question-first"],
	["question-then-dialog", "dialog-first"],
	["dialog-then-question", "dialog-first"],
	["question-then-dialog", "stacked"],
	["dialog-then-question", "stacked"],
] as const)(
	"a replacement receives a held question answer once with %s SDK answers and a %s publication (#4022)",
	async (order, replacementRequests) => {
		const question: PooledStageQuestion = {
			promptId: "question-1",
			kind: "ask_user_question",
			params: {
				questions: [
					{
						question: "Choose",
						header: "Choice",
						options: [
							{ label: "A", description: "First" },
							{ label: "B", description: "Second" },
						],
					},
				],
			},
		};
		let replacementLive = false;
		const pool = await rootPool({
			question,
			answerResult: () => (replacementLive ? { ok: true } : { ok: false, refusal: "StaleAttempt" }),
		});
		const broker = adoptStageUiBroker({}, false, pool.store);
		pool.internals.questionBroker = broker;
		const dialogReply = Promise.withResolvers<boolean>();
		const questionReply = Promise.withResolvers<QuestionnaireResult>();
		const replacementDialogReply = Promise.withResolvers<boolean>();
		let questionPresentations = 0;
		let dialogPresentations = 0;
		const confirm = async () => {
			dialogPresentations++;
			return dialogPresentations === 1 ? dialogReply.promise : replacementDialogReply.promise;
		};
		const ui = {
			confirm,
			[Symbol.for("atomic-coding-agent/workflow-input@1")]: {
				active: () => true,
				available: () => true,
				bindingRevision: () => 0,
				subscribe: () => () => {},
				scope: () => ({
					ui: { confirm },
					questionnaire: () => {
						questionPresentations++;
						return questionReply.promise;
					},
				}),
			},
		} as PiUISurface;
		const unbind = bindWorkflowHumanInput(pool.store, { hasUI: false, hasHumanInput: true, ui }, broker);
		const prompt: PendingPrompt = {
			id: "dialog-1",
			kind: "confirm",
			source: "stage-dialog",
			message: "Allow worker action?",
			createdAt: Date.now(),
		};
		const inputRequest = buildStagePromptAdapter(
			question.promptId,
			question.kind,
			question.params,
			Date.now(),
		)!.prompt;
		const answer: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Choose", kind: "option", answer: "A" }],
		};
		try {
			pool.known();
			assert.deepEqual(
				await pool.publish([childRun([stage("ask", { status: "awaiting_input", pendingPrompt: prompt })])]),
				[],
			);
			await settled();
			assert.equal(dialogPresentations, 1);
			assert.deepEqual(
				await pool.publish([
					childRun([stage("ask", { status: "awaiting_input", inputRequest, pendingPrompt: prompt })]),
				]),
				[],
			);
			await settled();
			assert.equal(questionPresentations, 1);
			assert.equal(dialogPresentations, 1);
			assert.equal(pool.commands("stage-answer").length, 0);

			if (order === "question-then-dialog") questionReply.resolve(answer);
			else dialogReply.resolve(true);
			await settled();
			assert.equal(pool.commands("stage-answer").length, 1, "the dead attempt refused the first answer");
			if (order === "question-then-dialog") dialogReply.resolve(true);
			else questionReply.resolve(answer);
			await settled();
			assert.deepEqual(
				pool.commands("stage-answer").map(({ answer }) => answer.kind),
				order === "question-then-dialog" ? ["input", "prompt"] : ["prompt", "input"],
			);

			replacementLive = true;
			const replacement = pool.tokenOf({ generation: 2 });
			const replacementDialog: PendingPrompt = { ...prompt, id: "dialog-replacement" };
			if (replacementRequests === "question-first") {
				assert.deepEqual(
					await pool.publish([childRun([stage("ask", { status: "awaiting_input", inputRequest })])], replacement),
					[],
				);
				await settled();
			} else if (replacementRequests === "dialog-first") {
				assert.deepEqual(
					await pool.publish(
						[childRun([stage("ask", { status: "awaiting_input", pendingPrompt: replacementDialog })])],
						replacement,
					),
					[],
				);
				await settled();
				assert.equal(dialogPresentations, 2);
				assert.equal(questionPresentations, 1);
			}
			const publication = childRun([
				stage("ask", {
					status: "awaiting_input",
					inputRequest,
					...(replacementRequests === "question-only" ? {} : { pendingPrompt: replacementDialog }),
				}),
			]);
			assert.deepEqual(await pool.publish([publication], replacement), []);
			await settled();
			assert.equal(questionPresentations, 1, "the replacement must reuse the held answer without asking again");
			assert.equal(dialogPresentations, replacementRequests === "question-only" ? 1 : 2);
			assert.deepEqual(
				pool
					.commands("stage-answer")
					.slice(2)
					.map(({ runId, stageId, answer }) => ({ runId, stageId, answer })),
				[
					{
						runId: descriptor.childRunId,
						stageId: "ask",
						answer: { kind: "input", promptId: question.promptId, answer: { raw: answer } },
					},
				],
			);
			assert.deepEqual(await pool.publish([publication], replacement), []);
			await settled();
			assert.equal(questionPresentations, 1);
			assert.equal(pool.commands("stage-answer").length, 3, "the held question answer reaches the replacement once");
		} finally {
			unbind();
			broker.cancelStagePrompt(descriptor.childRunId, "ask", new Error("cleanup"));
			await pool.dispose();
		}
	},
);

test("a reply to a command nobody waits for any more is ignored (#4327)", async () => {
	const pool = await rootPool();
	try {
		const failed = serializeError(
			new StaleWorkLeaseError({ root: ROOT, workId: "gone", generation: 1, reason: "expired" }),
		);
		await pool.internals.receive({ kind: "reply", id: 4_242, error: failed });
		await pool.internals.receive({ kind: "reply", id: 4_243, value: { ok: true } });
		assert.deepEqual(pool.sent, [], "an ignored reply starts nothing");
	} finally {
		await pool.dispose();
	}
});
