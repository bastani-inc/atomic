import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Each attempt opens a new connection to the same run and closes it before the next attempt. */
async function journalProgram(body: (open: () => Promise<JournalDurableBackend>) => Promise<void>): Promise<void> {
	const directory = makeTempDirectory("step-order-");
	try {
		await body(async () => JournalDurableBackend.open(await openSqlRunJournal(join(directory, "run.sqlite"))));
	} finally {
		removeTempDirectory(directory);
	}
}

for (const group of ["chain", "parallel"] as const) {
	test.each(["task", "stage", "tool", "nested task"] as const)(
		`a run stopped after a %s replays each overlapping ${group}'s own steps (#5683)`,
		async (prefix) =>
			journalProgram(async (open) => {
				let toolCalls = 0;
				for (const attempt of [1, 2, 3]) {
					const outputs: string[][] = [];
					const calls: string[] = [];
					const secondFinished = Promise.withResolvers<void>();
					const program = workflow({
						name: "steps",
						description: "",
						inputs: {},
						outputs: {},
						run: async (ctx) => {
							if (prefix === "stage") await ctx.stage("x").prompt("x");
							else if (prefix === "tool") await ctx.tool("x", {}, async () => ++toolCalls);
							else await ctx.task("x", { prompt: "x" });
							if (attempt === 1) throw new Error("stop before groups");
							const groups = await Promise.all(
								["first", "second"].map((owner) =>
									ctx[group](
										[
											{ name: "a", prompt: `${owner} a` },
											// A queued step may compute its name when the worker is admitted.
											prefix === "tool"
												? {
														get name() {
															return "b";
														},
														prompt: `${owner} b`,
													}
												: { name: "b", prompt: `${owner} b` },
										],
										{ concurrency: 1 },
									),
								),
							);
							outputs.push(...groups.map((steps) => steps.map((step) => step.text)));
							throw new Error("stop after groups");
						},
					});
					const definition =
						prefix === "nested task"
							? workflow({
									name: "root",
									description: "",
									inputs: {},
									outputs: {},
									run: async (ctx) => {
										await ctx.workflow(program);
										return {};
									},
								})
							: program;
					const backend = await open();
					try {
						const result = await run(
							definition,
							{},
							{
								runId: "root",
								store: createStore(),
								durableBackend: backend,
								adapters: {
									prompt: {
										prompt: async (text) => {
											// Chain prompts for b can include a's answer.
											const step =
												["first b", "second b", "first a", "second a"].find((s) => text.includes(s)) ??
												text;
											calls.push(step);
											if (step === "first a" && attempt === 2) await secondFinished.promise;
											if (step === "second b") secondFinished.resolve();
											return step;
										},
									},
								},
							},
						);
						assert.equal(result.status, "failed");
						assert.match(result.error ?? "", attempt === 1 ? /stop before groups/ : /stop after groups/);
						assert.equal(toolCalls, prefix === "tool" ? 1 : 0);
						assert.deepEqual(
							calls.sort(),
							attempt === 2
								? ["first a", "first b", "second a", "second b"]
								: attempt === 1 && prefix !== "tool"
									? ["x"]
									: [],
						);
						assert.deepEqual(
							outputs,
							attempt === 1
								? []
								: [
										["first a", "first b"],
										["second a", "second b"],
									],
						);
					} finally {
						await backend.close();
					}
				}
			}),
	);
}

test("a stage named like a grouped task keeps its own result after a cached prefix (#5683)", async () =>
	journalProgram(async (open) => {
		for (const replay of [false, true]) {
			const backend = await open();
			const outputs: string[] = [];
			const calls: string[] = [];
			const program = workflow({
				name: "overlap",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.task("prefix", { prompt: "prefix" });
					const grouped = ctx.chain([
						{ name: "a", prompt: "a" },
						{ name: "b", prompt: "group b" },
					]);
					const ordinary = ctx.stage("task:b").complete("stage b");
					outputs.push((await grouped)[1]!.text, String(await ordinary));
					return {};
				},
			});
			const answer = async (text: string) => {
				const val = ["stage b", "group b", "prefix"].find((s) => text.includes(s)) ?? text;
				calls.push(val);
				return val;
			};
			try {
				const result = await run(
					program,
					{},
					{
						runId: "overlap",
						store: createStore(),
						durableBackend: backend,
						adapters: { prompt: { prompt: answer }, complete: { complete: answer } },
					},
				);
				assert.equal(result.status, "completed", result.error);
				assert.deepEqual(outputs, ["group b", "stage b"]);
				if (replay) assert.deepEqual(calls, []);
			} finally {
				await backend.close();
			}
		}
	}));

test.each(["older run", "shared-pool child"] as const)(
	"a %s records and replays its saved tasks in admission order (#5683)",
	async (kind) =>
		journalProgram(async (open) => {
			const root = "root",
				shared = kind === "shared-pool child";
			const registration = { workflowId: root, name: root, status: "running" as const, inputs: {}, createdAt: 1 };
			const staleWriter = await open();
			try {
				for (const replay of [false, true]) {
					const backend = await open();
					try {
						if (!replay)
							await backend.commitWorkflowRegistration({
								...registration,
								...(shared
									? { launchStepKeys: true as const, resources: { workers: { placement: "shared" as const } } }
									: {}),
							});
						const outputs: string[] = [];
						const prompts: string[] = [];
						const program = workflow({
							name: "steps",
							description: "",
							inputs: {},
							outputs: {},
							run: async (ctx) => {
								try {
									await ctx.chain([
										{ name: "a", prompt: "fail" },
										{ name: "b", prompt: "never started" },
									]);
								} catch (err) {
									if (!String(err).includes("a fails")) throw err;
								}
								for (const prompt of ["first b", "second b"])
									outputs.push((await ctx.task("b", { prompt })).text);
								throw new Error("stop after both tasks");
							},
						});
						const result = await run(
							program,
							{},
							{
								runId: shared ? "child" : root,
								store: createStore(),
								durableBackend: backend,
								...(shared
									? {
											durableScope: { rootWorkflowId: root, scopePrefix: "workflow:child:1" },
											parentRun: { runId: root, rootRunId: root, stageId: "boundary" },
										}
									: {}),
								adapters: {
									prompt: {
										prompt: async (text) => {
											prompts.push(text);
											if (text === "fail") throw new Error("a fails");
											return text;
										},
									},
								},
							},
						);
						assert.equal(result.status, "failed");
						assert.deepEqual(outputs, ["first b", "second b"]);
						assert.deepEqual(prompts, replay ? ["fail"] : ["fail", "first b", "second b"]);
						const scope = shared ? "workflow:child:1:" : "";
						for (const [i, expected] of outputs.entries())
							assert.equal(
								backend.getStageCheckpoint(root, `${scope}task:stage:task:b:${i + 1}`)?.result,
								expected,
							);
					} finally {
						await backend.close();
					}
					if (!replay && !shared) {
						// An executor that did not see the original registration must not upgrade it on refresh.
						assert.equal(staleWriter.getWorkflow(root), undefined);
						await staleWriter.commitWorkflowRegistration({ ...registration, launchStepKeys: true });
						await staleWriter.close();
					}
				}
			} finally {
				await staleWriter.close();
			}
		}),
);
