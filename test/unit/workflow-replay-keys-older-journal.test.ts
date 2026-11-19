import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { afterEach, describe, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME } from "../../packages/workflows/src/durable/launch-replay-keys.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function journalPath(): string {
	const directory = makeTempDirectory("replay-keys-");
	directories.push(directory);
	return join(directory, "journal.sqlite");
}

type Group = "chain" | "parallel";

/**
 * A `ctx.chain`, or a `ctx.parallel` with one slot, of steps a and b, in which a fails and the workflow goes on without
 * b; then two tasks named b, one after the other. The run stops after them, so it can be resumed.
 */
function program(group: Group, runId: string, outputs: string[]) {
	return workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const steps = [
				{ name: "a", prompt: "a fails" },
				{ name: "b", prompt: "b of the group" },
			];
			try {
				if (group === "chain") await ctx.chain(steps);
				else await ctx.parallel(steps, { concurrency: 1 });
			} catch (error) {
				if (!String(error).includes("a fails")) throw error;
			}
			for (const prompt of ["first b", "second b"]) outputs.push((await ctx.task("b", { prompt })).text);
			throw new Error("the run stops after both tasks");
		},
	});
}

/**
 * Runs `definition` as run `runId` of the SQLite journal at `path`, until it stops; `answer` answers each prompt it
 * sends. The prompts it sent.
 */
async function runInJournal(
	definition: ReturnType<typeof workflow>,
	runId: string,
	path: string,
	answer: (text: string, stageName: string | undefined) => Promise<string>,
	prepare?: (backend: JournalDurableBackend) => void,
): Promise<string[]> {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	const prompts: string[] = [];
	try {
		prepare?.(backend);
		const result = await run(
			definition,
			{},
			{
				runId,
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						async prompt(text, meta) {
							prompts.push(text);
							return await answer(text, meta?.stageName);
						},
					},
				},
			},
		);
		assert.equal(result.status, "failed");
		return prompts;
	} finally {
		await backend.close();
	}
}

/** Runs `group`'s program as run `runId` of the SQLite journal at `path`: its tasks' outputs and the prompts it sent. */
async function runProgram(group: Group, runId: string, path: string) {
	const outputs: string[] = [];
	const prompts = await runInJournal(program(group, runId, outputs), runId, path, async (text, stageName) => {
		if (stageName === "a") throw new Error("a fails");
		return text;
	});
	return { outputs, prompts };
}

/**
 * The run as a release before this one recorded it in a SQLite journal: a step took its replay key when it started, so
 * the group's b, which never started, took none, and the two tasks recorded their results under `stage:task:b:1` and
 * `stage:task:b:2`.
 */
async function writePreviousReleaseJournal(runId: string, path: string): Promise<void> {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: runId,
			inputs: {},
			createdAt: 1,
			status: "running",
			rootWorkflowId: runId,
			resumable: true,
		});
		const topology = (stageId: string, parentIds: string[], order: number, status: "completed" | "failed") => ({
			version: 1 as const,
			stageId,
			parentIds,
			intercomGroup: `workflow:${runId}`,
			order,
			sourceOrder: order - 1,
			status,
			run: { runId, runName: runId },
		});
		const records: DurableStageCheckpoint[] = [
			{
				kind: "stage",
				workflowId: runId,
				checkpointId: "stage-meta:stage:task:a:1:h8e63705045b25f37d8a8db4a18042cc2",
				name: "a",
				replayKey: "stage:task:a:1",
				completedAt: 3,
				topology: topology("stage-a", [], 1, "failed"),
				startedAt: 2,
				endedAt: 3,
				durationMs: 1,
			},
		];
		const tasks = [
			{ ordinal: 1, text: "first b", stageId: "stage-b-1", parent: "stage-a" },
			{ ordinal: 2, text: "second b", stageId: "stage-b-2", parent: "stage-b-1" },
		];
		for (const { ordinal, text, stageId, parent } of tasks) {
			const replayKey = `stage:task:b:${ordinal}`;
			const at = 3 + ordinal * 2;
			const shape = topology(stageId, [parent], ordinal + 1, "completed");
			records.push(
				{
					kind: "stage",
					workflowId: runId,
					checkpointId: `stage:${replayKey}`,
					name: "b",
					replayKey,
					output: text,
					completedAt: at,
					topology: shape,
					startedAt: at - 1,
					endedAt: at,
					result: text,
					durationMs: 1,
				},
				{
					kind: "stage",
					workflowId: runId,
					checkpointId: `task:${replayKey}`,
					name: "b",
					replayKey,
					output: { name: "b", stageName: "b", text },
					completedAt: at + 1,
					result: text,
					topology: shape,
				},
			);
		}
		for (const record of records) await backend.commitCheckpoint(record);
		await backend.commitWorkflowStatus(runId, "failed", 0, true);
	} finally {
		await backend.close();
	}
}

