/**
 * One "node" of the reduced multi-node workflow scenarios (#4329), run as its own process with its own agent
 * directory, HOME and Atomic home, sharing only the run journal selected by MULTINODE_JOURNAL_URL through this
 * checkout's libSQL adapter (MULTINODE_LIBSQL), in the namespace MULTINODE_JOURNAL_NAMESPACE and with the token in MULTINODE_JOURNAL_TOKEN_FILE when set.
 * Every command prints JSON lines; a failure prints `{ error }`.
 *
 *   two-repos <json>  runs a workflow whose two children are bound to two repositories with `workspace()`. Each child
 *                     records a `ctx.tool` effect in its worktree, then, when HOLD_DIR is set, writes
 *                     `<HOLD_DIR>/<name>.holding` and waits to be killed; otherwise it reports what its worktree holds
 *   stepped <json>    runs a workflow in the checkout `cwd` whose stages `one` and `two` each write state.txt and report
 *                     what it held before
 *   fork <json>       forks a run of `stepped` from `fromStage`, prints the fork's id, then its result
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { workspace } from "../../packages/coding-agent/src/core/workspace/index.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { RunJournalOption } from "../../packages/workflows/src/durable/journal/resolution.js";
import { forkRun } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";

interface TwoReposArgs {
	readonly runId: string;
	readonly alpha: string;
	readonly beta: string;
}

interface SteppedArgs {
	readonly runId: string;
	readonly cwd?: string;
}

interface ForkArgs {
	readonly sourceRunId: string;
	readonly fromStage: string;
}

function emit(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function journal(): RunJournalOption {
	const tokenFile = process.env.MULTINODE_JOURNAL_TOKEN_FILE;
	return {
		adapter: process.env.MULTINODE_LIBSQL ?? "",
		options: {
			url: process.env.MULTINODE_JOURNAL_URL ?? "",
			...(process.env.MULTINODE_JOURNAL_NAMESPACE === undefined
				? {}
				: { namespace: process.env.MULTINODE_JOURNAL_NAMESPACE }),
		},
		...(tokenFile === undefined ? {} : { secrets: { authToken: { file: tokenFile } } }),
	};
}

const step = workflow({
	name: "multinode-step",
	description: "",
	inputs: { name: Type.String() },
	outputs: { cwd: Type.String(), effects: Type.String(), notes: Type.String() },
	run: async (ctx) => {
		const cwd = ctx.cwd ?? "";
		await ctx.tool("effect", {}, async () => {
			appendFileSync(join(cwd, "effects.log"), `${process.env.MULTINODE_NODE}\n`);
			writeFileSync(join(cwd, "notes.txt"), `uncommitted, written on ${process.env.MULTINODE_NODE}\n`);
			return "recorded";
		});
		return ctx.tool("continue", {}, async () => {
			const holdDir = process.env.HOLD_DIR;
			if (holdDir) {
				writeFileSync(join(holdDir, `${ctx.inputs.name}.holding`), "");
				await new Promise(() => {});
			}
			return {
				cwd,
				effects: readFileSync(join(cwd, "effects.log"), "utf8"),
				notes: readFileSync(join(cwd, "notes.txt"), "utf8"),
			};
		});
	},
});

const twoRepos = workflow({
	name: "multinode-two-repos",
	description: "",
	inputs: { alpha: Type.String(), beta: Type.String() },
	outputs: { alpha: Type.String(), beta: Type.String() },
	run: async (ctx) => {
		const [alpha, beta] = await Promise.all(
			(["alpha", "beta"] as const).map((name) =>
				ctx.workflow(step, {
					stageName: name,
					inputs: { name },
					workspace: workspace({ repo: ctx.inputs[name], branch: `feat/${name}` }),
				}),
			),
		);
		return {
			alpha: JSON.stringify(alpha?.status === "completed" ? alpha.outputs : alpha),
			beta: JSON.stringify(beta?.status === "completed" ? beta.outputs : beta),
		};
	},
});

const write = workflow({
	name: "multinode-write",
	description: "",
	inputs: { content: Type.String() },
	outputs: { before: Type.String(), cwd: Type.String() },
	run: async (ctx) => {
		const cwd = ctx.cwd ?? "";
		const before = await ctx.tool("write", { content: ctx.inputs.content }, async () => {
			const prior = readFileSync(join(cwd, "state.txt"), "utf8");
			writeFileSync(join(cwd, "state.txt"), ctx.inputs.content);
			return prior;
		});
		return { before, cwd };
	},
});

const stepped = workflow({
	name: "multinode-stepped",
	description: "",
	inputs: {},
	outputs: { one: Type.String(), two: Type.String() },
	run: async (ctx) => {
		const one = await ctx.workflow(write, { stageName: "one", inputs: { content: "one\n" } });
		const two = await ctx.workflow(write, { stageName: "two", inputs: { content: "two\n" } });
		return {
			one: JSON.stringify(one.status === "completed" ? one.outputs : one),
			two: JSON.stringify(two.status === "completed" ? two.outputs : two),
		};
	},
});

function report(result: RunResult): void {
	emit({ runId: result.runId, status: result.status, result: result.result, error: result.error });
}

async function twoReposCommand(args: TwoReposArgs): Promise<void> {
	report(
		await run(twoRepos, { alpha: args.alpha, beta: args.beta }, { runId: args.runId, journal: journal() }),
	);
}

async function steppedCommand(args: SteppedArgs): Promise<void> {
	report(
		await run(stepped, {}, { runId: args.runId, journal: journal(), ...(args.cwd ? { cwd: args.cwd } : {}) }),
	);
}

async function forkCommand(args: ForkArgs): Promise<void> {
	const forked = await forkRun(args.sourceRunId, {
		fromStage: args.fromStage,
		journal: journal(),
		definition: stepped,
	});
	emit({ forkRunId: forked.runId, forkedFrom: forked.forkedFrom });
	report(await forked.result);
}

const [command, json] = process.argv.slice(2);
try {
	const args = JSON.parse(json ?? "{}") as object;
	if (command === "two-repos") await twoReposCommand(args as TwoReposArgs);
	else if (command === "stepped") await steppedCommand(args as SteppedArgs);
	else if (command === "fork") await forkCommand(args as ForkArgs);
	else throw new Error(`unknown command ${command}`);
	process.exit(0);
} catch (error) {
	const typed = error as {
		name?: string;
		code?: string;
		message?: string;
		retryable?: boolean;
		subject?: string;
		problems?: readonly object[];
	};
	emit({
		error: {
			name: typed.name,
			code: typed.code,
			message: typed.message,
			retryable: typed.retryable,
			subject: typed.subject,
			problems: typed.problems,
		},
	});
	process.exit(2);
}
