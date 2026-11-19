import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { currentStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { INTERACTIVE_WORKFLOW_POLICY, type WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/**
 * One transient storage refusal of one durable record (#5027): whichever record it hits, in a first or a resumed
 * attempt, the run stays inspectable and resumable, and completes once resumed.
 */

const releases: (() => Promise<void> | void)[] = [];
async function releaseRuns(): Promise<void> {
	for (const release of releases.splice(0)) await release();
}
afterEach(async () => {
	await releaseRuns();
	// The runs here are a session's runs, whose stages stay registered for chat until the session ends; end it, or
	// every test keeps the stages of all the runs before it (about 5 MB a test).
	await currentStageControlRegistry().clear();
	store.clear();
	setDurableBackend(undefined);
});

let projectDir: string;
beforeAll(() => {
	projectDir = makeTempDirectory("refused-write-project-");
});
afterAll(() => removeTempDirectory(projectDir));

type ReopenableBackend = JournalDurableBackend & { reopen(): Promise<ReopenableBackend> };

function openMemoryJournal(): Promise<ReopenableBackend> {
	const connection = new DatabaseSync(":memory:");
	const opened: JournalDurableBackend[] = [];
	releases.push(async () => {
		for (const backend of opened) await backend.close();
		connection.close();
	});
	const open = async (): Promise<ReopenableBackend> => {
		const backend: ReopenableBackend = Object.assign(
			await JournalDurableBackend.open(await openSqlRunJournal(connection)),
			{
				async reopen(): Promise<ReopenableBackend> {
					await backend.close();
					return open();
				},
			},
		);
		opened.push(backend);
		return backend;
	};
	return open();
}

function answerPromptsAsTheyOpen(): void {
	let scheduled = false;
	const answer = () => {
		scheduled = false;
		for (const live of store.runs())
			for (const stage of live.stages)
				if (stage.pendingPrompt !== undefined)
					store.resolveStagePendingPrompt(live.id, stage.id, stage.pendingPrompt.id, true);
	};
	releases.push(
		store.subscribeInvalidation(() => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(answer);
		}),
	);
}

/** Where an attempt fails on purpose: tool t2 throws, or the run fails at its end (s2's prompt, or plain code). */
interface Plan {
	failT2: boolean;
	failS2: boolean;
}

/** Which commit to refuse: the `nth` commit of attempt `attempt`, or the first whose id starts with `prefix`. */
type Refusal =
	| { readonly attempt: number; readonly nth: number }
	| { readonly attempt: number; readonly prefix: string; readonly times?: number };

/**
 * The workflows refused writes are swept over. `full`: s1 → a ui prompt → t1 → t2 → s2 → a child workflow (c1, ct).
 * `tail`: s1 → t1 → t2, then plain code that may throw. `par`: s1 → [t1 ‖ stage s2], then t2 and the throw. `child`:
 * s1 → a child workflow (ct, cs) → t2, then the throw.
 */
type Shape = "full" | "tail" | "par" | "child";

function definitions(shape: Shape, plan: { current: Plan }): { parent: WorkflowDefinition; child: WorkflowDefinition } {
	const child = workflow({
		name: "refused-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (shape === "full") await ctx.stage("c1").prompt("c1");
			await ctx.tool("ct", {}, async () => "ct");
			if (shape !== "full") await ctx.stage("cs").prompt("cs");
			return {};
		},
	}) as WorkflowDefinition;
	const t2 = async () => {
		if (plan.current.failT2) throw new Error("planned t2 failure");
		return "t2";
	};
	const parent = workflow({
		name: "refused-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("s1").prompt("s1");
			if (shape === "full") {
				assert.equal(await ctx.ui.confirm("go on?"), true);
				await ctx.tool("t1", {}, async () => {
					toolRuns.t1 += 1;
					return "t1";
				});
				await ctx.tool("t2", {}, t2);
				await ctx.stage("s2").prompt("s2");
				await ctx.workflow(child);
				return {};
			}
			if (shape === "tail") await ctx.tool("t1", {}, async () => "t1");
			if (shape === "par")
				await Promise.all([ctx.tool("t1", {}, async () => "t1"), ctx.stage("s2").prompt("s2-par")]);
			if (shape === "child") await ctx.workflow(child);
			await ctx.tool("t2", {}, t2);
			if (plan.current.failS2) throw new Error("planned failure in plain code");
			return {};
		},
	}) as WorkflowDefinition;
	return { parent, child };
}