async function checkForkReplay(
	format: "older" | "current",
	expected: string[],
	program: (ctx: WorkflowRunContext, replay: boolean, source: SessionManager) => Promise<string[]>,
): Promise<void> {
	const path = journalPath();
	const runId = "fork-replay";
	const source = SessionManager.inMemory();
	await source.appendMessage({ role: "user", timestamp: 1, content: "source" });
	for (const replay of [false, true]) {
		const calls: string[] = [];
		const answer = async (text: string) => {
			calls.push(text);
			return text;
		};
		const outputs: string[] = [];
		const definition = workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				outputs.push(...(await program(ctx, replay, source)));
				return {};
			},
		});
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
		try {
			// The older writer registered without a step-key format, then admitted its tasks one at a time.
			if (format === "older" && !replay)
				await backend.commitWorkflowRegistration({
					workflowId: runId,
					name: runId,
					inputs: {},
					status: "running",
					createdAt: 1,
				});
			const result = await run(
				definition,
				{},
				{
					runId,
					store: createStore(),
					durableBackend: backend,
					adapters: { prompt: { prompt: answer }, complete: { complete: answer } },
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(outputs, expected);
			assert.deepEqual(calls.sort(), replay ? [] : [...expected].sort());
		} finally {
			await backend.close();
		}
	}
}

