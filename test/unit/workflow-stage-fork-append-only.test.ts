import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	type AssistantMessage,
	type FetchFunction,
	getModel,
	type Message,
	type Model,
	streamSimple,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import {
	FAN_OUT_FORK_SOURCES_SUFFIX,
	FORK_SOURCE_CHECKPOINT_SUFFIX,
	forkSourceCheckpointKey,
	withLaunchForkPoint,
} from "../../packages/workflows/src/durable/stage-fork-point.js";
import {
	createDurableTaskPrimitive,
	createStageReplayKeyGenerator,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createChainPrimitive } from "../../packages/workflows/src/engine/primitives/chain.js";
import { createParallelPrimitive } from "../../packages/workflows/src/engine/primitives/parallel.js";
import type { EngineRuntime } from "../../packages/workflows/src/engine/runtime.js";
import { taskStageOptions } from "../../packages/workflows/src/runs/foreground/executor-task-prompts.js";
import type { ParallelFailFastScope } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import {
	forkStageSession,
	STAGE_FORK_TOOL_RESULT,
	storedForkPoint,
} from "../../packages/workflows/src/shared/stage-session-store.js";
import type {
	StageOptions,
	WorkflowTaskOptions,
	WorkflowTaskResult,
} from "../../packages/workflows/src/shared/types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

const model = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;
const RUN = "fork-point-run";

useTemporaryAgentDir();

afterEach(async () => {
	vi.restoreAllMocks();
	await closeMemoryTestBackends();
});