/** How often the full workflow's tool t1 ran, across every run of the current test. */
const toolRuns = { t1: 0 };

const settled = (status: string) => (status === "cached" || status === "replayed" ? "completed" : status);

/** A run and the child runs its boundaries reach, by name and status, so live and durable runs compare. */
function graph(runs: readonly RunSnapshot[], rootId: string): unknown {
	const visit = (snapshot: RunSnapshot): unknown => ({
		stages: snapshot.stages.map((stage) => `${stage.name}:${settled(stage.status)}`).sort(),
		tools: snapshot.toolNodes.map((tool) => `${tool.name}:${settled(tool.status)}`).sort(),
		children: runs
			.filter(
				(candidate) =>
					candidate.parentRunId === snapshot.id &&
					snapshot.stages.some(
						(stage) =>
							stage.id === candidate.parentStageId &&
							(stage.startedChildRunId === candidate.id ||
								(stage.status !== "failed" && stage.status !== "skipped")),
					),
			)
			.map(visit),
	});
	const root = runs.find((candidate) => candidate.id === rootId);
	return root === undefined ? undefined : visit(root);
}

function durableGraph(backend: DurableWorkflowBackend, runId: string): unknown {
	const handle = backend.getWorkflow(runId);
	assert.ok(handle, "the run is durable");
	return graph(durableWorkflowRunSnapshots(backend, handle), runId);
}

function liveGraph(runId: string): unknown {
	return graph(
		store.runs().filter((candidate) => candidate.id === runId || candidate.rootRunId === runId),
		runId,
	);
}

async function waitEnded(runId: string): Promise<RunSnapshot> {
	for (let i = 0; i < 2000; i++) {
		await jobTracker.get(runId)?.promise.catch(() => {});
		const live = store.run(runId);
		if (live !== undefined && live.endedAt !== undefined && live.status !== "running") return live;
		await sleep(5);
	}
	throw new Error(`run ${runId} did not end`);
}

/**
 * Run the workflow under one refusal: attempt 0 follows `plans[0]`, each resume the next plan, then plain resumes
 * until it completes. Every attempt must leave a durable view, every resume must be accepted, and the run must
 * complete with a durable view, after reopening, that is the live one.
 */
