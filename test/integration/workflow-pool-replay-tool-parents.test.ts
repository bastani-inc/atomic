import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { PoolStageHandoff } from "../../packages/workflows/src/workers/stage-handoff.js";
import type { HoldPoint } from "../fixtures/pool-tool-stage-child.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import {
	fileExists,
	makeTempDirectory,
	readText,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/**
 * A pooled child whose completed agent stage follows a `ctx.tool` must replay on a replacement worker (#4888). The
 * replayed stage used to lose its tool parent, so its replay record disagreed with the original and the pool rejected
 * the child as "immutable stage identity drift".
 */

/** One pool cold start, plus a replacement worker's start, the child's work and the root's teardown. */
const BUDGET = poolTestBudgetMs(3);
const childPath = fileURLToPath(new URL("../fixtures/pool-tool-stage-child.ts", import.meta.url));

/** The pids that ran each step, in order, from the fixture's `steps.log`. */
async function stepPids(directory: string): Promise<ReadonlyMap<string, readonly number[]>> {
	const steps = new Map<string, number[]>();
	const path = join(directory, "steps.log");
	if (!(await fileExists(path))) return steps;
	for (const line of (await readText(path)).split("\n")) {
		if (line === "") continue;
		const [name, pid] = line.split(" ");
		steps.set(name!, [...(steps.get(name!) ?? []), Number(pid)]);
	}
	return steps;
}

/**
 * Runs a root over a two-worker local pool whose one child holds at `hold`; `interrupt` ends the holding attempt.
 * Returns the root's result and the pids that ran each step of the child.
 */
async function runPooledChild(
	label: string,
	hold: HoldPoint,
	interrupt: (
		directory: string,
		execution: Promise<{ status: string; error?: string }>,
		root: string,
	) => Promise<number | undefined>,
	intercom = false,
): Promise<{
	readonly status: string;
	readonly error?: string;
	readonly steps: ReadonlyMap<string, readonly number[]>;
	readonly lostPid: number | undefined;
	readonly finishPid: number | undefined;
	readonly reply: string | undefined;
}> {
	const directory = makeTempDirectory(`pool-replay-tool-parents-${label}-`);
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	const child = await loadWorkerWorkflow(childPath, "child");
	const controller = new AbortController();
	const budget = AbortSignal.any([controller.signal, AbortSignal.timeout(BUDGET.waitMs)]);
	let outputs: { reply?: unknown; finishPid?: unknown } | undefined;
	let execution: ReturnType<typeof run> | undefined;
	const root = testRunId(`pool-replay-tool-parents-${label}`);
	try {
		execution = run(
			workflow({
				name: "pool-replay-tool-parents-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const result = await ctx.workflow(child, { inputs: { directory, hold, intercom } });
					assert.equal(result.status, "completed");
					outputs = result.outputs;
					return {};
				},
			}),
			{},
			{
				runId: root,
				cwd: directory,
				store: createStore(),
				durableBackend: backend,
				signal: budget,
				toolControlRegistry: createToolControlRegistry(),
				localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
			},
		);
		const lostPid = await interrupt(directory, execution, root);
		const result = await execution;
		return {
			status: result.status,
			...(result.error === undefined ? {} : { error: result.error }),
			steps: await stepPids(directory),
			lostPid,
			finishPid: typeof outputs?.finishPid === "number" ? outputs.finishPid : undefined,
			reply: typeof outputs?.reply === "string" ? outputs.reply : undefined,
		};
	} finally {
		controller.abort();
		await writeFileEnsuringDir(join(directory, "release"), "");
		await execution?.catch(() => undefined);
		await backend.close();
		removeTempDirectory(directory);
	}
}

/** SIGKILLs the worker that holds at `hold`, then lets its replacement through. */
function killHolder(hold: Exclude<HoldPoint, "none">) {
	return async (directory: string, execution: Promise<{ status: string; error?: string }>) => {
		const marker = join(directory, `holding-${hold}`);
		await untilOrRunEnds(() => fileExists(marker), execution, BUDGET.waitMs);
		const pid = Number(await readText(marker));
		assert.ok(pid > 0 && pid !== process.pid, `a worker process holds at ${hold}: ${pid}`);
		process.kill(pid, "SIGKILL");
		await writeFileEnsuringDir(join(directory, "release"), "");
		return pid;
	};
}