function sourceTurn(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

async function requestMessages(messages: AgentMessage[]): Promise<unknown[]> {
	let payload: { messages: unknown[] } | undefined;
	await streamSimple(
		{ ...model, baseUrl: "http://127.0.0.1:9" },
		{ messages: convertToLlm(messages) },
		{
			apiKey: "credential-free-test-key",
			reasoning: "xhigh",
			fetch: (async () => {
				throw new Error("payload captured");
			}) as unknown as FetchFunction,
			onPayload: (body) => {
				payload = body as { messages: unknown[] };
			},
		},
	).result();
	if (!payload) throw new Error("no payload was built");
	return payload.messages;
}

/** A source session whose newest turn has signed thinking and a tool call it has not answered yet. */
async function sourceWithOpenCall(): Promise<SessionManager> {
	const source = SessionManager.inMemory();
	await source.appendMessage({ role: "user", content: "Investigate the failure.", timestamp: Date.now() });
	await source.appendMessage(
		sourceTurn([
			{ type: "thinking", thinking: "Read the log first.", thinkingSignature: "sig-log" },
			{ type: "toolCall", id: "toolu_log", name: "bash", arguments: { command: "cat log" } },
		]),
	);
	return source;
}

function fork(source: SessionManager, entryId?: string): Promise<SessionManager> {
	return forkStageSession(source.getSessionStore(), source.getSessionId(), source.getCwd(), {}, undefined, entryId);
}

describe("forked workflow stages copy their source append-only (#5481)", () => {
	test("a forked stage replays its source's last turn unchanged and answers its open tool call (#5481)", async () => {
		const source = await sourceWithOpenCall();
		const inherited = source.buildSessionContext().messages;
		const stage = await fork(source);

		const copied = stage.buildSessionContext().messages;
		assert.deepEqual(copied.slice(0, inherited.length), inherited);
		assert.deepEqual(
			copied.slice(inherited.length).map((message) => {
				assert.equal(message.role, "toolResult");
				return { id: message.toolCallId, text: message.content };
			}),
			[{ id: "toolu_log", text: [{ type: "text", text: STAGE_FORK_TOOL_RESULT }] }],
		);
		// The stage's first request starts with what the source itself would send next.
		await source.appendMessage(toolResult("toolu_log", "the source's own result"));
		const sourceRequest = await requestMessages(source.buildSessionContext().messages);
		const stageRequest = await requestMessages([
			...copied,
			{ role: "user", content: "The stage's prompt.", timestamp: Date.now() },
		]);
		assert.deepEqual(stageRequest.slice(0, 2), sourceRequest.slice(0, 2));
	});

	test("stages launched from one point share the entry captured at launch, also after a resume (#5481)", async () => {
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN,
			name: RUN,
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const source = await sourceWithOpenCall();
		const options: StageOptions = {
			context: "fork",
			forkFromSessionId: source.getSessionId(),
			sessionStore: source.getSessionStore(),
		};
		const launch = (replayKey: string) =>
			withLaunchForkPoint({
				backend,
				workflowId: RUN,
				replayKey,
				options,
				resuming: false,
			});
		const launched = [launch("stage:a"), launch("stage:b")];
		const atLaunch = source.buildSessionContext().messages;
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The source keeps going before either stage starts.
		await source.appendMessage(toolResult("toolu_log", "the source's own result"));
		await source.appendMessage(sourceTurn([{ type: "text", text: "LATER_SOURCE_TURN" }]));

		const points = await Promise.all(launched.map((point) => point?.durableForkPoint?.() ?? point?.forkFromEntryId));
		const stages = await Promise.all(
			points.map((point) => {
				assert.equal(typeof point, "string");
				return fork(source, point!);
			}),
		);
		for (const stage of stages) {
			const messages = stage.buildSessionContext().messages;
			// Each stage holds the source as it was at launch, then answers the call that was open then.
			assert.deepEqual(messages.slice(0, atLaunch.length), atLaunch);
			assert.deepEqual(
				messages.slice(atLaunch.length).map((message) => {
					assert.equal(message.role, "toolResult");
					return { id: message.toolCallId, text: message.content };
				}),
				[{ id: "toolu_log", text: [{ type: "text", text: STAGE_FORK_TOOL_RESULT }] }],
			);
			assert.doesNotMatch(JSON.stringify(messages), /LATER_SOURCE_TURN|the source's own result/);
		}

		// A resumed run launches the stage again; it forks where the first launch did, not where the source is now.
		assert.equal(launch("stage:a")?.forkFromEntryId, points[0]);
		assert.notEqual(points[0], source.getLeafId());
	});

	test("parallel steps that wait for a concurrency slot fork where their source was when the parallel was launched (#5481)", async () => {
		const { source, runner } = await durableParallelRun("parallel-fork-point-run");
		const leafAtLaunch = source.getLeafId();
		const { parallel, forkedAt } = runner();

		await parallel(STEPS, { concurrency: 1, context: "fork", forkFromSessionId: source.getSessionId() });

		assert.deepEqual(
			forkedAt.map(({ name, entry }) => [name, entry]),
			[
				["a", leafAtLaunch],
				["b", leafAtLaunch],
				["c", leafAtLaunch],
			],
		);
	});

	test("parallel steps still queued when the run stops fork at the parallel's launch point after a resume (#5481)", async () => {
		const { source, backend, run, runner } = await durableParallelRun("parallel-fork-point-resume");
		const leafAtLaunch = source.getLeafId();
		const options = { concurrency: 1, context: "fork" as const, forkFromSessionId: source.getSessionId() };
		const stopped = new Error("the run stops after the first step's result is recorded");
		const first = runner({
			afterLiveResult: async () => {
				throw stopped;
			},
		});
		await assert.rejects(first.parallel(STEPS, options), (error) => error === stopped);
		assert.ok(backend.getStageOutput(run, "stage:task:a:1"), "the first step's result is recorded");

		// The resumed run replays `a` from its record and starts the steps that were waiting for a slot.
		const resumed = runner();
		await resumed.parallel(STEPS, options);

		assert.deepEqual(
			[...first.forkedAt, ...resumed.forkedAt].map(({ name, entry }) => [name, entry]),
			[
				["a", leafAtLaunch],
				["b", leafAtLaunch],
				["c", leafAtLaunch],
			],
		);
	});

	test("a retried parallel forks its queued steps at the first launch's point, like the retried step (#5481)", async () => {
		const { source, runner } = await durableParallelRun("parallel-fork-point-retry");
		const leafAtLaunch = source.getLeafId();
		const options = { concurrency: 1, context: "fork" as const, forkFromSessionId: source.getSessionId() };
		const failed = new Error("the first step fails before it has a result");
		const first = runner({ failWith: failed });
		await assert.rejects(first.parallel(STEPS.slice(0, 2), options), (error) => error === failed);

		const retried = runner();
		await retried.parallel(STEPS.slice(0, 2), options);

		assert.deepEqual(
			[...first.forkedAt, ...retried.forkedAt].map(({ name, entry }) => [name, entry]),
			[
				["a", leafAtLaunch],
				["a", leafAtLaunch],
				["b", leafAtLaunch],
			],
		);
	});

	test("a parallel launched later forks at its own launch point, also when it is replayed (#5481)", async () => {
		const { source, runner } = await durableParallelRun("parallel-fork-point-per-launch");
		const options = { concurrency: 1, context: "fork" as const, forkFromSessionId: source.getSessionId() };
		const firstLaunch = source.getLeafId();
		const first = runner();
		await first.parallel(STEPS.slice(0, 1), options);
		// The source moved on while the first parallel ran; the same parallel launched again forks where it is now.
		const secondLaunch = source.getLeafId();
		await first.parallel(STEPS.slice(0, 1), options);
		assert.notEqual(secondLaunch, firstLaunch);
		assert.deepEqual(
			first.forkedAt.map(({ entry }) => entry),
			[firstLaunch, secondLaunch],
		);
	});
});

describe("a parallel's launch fixes its steps' identities and fork point (#5481)", () => {
	test("two parallels with the same step names, launched at different points, each replay their own steps' results and fork points (#5481)", async () => {
		const { source, parallel, forking } = await launchRun();
		const firstPoint = source.getLeafId();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const failed = new Error("the first parallel's b fails after the second parallel finished");
		const run = parallel(async (name, options) => {
			if (options.forkFromEntryId === firstPoint && name === "a") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			if (options.forkFromEntryId === firstPoint && name === "b") throw failed;
			return { stageName: name, text: String(options.forkFromEntryId) };
		});
		const first = run(STEP_PAIR, forking);
		await firstStarted.promise;
		await source.appendMessage(userMessage("before the second launch"));
		const secondPoint = source.getLeafId();
		// The second parallel finishes both of its steps while the first still waits for its slot for b.
		assert.deepEqual(texts(await run(STEP_PAIR, forking)), [secondPoint, secondPoint]);
		releaseFirst.resolve();
		await assert.rejects(first, (error) => error === failed);
		await source.appendMessage(userMessage("after both launches"));

		// The resumed run launches both again in the same order; their steps now start in another order.
		const resumed = parallel(async (name, options) => ({ stageName: name, text: String(options.forkFromEntryId) }));
		const replayed = await Promise.all([resumed(STEP_PAIR, forking), resumed(STEP_PAIR, forking)]);
		assert.deepEqual(replayed.map(texts), [
			[firstPoint, firstPoint],
			[secondPoint, secondPoint],
		]);
	});

	test("two chains with the same step names running at once each replay their own steps' results (#5481)", async () => {
		const { chain } = await launchRun();
		const first = [
			{ name: "a", prompt: "first a" },
			{ name: "b", prompt: "first b" },
		];
		const second = [
			{ name: "a", prompt: "second a" },
			{ name: "b", prompt: "second b" },
		];
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const run = chain(async (name, options) => {
			if (options.prompt === "first a") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return { stageName: name, text: String(options.prompt) };
		});
		const firstChain = run(first);
		await firstStarted.promise;
		// The second chain finishes both steps while the first chain's a still runs.
		assert.deepEqual(texts(await run(second)), ["second a", "second b"]);
		releaseFirst.resolve();
		assert.deepEqual(texts(await firstChain), ["first a", "first b"]);

		// Resumed, both chains replay their recorded results; their a steps now finish in launch order.
		const resumed = chain(async () => assert.fail("every step of both chains has a recorded result"));
		const replayed = await Promise.all([resumed(first), resumed(second)]);
		assert.deepEqual(replayed.map(texts), [
			["first a", "first b"],
			["second a", "second b"],
		]);
	});

	test("a workflow fork of a run starts its parallel's steps where their source was at launch, in the source's copy (#5481)", async () => {
		const { backend, run, store, source, definition, parallel, forking } = await launchRun();
		const sourceId = source.getSessionId();
		// The source is the session of a task of the run, whose result the fork replays with the session's copy.
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: run,
			name: "source",
			replayKey: "stage:task:source:1",
			checkpointId: "task:stage:task:source:1",
			sessionId: sourceId,
			output: { text: "source", stageName: "source", sessionId: sourceId },
			completedAt: 1,
		});
		const launchPoint = source.getLeafId();
		await parallel(async (name, options) => {
			assert.equal(options.forkFromEntryId, launchPoint);
			await source.appendMessage(userMessage(`after launch, during ${name}`));
			return { stageName: name, text: name };
		})(STEP_PAIR, forking);
		await backend.commitWorkflowStatus(run, "completed");
		await backend.releaseWorkflow(run);

		const copies = new MemorySessionStore();
		const fork = await forkDurableRun(backend, {
			source: "sdk",
			runId: run,
			fromStage: "a",
			cwd: process.cwd(),
			carryMessages: "before",
			definition,
			sourceSessionStore: store,
			sessionStore: copies,
		});
		const copiedSource = (backend.getStageOutput(fork.runId, "stage:task:source:1") as { sessionId: string })
			.sessionId;
		assert.notEqual(copiedSource, sourceId);
		const inherited: unknown[][] = [];
		await parallel(
			async (name, options) => {
				inherited.push(await stepConversation(copies, options));
				return { stageName: name, text: name };
			},
			{ runId: fork.runId },
		)(STEP_PAIR, { ...forking, forkFromSessionId: copiedSource, sessionStore: copies });
		assert.deepEqual(inherited, [["before launch"], ["before launch"]]);
	});

	test("a parallel launched while its live source is still empty starts every step empty, also after a resume (#5481)", async () => {
		const { store, source, parallel, forking } = await launchRun({ empty: true });
		assert.equal(source.getLeafId(), null);
		const inherited: unknown[][] = [];
		const step = async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
			inherited.push(await stepConversation(store, options));
			await source.appendMessage(userMessage(`after ${name} started`));
			return { stageName: name, text: name };
		};
		const stopped = new Error("the run stops after a's result is recorded");
		const first = parallel(step, {
			afterLiveResult: async () => {
				throw stopped;
			},
		});
		await assert.rejects(first(STEP_PAIR, forking), (error) => error === stopped);
		await parallel(step)(STEP_PAIR, forking);
		assert.deepEqual(inherited, [[], []]);
	});

	test("a stage launched while its live source is still empty starts empty, also when launched again (#5481)", async () => {
		const { backend, run, store, source } = await launchRun({ empty: true });
		const launched = launchStage(backend, run, source);
		await source.appendMessage(userMessage("after the launch"));
		assert.deepEqual(await stepConversation(store, launched), []);
		// Launched again, as after a resume, the stage reads the empty point the run recorded.
		assert.deepEqual(await stepConversation(store, launchStage(backend, run, source)), []);
	});

	test("a stage whose fork point record cannot be written does not open its session (#5481)", async () => {
		const { backend, run, store, source } = await launchRun();
		const unavailable = failForkRecordOnce(backend, { written: false });
		const launched = launchStage(backend, run, source);
		await assert.rejects(stepConversation(store, launched), (error) => error === unavailable);
	});

	test("a stage launched again after its fork point record was kept, though the write failed, forks at the kept point (#5481)", async () => {
		const { backend, run, store, source } = await launchRun();
		const unavailable = failForkRecordOnce(backend, { written: true });
		await assert.rejects(
			stepConversation(store, launchStage(backend, run, source)),
			(error) => error === unavailable,
		);
		await source.appendMessage(userMessage("before the run resumes"));
		assert.deepEqual(await stepConversation(store, launchStage(backend, run, source)), ["before launch"]);
	});

	test("a stage retry keeps a saved empty prefix after a lost write acknowledgement (#5632)", async () => {
		const { backend, run, store, source } = await launchRun({ empty: true });
		const unavailable = failForkRecordOnce(backend, { written: true });
		const retry = () => stepConversation(store, launchStage(backend, run, source));
		await assert.rejects(retry(), (error) => error === unavailable);
		await source.appendMessage(userMessage("after the empty launch"));
		assert.deepEqual(await retry(), []);
	});

	test("a stage retry recovers an unacknowledged fork point without the original source handle (#5632)", async () => {
		const { backend, run, store } = await launchRun();
		const replayKey = "stage:task:alone:1";
		const key = forkSourceCheckpointKey(replayKey);
		const unavailable = failForkRecordOnce(backend, { written: true });
		// Seed what the original launch left in storage, without opening its source as a stage in the retrying host.
		const sessionId = await (async () => {
			const writer = await SessionManager.create(store, process.cwd());
			const id = writer.getSessionId();
			const entryId = await writer.appendMessage(userMessage("before launch"));
			await assert.rejects(
				backend.commitCheckpoint({
					kind: "tool",
					workflowId: run,
					checkpointId: key,
					name: key,
					argsHash: key,
					output: { sessionId: id, entryId },
					completedAt: 1,
				}),
				(error) => error === unavailable,
			);
			await writer.appendMessage(userMessage("after launch"));
			return id;
		})();
		assert.equal(backend.getToolCheckpoint(run, key), undefined, "the retry has not refreshed its projection");
		const options = withLaunchForkPoint({
			backend,
			workflowId: run,
			replayKey,
			resuming: false,
			options: { context: "fork" as const, forkFromSessionId: sessionId, sessionStore: store },
		});
		assert.ok(options);
		assert.deepEqual(await stepConversation(store, options), ["before launch"]);
	});

	test.each([
		{ reservesStepKeys: true, failFast: true },
		{ reservesStepKeys: false, failFast: false },
	])(
		"a parallel whose fork point record cannot be written starts none of its steps and is launched again whole (launch keys: $reservesStepKeys, failFast: $failFast, #5481)",
		async ({ reservesStepKeys, failFast }) => {
			const { backend, source, parallel, forking } = await launchRun();
			const unavailable = failForkRecordOnce(backend, { written: false });
			const startedAt: (string | undefined)[] = [];
			const step = async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
				startedAt.push(options.forkFromEntryId);
				await source.appendMessage(userMessage(`after ${name} started`));
				return { stageName: name, text: name };
			};
			const launch = () => parallel(step, { reservesStepKeys })(STEP_PAIR, { ...forking, failFast });
			await assert.rejects(launch(), (error) => error === unavailable);
			assert.deepEqual(startedAt, []);

			await source.appendMessage(userMessage("before the run resumes"));
			const relaunchPoint = source.getLeafId();
			await launch();
			assert.deepEqual(startedAt, [relaunchPoint, relaunchPoint]);
		},
	);

	test("an older parallel that only replays cached steps still saves its fork point for a live restart (#5481)", async () => {
		const { parallel, source, forking } = await launchRun();
		const seen: (string | undefined)[] = [];
		const step: StepWork = async (name, options) => {
			seen.push(options.forkFromEntryId);
			return { stageName: name, text: name };
		};
		const olderParallel = () => parallel(step, { reservesStepKeys: false });
		// Pre-launch-record journal: cached task results, but no record of the source.
		await olderParallel()(STEP_PAIR, { concurrency: 1 });
		const before = source.getLeafId();
		await olderParallel()(STEP_PAIR, forking);
		assert.deepEqual(seen, [undefined, undefined], "the old results replay without a live task");
		await source.appendMessage(userMessage("after the cached replay"));
		await olderParallel()(STEP_PAIR, { ...forking, durableRestartFromPrompt: true });
		assert.deepEqual(seen.slice(2), [before, before]);
	});

	test("a parallel whose fork point record was written though the write failed forks every step at the recorded point (#5481)", async () => {
		const { backend, source, parallel, forking } = await launchRun();
		const launchPoint = source.getLeafId();
		const unavailable = failForkRecordOnce(backend, { written: true });
		const startedAt: (string | undefined)[] = [];
		const step = async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
			startedAt.push(options.forkFromEntryId);
			await source.appendMessage(userMessage(`after ${name} started`));
			return { stageName: name, text: name };
		};
		await assert.rejects(parallel(step)(STEP_PAIR, forking), (error) => error === unavailable);
		await source.appendMessage(userMessage("before the run resumes"));
		const stopped = new Error("the run stops after a's result is recorded");
		const resumed = parallel(step, {
			afterLiveResult: async () => {
				throw stopped;
			},
		});
		await assert.rejects(resumed(STEP_PAIR, forking), (error) => error === stopped);
		await parallel(step)(STEP_PAIR, forking);
		assert.deepEqual(startedAt, [launchPoint, launchPoint]);
	});

	test("a parallel's steps keep its launch's graph parents when another stage settles while its fork point is recorded (#5481)", async () => {
		const { backend, parallel, forking } = await launchRun();
		const tracker = new GraphFrontierTracker();
		tracker.onSpawn("root", "root");
		tracker.onSettle("root");
		tracker.onSpawn("beside", "beside");
		const record = holdForkRecord(backend);
		const parents: (readonly string[] | undefined)[] = [];
		const launched = parallel(
			async (name, _options, scope) => {
				parents.push(scope?.parentIds);
				return { stageName: name, text: name };
			},
			{ tracker },
		)(STEP_PAIR, forking);
		await record.writing;
		tracker.onSettle("beside");
		assert.deepEqual(parents, [], "no step starts before the fork point is recorded");
		record.release();
		await launched;
		assert.deepEqual(parents, [["root"], ["root"]]);
	});
});