async function runWithRefusal(
	refusal: Refusal,
	plans: readonly Plan[],
	options: {
		readonly shape?: Shape;
		readonly restart?: boolean;
		/** Also refuse, once, the write of the run's failed status in the refused attempt. */
		readonly refuseFailedStatus?: boolean;
		readonly journal?: "file" | "memory";
	} = {},
): Promise<{
	refused: string | undefined;
	reached: number;
	errors: readonly string[];
	/** The live and durable views of the run after each of its attempts. */
	views: readonly { readonly live: unknown; readonly durable: unknown }[];
	/** The failed stage each failed attempt named. */
	failedStages: readonly (string | undefined)[];
	/** The run's durable status after each failed attempt. */
	durableStatuses: readonly (string | undefined)[];
}> {
	await releaseRuns();
	const shape = options.shape ?? "full";
	let attempt = 0;
	let commits = 0;
	let reached = 0;
	let refused: string | undefined;
	let refusedCount = 0;
	let statusRefused = false;
	const instrument = (opened: ReopenableBackend): ReopenableBackend => {
		const commit = opened.commitCheckpoint.bind(opened);
		opened.commitCheckpoint = ((checkpoint: DurableCheckpoint, signal?: { readonly signal?: AbortSignal }) => {
			commits += 1;
			if (attempt === refusal.attempt) reached = Math.max(reached, commits);
			const hit =
				(refused === undefined || ("times" in refusal && refusedCount < (refusal.times ?? 1))) &&
				attempt === refusal.attempt &&
				("nth" in refusal ? commits === refusal.nth : checkpoint.checkpointId.startsWith(refusal.prefix));
			if (hit) {
				refusedCount += 1;
				refused ??= checkpoint.checkpointId;
				return Promise.reject(
					new StorageUnavailableError(
						{ adapter: "test", location: "refused" },
						new Error("journal refused") as never,
					),
				);
			}
			return commit(checkpoint, signal);
		}) as typeof opened.commitCheckpoint;
		const commitStatus = opened.commitWorkflowStatus.bind(opened);
		opened.commitWorkflowStatus = ((...args: Parameters<typeof opened.commitWorkflowStatus>) => {
			if (
				options.refuseFailedStatus === true &&
				args[1] === "failed" &&
				attempt === refusal.attempt &&
				!statusRefused
			) {
				statusRefused = true;
				return Promise.reject(
					new StorageUnavailableError(
						{ adapter: "test", location: "refused" },
						new Error("journal refused") as never,
					),
				);
			}
			return commitStatus(...args);
		}) as typeof opened.commitWorkflowStatus;
		setDurableBackend(opened);
		return opened;
	};
	let backend = instrument(await (options.journal === "memory" ? openMemoryJournal() : JournalTestBackend.create()));

	const plan = { current: plans[0]! };
	const { parent, child } = definitions(shape, plan);
	const makeRuntime = () =>
		createExtensionRuntime({
			store,
			cwd: projectDir,
			resolveJournalSettings: () => ({ snapshots: { enabled: false } }),
			registry: createRegistry([parent, child]),
			adapters: {
				prompt: {
					prompt: async (text: string) => {
						if (text === "s2" && plan.current.failS2) throw new Error("planned s2 failure");
						return text;
					},
				},
			},
		});
	let runtime = makeRuntime();
	/** A new process: the live runs are gone and the journal is opened again. */
	const restart = async () => {
		if (options.restart !== true) return;
		store.clear();
		backend = instrument(await backend.reopen());
		runtime = makeRuntime();
	};
	answerPromptsAsTheyOpen();

	const started = await runtime.dispatch({ action: "run", workflow: parent.name, inputs: {} });
	assert.ok("runId" in started, JSON.stringify(started));
	const errors: string[] = [];
	const views: { live: unknown; durable: unknown }[] = [];
	const failedStages: (string | undefined)[] = [];
	const durableStatuses: (string | undefined)[] = [];
	const where = () => `refused ${refused ?? "nothing"} in attempt ${attempt}`;
	/** Resume `runId` until it completes, from attempt `first`, with a durable view after every attempt. */
	const complete = async (runId: string, first: number, plans: readonly Plan[]): Promise<void> => {
		// A fork waits paused for its first attempt.
		let live = first === FORK ? undefined : await waitEnded(runId);
		for (let next = first; ; next++) {
			assert.notEqual(durableGraph(backend, runId), undefined, `${where()}: the run has a durable view`);
			if (live !== undefined) views.push({ live: liveGraph(runId), durable: durableGraph(backend, runId) });
			if (live !== undefined && live.status !== "completed") {
				durableStatuses.push(backend.getWorkflow(runId)?.status);
				const failedStageId = live.failedStageId;
				failedStages.push(live.stages.find((stage) => stage.id === failedStageId)?.name);
			}
			if (live?.status === "completed") {
				assert.deepEqual(
					durableGraph(backend, runId),
					liveGraph(runId),
					`${where()}: the durable view is the live one`,
				);
				return;
			}
			if (live !== undefined) errors.push(live.error ?? "");
			assert.ok(next <= first + plans.length + 2, `${where()}: the run completes once resumed (${live?.error})`);
			attempt = next;
			commits = 0;
			plan.current = plans[next - first] ?? { failT2: false, failS2: false };
			if (first !== FORK) await restart();
			const resume = async () => {
				const result = await workflowResumeAction(
					{ action: "resume", runId },
					{
						getRuntime: () => runtime,
						policy: INTERACTIVE_WORKFLOW_POLICY,
						ensureWorkflowResourcesLoaded: async () => {},
					},
				);
				assert.ok(result.action === "resume", JSON.stringify(result));
				return result;
			};
			let resumed = await resume();
			// A resume whose own first record is refused is refused as a whole; it is asked again, as a user would.
			if (resumed.status !== "running" && /Storage unavailable/.test(resumed.message ?? ""))
				resumed = await resume();
			assert.equal(resumed.status, "running", `${where()}: the run is resumable: ${JSON.stringify(resumed)}`);
			live = await waitEnded(runId);
		}
	};
	const runId = started.runId;
	await complete(runId, 1, plans.slice(1));
	const expected = liveGraph(runId);
	// A fork from s2 replays what came before it into a run of its own, then runs s2 and what follows.
	let forkCheck = async (_reopened: DurableWorkflowBackend): Promise<void> => {};
	if (shape === "full" || shape === "par") {
		const fork = await forkDurableRun(backend, {
			source: "sdk",
			runId,
			fromStage: "s2",
			cwd: projectDir,
			carryMessages: "before",
			definition: parent,
		});
		const forkRoot = durableWorkflowRunSnapshots(backend, backend.getWorkflow(fork.runId)!).find(
			(candidate) => candidate.id === fork.runId,
		);
		assert.ok(
			forkRoot?.stages.some((stage) => stage.name === "s1"),
			`${where()}: a fork keeps what came before s2`,
		);
		await complete(fork.runId, FORK, []);
		const forkExpected = liveGraph(fork.runId);
		assert.deepEqual(durableGraph(backend, fork.runId), forkExpected, `${where()}: the fork's durable view`);
		forkCheck = async (reopened) =>
			assert.deepEqual(durableGraph(reopened, fork.runId), forkExpected, `${where()}: the reopened fork's view`);
	}
	const reopened = await backend.reopen();
	assert.deepEqual(durableGraph(reopened, runId), expected, `${where()}: the reopened durable view is the live one`);
	await forkCheck(reopened);
	return { refused, reached, errors, views, failedStages, durableStatuses };
}