describe.skipIf(process.platform === "win32")("pooled child replay after a tool (#4888)", () => {
	test(
		"a worker killed during the tool after a completed stage is replaced, and the stage replays (#4888)",
		async () => {
			const outcome = await runPooledChild("finish", "finish", killHolder("finish"));
			assert.equal(outcome.status, "completed", outcome.error);
			const steps = outcome.steps;
			assert.deepEqual(steps.get("start"), [outcome.lostPid], "start replays on the replacement");
			assert.deepEqual(steps.get("turn"), [outcome.lostPid], "the completed stage replays on the replacement");
			assert.equal(steps.get("finish")?.length, 2, JSON.stringify([...steps]));
			assert.equal(steps.get("finish")![0], outcome.lostPid);
			assert.notEqual(outcome.finishPid, outcome.lostPid, "finish runs again on the replacement");
			assert.equal(outcome.finishPid, steps.get("finish")![1]);
			assert.equal(outcome.reply, `agent ${outcome.lostPid}`, "the replayed stage keeps its recorded reply");
		},
		BUDGET.timeoutMs,
	);

	test(
		"a transient storage refusal on stage delivery replaces the attempt, and the stage replays (#4888)",
		async () => {
			const directory = makeTempDirectory("pool-replay-tool-parents-broker-");
			const broker = new IntercomBrokerFixture(join(directory, "agent"));
			broker.overrideAgentDir();
			const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
			const client = new IntercomClient();
			client.on("error", () => {});
			const deliver = PoolStageHandoff.prototype.deliver;
			let refused = 0;
			const refusal = vi.spyOn(PoolStageHandoff.prototype, "deliver").mockImplementation(async function (
				this: PoolStageHandoff,
				...args: Parameters<PoolStageHandoff["deliver"]>
			) {
				if (refused++ === 0)
					throw new StorageUnavailableError(
						{ adapter: "sqlite", location: "pool stage delivery" },
						new Error("transient refusal"),
					);
				return deliver.apply(this, args);
			});
			try {
				await broker.startSourceBroker(BUDGET.waitMs);
				// The stage holds a queued message for its drain, which the root refuses once.
				const outcome = await runPooledChild(
					"delivery",
					"start",
					async (childDirectory, execution, root) => {
						await client.connect({
							name: "replay-sender",
							cwd: childDirectory,
							model: "fixture",
							pid: process.pid,
							startedAt: Date.now(),
							lastActivity: Date.now(),
							group: `workflow:${root}`,
						});
						await untilOrRunEnds(
							async () =>
								(await client.listDirectory()).workflowStages.some((stage) => stage.stageName === "agent"),
							execution,
							BUDGET.waitMs,
						);
						await untilOrRunEnds(
							async () =>
								(await client.send(`workflow:${root}/**`, { text: "queued for the stage" })).queued === true,
							execution,
							BUDGET.waitMs,
						);
						await writeFileEnsuringDir(join(childDirectory, "release"), "");
						return undefined;
					},
					true,
				);
				assert.equal(outcome.status, "completed", outcome.error);
				assert.ok(refused > 1, `the root refused one delivery and took the next: ${refused}`);
				const steps = outcome.steps;
				assert.equal(steps.get("start")?.length, 1, JSON.stringify([...steps]));
				assert.equal(steps.get("turn")?.length, 1, JSON.stringify([...steps]));
				assert.equal(outcome.reply, `agent ${steps.get("turn")![0]}`);
			} finally {
				refusal.mockRestore();
				await client.disconnect();
				await broker.cleanup();
				removeTempDirectory(directory);
			}
		},
		BUDGET.timeoutMs,
	);

	test.each(["start", "turn"] as const)(
		"a worker killed at %s, before the stage completes, is replaced and the child completes (#4888)",
		async (hold) => {
			const outcome = await runPooledChild(hold, hold, killHolder(hold));
			assert.equal(outcome.status, "completed", outcome.error);
			const steps = outcome.steps;
			assert.equal(steps.get(hold)?.length, 2, JSON.stringify([...steps]));
			assert.equal(steps.get(hold)![0], outcome.lostPid);
			assert.notEqual(outcome.finishPid, outcome.lostPid);
			assert.deepEqual(steps.get("finish"), [outcome.finishPid]);
			assert.equal(outcome.reply, `agent ${steps.get("turn")!.at(-1)}`);
		},
		BUDGET.timeoutMs,
	);
});