const STEP_PAIR = [
	{ name: "a", prompt: "A" },
	{ name: "b", prompt: "B" },
];

function userMessage(content: string): Message {
	return { role: "user", content, timestamp: Date.now() };
}

function texts(results: readonly WorkflowTaskResult[]): string[] {
	return results.map((result) => result.text);
}

type StepWork = (
	name: string,
	options: WorkflowTaskOptions,
	scope?: ParallelFailFastScope,
) => Promise<WorkflowTaskResult>;

/**
 * A registered run whose parallels fork `source`, a live stage session in `store`. `parallel(step)` builds the run's
 * durable task and parallel primitives the way the engine does, with `step` as each step's work; building them again
 * is the run resumed in a new process, with the same journal.
 */
async function launchRun(options: { readonly empty?: boolean } = {}) {
	const backend = await createMemoryTestBackend();
	const run = randomUUID();
	const store = new MemorySessionStore();
	const source = await SessionManager.create(store, process.cwd());
	if (options.empty !== true) await source.appendMessage(userMessage("before launch"));
	const definition = workflow({
		name: "fork-point-launch",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	await backend.commitWorkflowRegistration({
		workflowId: run,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		invocationCwd: process.cwd(),
	});
	const parallel = (
		step: StepWork,
		hooks: {
			readonly runId?: string;
			readonly tracker?: GraphFrontierTracker;
			readonly reservesStepKeys?: boolean;
			readonly afterLiveResult?: () => Promise<void>;
		} = {},
	) => {
		const workflowId = hooks.runId ?? run;
		const nextReplayKey = createStageReplayKeyGenerator(workflowId);
		const runtime = {
			runId: workflowId,
			exit: { throwIfWorkflowExitSelected: () => undefined, exitScope: undefined },
			tracker: hooks.tracker ?? new GraphFrontierTracker(),
			activeStore: { run: () => undefined },
		} as unknown as EngineRuntime;
		const task = createDurableTaskPrimitive({
			workflowId,
			backend,
			nextReplayKey,
			task: step,
			...(hooks.afterLiveResult ? { afterLiveResult: hooks.afterLiveResult } : {}),
		});
		return createParallelPrimitive({
			runtime,
			task,
			durable: { backend, workflowId, nextReplayKey },
			reservesStepKeys: hooks.reservesStepKeys,
		});
	};
	/** `ctx.chain` of the run, with `step` as each step's work; built again, it is the run resumed. */
	const chain = (step: StepWork) => {
		const nextReplayKey = createStageReplayKeyGenerator(run);
		const runtime = {
			runId: run,
			exit: { throwIfWorkflowExitSelected: () => undefined, exitScope: undefined },
		} as unknown as EngineRuntime;
		const task = createDurableTaskPrimitive({ workflowId: run, backend, nextReplayKey, task: step });
		return createChainPrimitive({ runtime, task, nextReplayKey });
	};
	const forking = {
		concurrency: 1,
		context: "fork" as const,
		forkFromSessionId: source.getSessionId(),
		sessionStore: store,
	};
	return { backend, run, store, source, definition, parallel, chain, forking };
}

/** The conversation a step's session starts with, opened from `store` the way the stage runner opens it. */
async function stepConversation(store: MemorySessionStore, options: WorkflowTaskOptions): Promise<unknown[]> {
	const created = await stripWorkflowOnlyOptions({ ...taskStageOptions(options), sessionStore: store }, undefined, {
		runId: "run",
		stageId: "step",
		stageName: "step",
	});
	assert.ok(created.sessionManager);
	return created.sessionManager
		.buildSessionContext()
		.messages.map((message) => ("content" in message ? message.content : message.role));
}

/** The options of a stage that forks `source`, launched in `run` under `replayKey`. */
function launchStage(
	backend: MemoryJournalBackend,
	run: string,
	source: SessionManager,
	replayKey = "stage:task:alone:1",
): StageOptions {
	const launched = withLaunchForkPoint({
		backend,
		workflowId: run,
		replayKey,
		options: {
			context: "fork" as const,
			forkFromSessionId: source.getSessionId(),
			sessionStore: source.getSessionStore(),
		},
		resuming: false,
	});
	assert.ok(launched);
	return launched;
}

function isForkRecordAppend(event: { readonly type: string; readonly payload?: unknown }): boolean {
	const argsHash = String((event.payload as { readonly argsHash?: unknown } | undefined)?.argsHash);
	return (
		event.type === "CheckpointRecorded" &&
		(argsHash.endsWith(FAN_OUT_FORK_SOURCES_SUFFIX) || argsHash.endsWith(FORK_SOURCE_CHECKPOINT_SUFFIX))
	);
}

/**
 * Fails the next write of a fork point record (a parallel's or a single stage's) with a storage error, as a briefly unavailable journal does;
 * later writes go through. With `written`, the record is stored before the write fails, as when only its
 * acknowledgement is lost.
 */
function failForkRecordOnce(backend: MemoryJournalBackend, options: { readonly written: boolean }): Error {
	const unavailable = new StorageUnavailableError(
		{ adapter: "memory", location: "test" },
		new Error("the journal is briefly unavailable"),
	);
	const append = backend.journal.append.bind(backend.journal);
	let failed = false;
	vi.spyOn(backend.journal, "append").mockImplementation(async (lease, event, appendOptions) => {
		if (failed || !isForkRecordAppend(event)) return append(lease, event, appendOptions);
		failed = true;
		if (options.written) await append(lease, event, appendOptions);
		throw unavailable;
	});
	return unavailable;
}

/** Holds the write of a fork point record until `release()`. */
function holdForkRecord(backend: MemoryJournalBackend) {
	const writing = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const append = backend.journal.append.bind(backend.journal);
	vi.spyOn(backend.journal, "append").mockImplementation(async (lease, event, appendOptions) => {
		if (isForkRecordAppend(event)) {
			writing.resolve();
			await released.promise;
		}
		return append(lease, event, appendOptions);
	});
	return { writing: writing.promise, release: () => released.resolve() };
}

const STEPS = [
	{ name: "a", prompt: "A" },
	{ name: "b", prompt: "B" },
	{ name: "c", prompt: "C" },
];

/**
 * A run whose `ctx.parallel` steps fork a live stage session that makes a turn while each step runs. `runner()` builds
 * the run's durable task and parallel primitives the way the engine does; calling it again is the run resumed in a new
 * process, with the same journal.
 */
async function durableParallelRun(run: string) {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: run,
		name: run,
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	const source = await sourceWithOpenCall();
	const runtime = {
		runId: run,
		exit: { throwIfWorkflowExitSelected: () => undefined, exitScope: undefined },
		tracker: { currentParents: () => [] },
		activeStore: { run: () => undefined },
	} as unknown as EngineRuntime;
	const runner = (hooks: { afterLiveResult?: () => Promise<void>; failWith?: Error } = {}) => {
		const forkedAt: { name: string; entry: string | undefined }[] = [];
		const nextReplayKey = createStageReplayKeyGenerator(run);
		const task = createDurableTaskPrimitive({
			workflowId: run,
			backend,
			nextReplayKey,
			task: async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
				forkedAt.push({ name, entry: options.forkFromEntryId });
				await source.appendMessage(sourceTurn([{ type: "text", text: `LATER_SOURCE_TURN after ${name}` }]));
				if (hooks.failWith) throw hooks.failWith;
				return { stageName: name, text: `${name} done` };
			},
			...(hooks.afterLiveResult ? { afterLiveResult: hooks.afterLiveResult } : {}),
		});
		return {
			forkedAt,
			parallel: createParallelPrimitive({
				runtime,
				task,
				durable: {
					backend,
					workflowId: run,
					nextReplayKey,
					readForkPoint: (options, id) =>
						storedForkPoint({ sessionStore: source.getSessionStore(), ...options }, id),
				},
			}),
		};
	};
	return { backend, run, source, runner };
}