/** The attempts of a fork of the completed run are numbered from here. */
const FORK = 100;

const COMPLETES: readonly Plan[] = [{ failT2: false, failS2: false }];
/** Attempt 0 fails at s2, so attempt 1 replays s1, the prompt, t1 and t2 and runs s2 and the child. */
const RESUMED: readonly Plan[] = [
	{ failT2: false, failS2: true },
	{ failT2: false, failS2: false },
];

describe("a refused durable write leaves the run inspectable and resumable (#5027)", () => {
	test("a refused tool replay record keeps the resumed attempt's durable view (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 1, prefix: "tool-replay-meta:" }, RESUMED);
		assert.match(refused ?? "", /^tool-replay-meta:/);
	});

	test("a refused tool failure record keeps the failed tool the resume frontier (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 0, prefix: "tool-failure:" }, [
			{ failT2: true, failS2: false },
		]);
		assert.match(refused ?? "", /^tool-failure:/);
	});

	test("a refused tool failure record in a resumed attempt keeps the run resumable (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 1, prefix: "tool-failure:" }, [
			{ failT2: true, failS2: false },
			{ failT2: true, failS2: false },
		]);
		assert.match(refused ?? "", /^tool-failure:/);
	});

	test("a refused tool failure record keeps the run resumable after a restart (#5027)", async () => {
		for (const attempt of [0, 1]) {
			const plans = [
				{ failT2: true, failS2: false },
				{ failT2: attempt === 1, failS2: false },
			];
			const { refused } = await runWithRefusal({ attempt, prefix: "tool-failure:" }, plans, { restart: true });
			assert.match(refused ?? "", /^tool-failure:/);
			store.clear();
		}
	});

	test("a failed tool whose failure record is refused twice is run again on resume (#5027)", async () => {
		for (const [attempt, restart] of [
			[0, false],
			[0, true],
			[1, false],
			[1, true],
		] as const) {
			const plans = [
				{ failT2: true, failS2: false },
				{ failT2: attempt === 1, failS2: false },
			];
			const { refused } = await runWithRefusal({ attempt, prefix: "tool-failure:", times: 2 }, plans, { restart });
			assert.match(refused ?? "", /^tool-failure:/, `attempt ${attempt}, restart ${restart}`);
			store.clear();
		}
	});

	test("a run whose failed status write is refused resumes without running its completed nodes again (#5027)", async () => {
		for (const restart of [false, true]) {
			toolRuns.t1 = 0;
			const { refused, errors, durableStatuses } = await runWithRefusal(
				{ attempt: 0, prefix: "no-such-record:" },
				[{ failT2: true, failS2: false }],
				{ restart, refuseFailedStatus: true },
			);
			assert.equal(refused, undefined);
			assert.match(errors[0] ?? "", /planned t2 failure/);
			assert.equal(durableStatuses[0], "running", "the refused failed status leaves the run running");
			assert.equal(toolRuns.t1, 1, `t1 replays from its record (restart ${restart})`);
			store.clear();
		}
	});

	test("a refused child boundary start leaves the failed boundary in the run's durable view (#5027)", async () => {
		const { refused, views } = await runWithRefusal({ attempt: 0, prefix: "boundary-start:" }, COMPLETES);
		assert.match(refused ?? "", /^boundary-start:/);
		assert.deepEqual(views[0]?.durable, views[0]?.live);
	});

	test("a refused stage replay record names the stage the attempt failed at (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 1, prefix: "stage-replay-meta:" }, RESUMED);
		assert.match(refused ?? "", /^stage-replay-meta:/);
	});

	test("a refused failure record of a failed stage keeps the stage's own failure (#5027)", async () => {
		const { refused, errors } = await runWithRefusal({ attempt: 0, prefix: "stage-meta:stage:s2:" }, RESUMED);
		assert.match(refused ?? "", /^stage-meta:stage:s2:/);
		assert.match(errors[0] ?? "", /planned s2 failure/);
	});

	test("a refused replay record of a forked run's stage leaves the fork resumable (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: FORK, prefix: "stage-replay-meta:" }, COMPLETES);
		assert.match(refused ?? "", /^stage-replay-meta:/);
	});

	test("a refused stage completion record names the stage the attempt failed at (#5027)", async () => {
		for (const [prefix, stage] of [
			["stage:stage:s1:", "s1"],
			["stage:stage:s2:", "s2"],
		] as const) {
			const { refused, failedStages, errors } = await runWithRefusal({ attempt: 0, prefix }, COMPLETES);
			assert.equal(refused?.startsWith(prefix), true, prefix);
			assert.equal(failedStages[0], stage, "the attempt names the stage whose record was refused");
			assert.match(errors[0] ?? "", /Storage unavailable/);
			store.clear();
		}
	});
});