describe("a resumed run replays its results under the replay keys its journal recorded them with (#5481)", () => {
	test.each(["parallel", "chain"] as const)(
		"a forked parallel and a fresh %s replay their own queued results from an older journal (#5481)",
		async (right) => {
			// Main ran each workflow with SDK sessions and a local model. The right group's first request waited
			// for the left group's second request, so the two b results were recorded left, then right.
			const path = journalPath();
			const fixture = new URL(
				right === "parallel"
					? "../fixtures/parallel-queued-workers.sqlite.gz"
					: "../fixtures/parallel-chain-queued-workers.sqlite.gz",
				import.meta.url,
			);
			await writeFile(path, gunzipSync(await readFile(fixture)));
			const runId = "bbecc935-6885-4248-a470-d0e20552596d";
			const outputs: string[][] = [];
			const definition = workflow({
				name: runId,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const groups = await Promise.all([
						ctx.parallel(
							[
								{ name: "a", prompt: "QUEUE_TEST_L1" },
								{ name: "b", prompt: "QUEUE_TEST_L2" },
							],
							{ concurrency: 1, context: "fork", forkFromSessionId: "8bf15ac4-1cb7-4e29-9be5-4e376df8b499" },
						),
						ctx[right](
							[
								{ name: "c", prompt: "QUEUE_TEST_R1" },
								{ name: "b", prompt: "QUEUE_TEST_R2" },
							],
							{ concurrency: 1 },
						),
					]);
					outputs.push(...groups.map((group) => group.map((step) => step.text)));
					return {};
				},
			});
			const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
			try {
				const prompt = vi.fn(async () => "unexpected live task");
				const result = await run(
					definition,
					{},
					{
						runId,
						store: createStore(),
						durableBackend: backend,
						adapters: { prompt: { prompt } },
					},
				);
				assert.equal(result.status, "completed", result.error);
				assert.equal(prompt.mock.calls.length, 0);
				assert.deepEqual(outputs, [
					["reply L1", "reply L2"],
					["reply R1", "reply R2"],
				]);
			} finally {
				await backend.close();
			}
		},
	);

	test("a forked parallel and a same-named task replay in call order from an older journal (#5481)", async () => {
		await checkForkReplay("older", ["first b", "second b"], async (ctx, replay, source) => {
			const fork = {
				context: "fork" as const,
				forkFromSessionId: source.getSessionId(),
				sessionStore: source.getSessionStore(),
			};
			// Before launch records, a parallel immediately called task for each worker with a slot.
			const group = replay
				? ctx.parallel([{ name: "b", prompt: "first b" }], fork)
				: Promise.all([ctx.task("b", { ...fork, prompt: "first b" })]);
			const [[first], second] = await Promise.all([group, ctx.task("b", { prompt: "second b" })]);
			return [first!.text, second.text];
		});
	});

	test.each(["chain", "parallel"] as const)(
		"a %s between a cached fork and a standalone task keeps its admitted worker's place (#5481)",
		async (kind) => {
			await checkForkReplay("older", ["left", "middle", "last"], async (ctx, replay, source) => {
				const fork = {
					context: "fork" as const,
					forkFromSessionId: source.getSessionId(),
					sessionStore: source.getSessionStore(),
				};
				const a = replay
					? ctx.parallel([{ name: "a", prompt: "left" }], fork)
					: Promise.all([ctx.task("a", { ...fork, prompt: "left" })]);
				const b = replay
					? ctx[kind]([{ name: "b", prompt: "middle" }])
					: Promise.all([ctx.task("b", { prompt: "middle" })]);
				const [[first], [middle], last] = await Promise.all([a, b, ctx.task("b", { prompt: "last" })]);
				return [first!.text, middle!.text, last.text];
			});
		},
	);

	test("a standalone task keeps its slot before a queued same-named worker from an older journal (#5481)", async () => {
		await checkForkReplay("older", ["first", "queued", "standalone"], async (ctx, replay, source) => {
			const fork = {
				context: "fork" as const,
				forkFromSessionId: source.getSessionId(),
				sessionStore: source.getSessionStore(),
			};
			const group = replay
				? ctx.parallel(
						[
							{ name: "b", prompt: "first" },
							{ name: "b", prompt: "queued" },
						],
						{ ...fork, concurrency: 1 },
					)
				: (async () => [
						await ctx.task("b", { ...fork, prompt: "first" }),
						await ctx.task("b", { ...fork, prompt: "queued" }),
					])();
			const [workers, solo] = await Promise.all([group, ctx.task("b", { prompt: "standalone" })]);
			return [...workers.map((worker) => worker.text), solo.text];
		});
	});

	test("a forked parallel leaves every authored stage name available in an older journal (#5481)", async () => {
		await checkForkReplay("older", ["group", "first answer", "second answer"], async (ctx, replay, source) => {
			const fork = {
				context: "fork" as const,
				forkFromSessionId: source.getSessionId(),
				sessionStore: source.getSessionStore(),
			};
			const [worker] = replay
				? await ctx.parallel([{ name: "worker", prompt: "group" }], fork)
				: [await ctx.task("worker", { ...fork, prompt: "group" })];
			const stageName = "parallel:h892fb3f00c2598ceea720fc08111c95e";
			return [
				worker!.text,
				String(await ctx.stage(stageName).complete("first answer")),
				String(await ctx.stage(stageName).complete("second answer")),
			];
		});
	});

	test("a standalone task between two same-named parallels keeps its place across the first launch-record write (#5481)", async () => {
		await checkForkReplay("current", ["first", "second", "third"], async (ctx, _replay, source) => {
			const fork = {
				context: "fork" as const,
				forkFromSessionId: source.getSessionId(),
				sessionStore: source.getSessionStore(),
			};
			const [[first], second, [third]] = await Promise.all([
				ctx.parallel([{ name: "b", prompt: "first" }], fork),
				ctx.task("b", { prompt: "second" }),
				ctx.parallel([{ name: "b", prompt: "third" }], fork),
			]);
			return [first!.text, second.text, third!.text];
		});
	});

	test("a writer that has not seen an older run cannot change its step order by registering it again (#5683)", async () => {
		const path = journalPath();
		const runId = "late-registration";
		const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
		try {
			await writePreviousReleaseJournal(runId, path);
			assert.equal(writer.getWorkflow(runId), undefined);
			await writer.commitWorkflowRegistration({
				workflowId: runId,
				name: runId,
				inputs: {},
				createdAt: 1,
				status: "running",
				launchStepKeys: true,
			});
		} finally {
			await writer.close();
		}
		const resumed = await runProgram("chain", runId, path);
		assert.deepEqual(resumed.outputs, ["first b", "second b"]);
		assert.deepEqual(resumed.prompts, ["a fails"]);
	});

	for (const group of ["chain", "parallel"] as const) {
		test(`a run a previous release recorded replays each task's own result after a failed ${group} (#5481)`, async () => {
			const path = journalPath();
			const runId = `previous-release-${group}`;
			await writePreviousReleaseJournal(runId, path);

			const resumed = await runProgram(group, runId, path);
			assert.deepEqual(resumed.outputs, ["first b", "second b"]);
			assert.deepEqual(resumed.prompts, ["a fails"], "no completed task runs again");
		});

		test(`a run this release recorded replays each task's own result after a failed ${group} (#5481)`, async () => {
			const path = journalPath();
			const runId = `this-release-${group}`;
			const first = await runProgram(group, runId, path);
			assert.deepEqual(first.outputs, ["first b", "second b"]);
			assert.deepEqual(first.prompts, ["a fails", "first b", "second b"]);

			const resumed = await runProgram(group, runId, path);
			assert.deepEqual(resumed.outputs, ["first b", "second b"]);
			assert.deepEqual(resumed.prompts, ["a fails"], "no completed task runs again");
		});

		test(`two ${group}s of steps with the same names that ran at once each replay their own results in a run this release recorded (#5481)`, async () => {
			const path = journalPath();
			const runId = `overlapping-${group}`;
			const first: string[][] = [];
			const secondFinished = Promise.withResolvers<void>();
			// The first group's a ends only after the second group's b, so the second group's b starts before the first's.
			await runInJournal(overlappingProgram(group, runId, first), runId, path, async (text) => {
				const step = stepOf(text);
				if (step === "first a") await secondFinished.promise;
				if (step === "second b") secondFinished.resolve();
				return step;
			});
			assert.deepEqual(first, [
				["first a", "first b"],
				["second a", "second b"],
			]);

			const resumed: string[][] = [];
			const prompts = await runInJournal(
				overlappingProgram(group, runId, resumed),
				runId,
				path,
				async (text) => text,
			);
			assert.deepEqual(resumed, first);
			assert.deepEqual(prompts, [], "no completed step runs again");
		});

		test.each(["task", "stage", "tool", "nested task"] as const)(
			`a run stopped after a %s replays each overlapping ${group}'s own steps (#5683)`,
			async (prefix) => {
				const path = journalPath();
				const runId = `early-stop-${prefix}-${group}`;
				const tool = vi.fn(async () => "x");
				for (const attempt of [1, 2, 3]) {
					const outputs: string[][] = [];
					const secondFinished = Promise.withResolvers<void>();
					const program = overlappingProgram(group, "steps", outputs, async (ctx) => {
						if (prefix === "task" || prefix === "nested task") await ctx.task("x", { prompt: "x" });
						else if (prefix === "stage") await ctx.stage("x").prompt("x");
						else await ctx.tool("x", {}, tool);
						if (attempt === 1) throw new Error("stop before either group");
					});
					const definition =
						prefix === "nested task"
							? workflow({
									name: runId,
									description: "",
									inputs: {},
									outputs: {},
									run: async (ctx) => {
										await ctx.workflow(program);
										return {};
									},
								})
							: program;
					const prompts = await runInJournal(definition, runId, path, async (text) => {
						const step = stepOf(text);
						if (step === "first a" && attempt === 2) await secondFinished.promise;
						if (step === "second b") secondFinished.resolve();
						return step;
					});
					assert.deepEqual(
						prompts.map(stepOf).sort(),
						attempt === 2
							? ["first a", "first b", "second a", "second b"]
							: attempt === 1 && prefix !== "tool"
								? ["x"]
								: [],
					);
					assert.equal(tool.mock.calls.length, prefix === "tool" ? 1 : 0);
					assert.deepEqual(
						outputs,
						attempt === 1
							? []
							: [
									["first a", "first b"],
									["second a", "second b"],
								],
					);
				}
			},
		);

		test(`a ${group} starts none of its steps when the run cannot record how it keys them (#5481)`, async () => {
			const path = journalPath();
			const runId = `unrecorded-${group}`;
			const prompts = await runInJournal(
				overlappingProgram(group, runId, []),
				runId,
				path,
				async (text) => text,
				refuseLaunchRecord,
			);
			assert.deepEqual(prompts, []);
		});
	}
});

