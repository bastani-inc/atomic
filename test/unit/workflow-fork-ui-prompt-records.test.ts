import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { type ForkCarryMessages, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

useTemporaryAgentDir();

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

type PromptKind = "confirm" | "select" | "input";

const ANSWERS = { confirm: true, select: "beta", input: "typed" } as const;

/** Answers every prompt node the run opens, the way the interactive host does, and records what it asked. */
function answerPrompts(store: Store, asked: string[]): () => void {
	const answered = new Set<string>();
	return store.subscribe(() => {
		for (const run of store.runs())
			for (const stage of run.stages) {
				const prompt = stage.pendingPrompt;
				if (prompt === undefined || answered.has(prompt.id)) continue;
				answered.add(prompt.id);
				asked.push(stage.name);
				const kind = stage.name as PromptKind;
				queueMicrotask(() => store.resolveStagePendingPrompt(run.id, stage.id, prompt.id, ANSWERS[kind]));
			}
	});
}

/** Runs `def` as the interactive host does, answering its prompts, and returns what it asked. */
async function runInteractively(def: ReturnType<typeof promptWorkflow>, runId: string, backend: MemoryJournalBackend) {
	const store = createStore();
	const asked: string[] = [];
	const stop = answerPrompts(store, asked);
	try {
		const result = await run(
			def,
			{},
			{ runId, durableBackend: backend, store, usePromptNodesForUi: true, adapters: complete },
		);
		return { result, asked };
	} finally {
		stop();
	}
}

async function ask(ctx: Pick<WorkflowRunContext, "ui" | "tool">, kind: PromptKind): Promise<string> {
	if (kind === "confirm") return String(await ctx.ui.confirm("proceed?"));
	if (kind === "select") return await ctx.ui.select("pick one", ["alpha", "beta"]);
	return await ctx.ui.input("name it");
}

interface Trace {
	toolRuns: number;
	readonly answers: string[];
}

/**
 * Parent [s1, prompt, t1, s2, child[c1]], or with the prompt and t1 inside the child: [s1, child[prompt, t1, c1], s2].
 */
function promptWorkflow(kind: PromptKind, inChild: boolean, trace: Trace) {
	const promptThenTool = async (ctx: Pick<WorkflowRunContext, "ui" | "tool">) => {
		trace.answers.push(await ask(ctx, kind));
		await ctx.tool("t1", {}, async () => {
			trace.toolRuns++;
			return "tooled";
		});
	};
	const child = workflow({
		name: "inner",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (inChild) await promptThenTool(ctx);
			await ctx.stage("c1").complete("c1");
			return {};
		},
	});
	return workflow({
		name: `fork-ui-${kind}-${inChild ? "child" : "parent"}`,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("s1").complete("s1");
			if (!inChild) await promptThenTool(ctx);
			if (inChild) await ctx.workflow(child, { stageName: "inner" });
			await ctx.stage("s2").complete("s2");
			if (!inChild) await ctx.workflow(child, { stageName: "inner" });
			return {};
		},
	});
}

const complete = {
	complete: { complete: async (text: string) => text },
};

const cases = [
	{ inChild: false, fromStage: "s2" },
	{ inChild: true, fromStage: "s2" },
	{ inChild: true, fromStage: "inner.c1" },
] as const;

for (const kind of ["confirm", "select", "input"] as const) {
	for (const { inChild, fromStage } of cases) {
		for (const carryMessages of ["before", "all"] as const satisfies readonly ForkCarryMessages[]) {
			const where = inChild ? "inside a child workflow" : "in the parent";
			test(`a fork from ${fromStage} after an answered ctx.ui.${kind} ${where} (carry ${carryMessages}) shows the prompt and resumes without re-asking (#4879)`, async () => {
				const backend = await createMemoryTestBackend();
				const trace: Trace = { toolRuns: 0, answers: [] };
				const def = promptWorkflow(kind, inChild, trace);
				const runId = testRunId(`fork-ui-${kind}-${inChild}-${fromStage}-${carryMessages}`);
				const source = await runInteractively(def, runId, backend);
				assert.equal(source.result.status, "completed", source.result.error);
				assert.deepEqual(source.asked, [kind]);

				const fork = await forkDurableRun(backend, {
					source: "sdk",
					runId,
					fromStage,
					carryMessages,
					definition: def,
				});
				const snapshots = durableWorkflowRunSnapshots(backend, backend.getWorkflow(fork.runId)!);
				assert.ok(snapshots.length > 0, "the fork has a durable view right after forking");
				const stages = snapshots.flatMap((snapshot) => snapshot.stages);
				assert.deepEqual(
					stages.filter((stage) => stage.name === "s1").map((stage) => stage.status),
					["completed"],
				);
				assert.deepEqual(
					stages
						.filter((stage) => stage.replayKey?.includes("prompt:") === true)
						.map((stage) => [stage.name, stage.status]),
					[[kind, "completed"]],
				);
				assert.deepEqual(
					snapshots.flatMap((snapshot) => snapshot.toolNodes).map((node) => [node.name, node.status]),
					[["t1", "cached"]],
					"a durable view shows a completed tool as cached",
				);

				const resumed = await runInteractively(def, fork.runId, backend);
				assert.equal(resumed.result.status, "completed", resumed.result.error);
				assert.deepEqual(resumed.asked, [], "the answered prompt is not asked again");
				const answer = String(ANSWERS[kind]);
				// A child that finished before the fork point replays as a whole, without running its body again.
				const replaysChildBody = !(inChild && fromStage === "s2");
				assert.deepEqual(
					trace.answers,
					replaysChildBody ? [answer, answer] : [answer],
					"the fork replays the source's answer",
				);
				assert.equal(trace.toolRuns, 1, "t1 replays its checkpoint");
			});
		}
	}
}