test("an answer no prompt node records is not lost to a refusal: the attempt fails instead (#5027)", async () => {
	const backend = await createMemoryTestBackend();
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = ((checkpoint: DurableCheckpoint, options?: { readonly signal?: AbortSignal }) =>
		checkpoint.checkpointId.startsWith("ui:")
			? Promise.reject(
					new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
				)
			: commit(checkpoint, options)) as typeof backend.commitCheckpoint;
	let asked = 0;
	const def = workflow({
		name: "refused-answer",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.ui.confirm("go on?");
			await ctx.tool("after", {}, async () => "after");
			return {};
		},
	}) as WorkflowDefinition;
	const ui = {
		input: async () => "",
		confirm: async () => {
			asked += 1;
			return true;
		},
		select: async <T extends string>(_: string, options: readonly T[]) => options[0]!,
		editor: async () => "",
		custom: async <T>() => undefined as T,
	};
	const result = await run(def, {}, { store: createStore(), durableBackend: backend, ui });
	assert.equal(asked, 1);
	assert.equal(result.status, "failed", "the run does not go on past an answer it could not record");
	assert.match(result.error ?? "", /Storage unavailable/);
	assert.equal(
		backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.checkpointId.startsWith("tool:")),
		false,
	);
});

describe("which failed runs resume from their records (#5027)", () => {
	/** Run `run` once against a fresh memory journal; return what a same-session resume answers. */
	async function failOnce(
		body: (ctx: Parameters<WorkflowDefinition["run"]>[0]) => Promise<void>,
		options: { readonly refuse?: string } = {},
	) {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		let refused = false;
		backend.commitCheckpoint = ((checkpoint: DurableCheckpoint, signal?: { readonly signal?: AbortSignal }) => {
			if (!refused && options.refuse !== undefined && checkpoint.checkpointId.startsWith(options.refuse)) {
				refused = true;
				return Promise.reject(
					new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
				);
			}
			return commit(checkpoint, signal);
		}) as typeof backend.commitCheckpoint;
		setDurableBackend(backend);
		let runs = 0;
		const def = workflow({
			name: "records-only",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				runs += 1;
				await body(ctx as never);
				return {};
			},
		}) as WorkflowDefinition;
		const first = await run(
			def,
			{},
			{ store, durableBackend: backend, adapters: { prompt: { prompt: async (t) => t } } },
		);
		assert.equal(first.status, "failed");
		const runtime = createExtensionRuntime({
			store,
			registry: createRegistry([def]),
			adapters: { prompt: { prompt: async (t: string) => t } },
		});
		return { backend, runId: first.runId, runtime, runs: () => runs };
	}

	let calls = 0;
	const tool = (
		ctx: { tool: (name: string, args: object, fn: () => Promise<string>) => Promise<string> },
		name: string,
	) =>
		ctx.tool(name, {}, async () => {
			calls += 1;
			return name;
		});

	test("a run that failed in its own code after its tools resumes and replays them (#5027)", async () => {
		calls = 0;
		let failing = true;
		const h = await failOnce(async (ctx) => {
			await tool(ctx as never, "t1");
			await tool(ctx as never, "t2");
			if (failing) throw new Error("planned failure in plain code");
		});
		failing = false;
		const resumed = await h.runtime.resumeFailedRun(h.runId);
		assert.equal(resumed.ok, true, JSON.stringify(resumed));
		await jobTracker.get(h.runId)?.promise.catch(() => {});
		await waitEnded(h.runId);
		assert.equal(store.run(h.runId)?.status, "completed", store.run(h.runId)?.error);
		assert.equal(calls, 2, "the completed tools replay from their records");
	});

	test("a run whose completed tool has no record does not resume from its records (#5027)", async () => {
		calls = 0;
		const h = await failOnce(async (ctx) => {
			await tool(ctx as never, "t1");
			throw new Error("planned failure in plain code");
		});
		const source = store.run(h.runId)!;
		const recorded = source.toolNodes[0]!;
		store.recordRunStart({
			...source,
			toolNodes: [...source.toolNodes, { ...recorded, id: "tool:unrecorded", argsHash: "unrecorded", name: "lost" }],
		});
		const resumed = await h.runtime.resumeFailedRun(h.runId);
		assert.equal(resumed.ok, false, JSON.stringify(resumed));
		assert.match(resumed.ok ? "" : resumed.message, /insufficient_state/);
		assert.equal(calls, 1);
	});

	test("a run that failed before any node does not resume from its records (#5027)", async () => {
		const h = await failOnce(async () => {
			throw new Error("planned failure before any node");
		});
		const resumed = await h.runtime.resumeFailedRun(h.runId);
		assert.equal(resumed.ok, false);
		assert.match(resumed.ok ? "" : resumed.message, /does not identify a failed stage/);
	});

	test("a stage a failure other than a storage refusal kept from starting is not resumed from records (#5027)", async () => {
		const h = await failOnce(async (ctx) => {
			await tool(ctx as never, "t1");
			const pending = ctx.stage("never-started");
			void pending;
			throw new Error("planned failure in plain code");
		});
		const source = store.run(h.runId)!;
		store.recordRunStart({
			...source,
			stages: [
				...source.stages,
				{ ...source.stages[0]!, id: "pending-stage", name: "pending", status: "pending" },
			].filter((stage) => stage !== undefined),
		} as RunSnapshot);
		const resumed = await h.runtime.resumeFailedRun(h.runId);
		assert.equal(resumed.ok, false, JSON.stringify(resumed));
	});

	test("a run that stopped part-way through a stage after a storage refusal is not resumed from records (#5027)", async () => {
		const h = await failOnce(async (ctx) => {
			await tool(ctx as never, "t1");
			throw new Error("planned failure in plain code");
		});
		const source = store.run(h.runId)!;
		store.recordRunStart({
			...source,
			failureCode: "storage_unavailable",
			stages: [{ ...source.stages[0]!, id: "stopped", name: "stopped", status: "running" }],
		} as RunSnapshot);
		const resumed = await h.runtime.resumeFailedRun(h.runId);
		assert.equal(resumed.ok, false, JSON.stringify(resumed));
	});

	test("a run with a failed tool it names no frontier for is not resumed from records (#5027)", async () => {
		const h = await failOnce(async (ctx) => {
			await tool(ctx as never, "t1");
			throw new Error("planned failure in plain code");
		});
		const source = store.run(h.runId)!;
		store.recordRunStart({
			...source,
			toolNodes: source.toolNodes.map((node) => ({ ...node, status: "failed" as const })),
		});
		const resumed = await h.runtime.resumeFailedRun(h.runId);
		assert.equal(resumed.ok, false, JSON.stringify(resumed));
	});

	test("a tool replay record the store fails to write for another reason fails the attempt at that tool (#5027)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		let refuse = false;
		backend.commitCheckpoint = ((checkpoint: DurableCheckpoint, signal?: { readonly signal?: AbortSignal }) =>
			refuse && checkpoint.checkpointId.startsWith("tool-replay-meta:")
				? Promise.reject(new Error("journal lease lost"))
				: commit(checkpoint, signal)) as typeof backend.commitCheckpoint;
		let failing = true;
		const def = workflow({
			name: "replay-write-failure",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("t1", {}, async () => "t1");
				if (failing) throw new Error("planned failure in plain code");
				return {};
			},
		}) as WorkflowDefinition;
		const runId = `replay-write-failure-${Date.now()}`;
		assert.equal((await run(def, {}, { runId, store: createStore(), durableBackend: backend })).status, "failed");
		refuse = true;
		failing = false;
		const second = createStore();
		const result = await run(def, {}, { runId, store: second, durableBackend: backend });
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /journal lease lost/);
		assert.equal(second.run(runId)?.failedToolNodeId, second.run(runId)?.toolNodes[0]?.id);
	});

	test("a failed tool's refused failure record is written again as the run ends (#5027)", async () => {
		const h = await failOnce(
			async (ctx) => {
				await ctx.tool("throws", {}, async () => {
					throw new Error("planned tool failure");
				});
			},
			{ refuse: "tool-failure:" },
		);
		const failures = h.backend
			.listCheckpoints(h.runId)
			.filter((checkpoint) => checkpoint.kind === "tool" && checkpoint.throwingFailureError !== undefined);
		assert.equal(failures.length, 1);
		assert.match(
			failures[0]?.kind === "tool" ? (failures[0].throwingFailureError ?? "") : "",
			/planned tool failure/,
		);
		const live = store.run(h.runId)!;
		assert.equal(failures[0]?.kind === "tool" ? failures[0].topology?.nodeId : undefined, live.failedToolNodeId);
	});
});

/** More than either attempt commits; a case past the last commit refuses nothing and must simply complete. */
const SWEEP = 40;

describe("one refusal at every checkpoint write (#5027)", () => {
	for (const shape of ["full", "tail", "par", "child"] as const)
		for (const restart of [false, true])
			for (const [label, attempt, plans] of [
				["a first attempt", 0, COMPLETES],
				["a resumed attempt", 1, RESUMED],
			] as const) {
				test(`one refused write in ${label} of the ${shape} workflow${restart ? ", resumed after a restart," : ""} leaves the run inspectable, resumable and completing (#5027)`, async () => {
					const refusedIds: string[] = [];
					let reachedByAnyRun = 0;
					for (let nth = 1; ; nth++) {
						assert.ok(nth <= SWEEP, `the sweep covers every write: ${refusedIds.join(", ")}`);
						const { refused, reached } = await runWithRefusal({ attempt, nth }, plans, {
							shape,
							restart,
							journal: "memory",
						});
						if (refused !== undefined) refusedIds.push(refused);
						reachedByAnyRun = Math.max(reachedByAnyRun, reached);
						store.clear();
						setDurableBackend(undefined);
						if (refused === undefined && nth > reachedByAnyRun) break;
					}
				});
			}
});