/** Makes the journal refuse the run's record of how its launches key their steps, as a briefly unavailable store does. */
function refuseLaunchRecord(backend: JournalDurableBackend): void {
	const append = backend.journal.append.bind(backend.journal);
	vi.spyOn(backend.journal, "append").mockImplementation(async (lease, event, options) => {
		const argsHash = (event.payload as { readonly argsHash?: unknown } | undefined)?.argsHash;
		if (event.type === "CheckpointRecorded" && argsHash === LAUNCH_REPLAY_KEYS_CHECKPOINT_NAME)
			throw new StorageUnavailableError(
				{ adapter: "sqlite", location: "test" },
				new Error("the journal is briefly unavailable"),
			);
		return append(lease, event, options);
	});
}

/** The step a prompt of `overlappingProgram` is for; a chain's b is also given its a's result. */
function stepOf(text: string): string {
	return ["first b", "second b", "first a", "second a"].find((step) => text.includes(step)) ?? text;
}

/** Two `ctx.chain`s, or two `ctx.parallel`s with one slot, of steps a and b, launched at once; the run then stops. */
function overlappingProgram(
	group: Group,
	runId: string,
	outputs: string[][],
	before?: (ctx: WorkflowRunContext) => Promise<void>,
) {
	return workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (before !== undefined) await before(ctx);
			const launch = (which: string) => {
				const steps = [
					{ name: "a", prompt: `${which} a` },
					{ name: "b", prompt: `${which} b` },
				];
				return group === "chain" ? ctx.chain(steps) : ctx.parallel(steps, { concurrency: 1 });
			};
			const groups = await Promise.all([launch("first"), launch("second")]);
			outputs.push(...groups.map((results) => results.map((result) => result.text)));
			throw new Error("the run stops after both groups");
		},
	});
}
