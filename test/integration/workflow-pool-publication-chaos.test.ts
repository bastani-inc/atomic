import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { PUBLISHING_NESTED_EVERY } from "../fixtures/pool-publishing-child.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const childPath = fileURLToPath(new URL("../fixtures/pool-publishing-child.ts", import.meta.url));
/** Three children publish at once; the spare worker and the replacements take over the two that are interrupted. */
const CHILDREN = 3;
const WORKERS = 4;
const STEPS = 100;
/** Where every child holds while the test kills one worker and stops another. */
const FIRST_GATE = 40;
/** Where every child holds again while the test reads the root's copy of its run. */
const SECOND_GATE = 80;
/** The shortest work lease a pool accepts, so a stopped worker's attempt is recovered quickly. */
const WORK_LEASE_MS = 2_000;
const BUDGET = poolTestBudgetMs(2);

interface Gate {
	readonly index: number;
	readonly pid: number;
}

function arrivals(directory: string, step: number): Gate[] {
	return readdirSync(directory).flatMap((name) => {
		const match = new RegExp(`^at-${step}-(\\d+)-(\\d+)$`).exec(name);
		return match === null ? [] : [{ index: Number(match[1]), pid: Number(match[2]) }];
	});
}

/** Lets a stopped worker go on; one that is already gone needs nothing. */
function resume(pid: number): void {
	try {
		process.kill(pid, "SIGCONT");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(25);
	}
}

/** What a child's worker holds while it waits at the second gate: every step before it ended, that step running. */
function holdsWorkerState(child: RunSnapshot): boolean {
	const last = child.toolNodes.at(-1);
	return (
		child.toolNodes.length === SECOND_GATE + 1 && last?.name === `step-${SECOND_GATE}` && last.status === "running"
	);
}

test.skipIf(process.platform === "win32")(
	"pooled children's runs reach the root intact while workers are killed and stopped mid-publication (#4317)",
	async () => {
		const directory = makeTempDirectory("pool-publication-chaos-");
		const path = join(directory, "journal.sqlite");
		const exportName = "publishingChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const outputs: unknown[] = [];
		const parent = workflow({
			name: "pool-publication-chaos-root",
			description: "Root over pooled children whose workers are killed and stopped while they publish",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const results = await Promise.all(
					Array.from({ length: CHILDREN }, (_, index) =>
						ctx.workflow(child, {
							inputs: { directory, index, steps: STEPS, gates: [FIRST_GATE, SECOND_GATE] },
						}),
					),
				);
				for (const result of results) outputs.push(result.status === "completed" ? result.outputs : result);
				return {};
			},
		});
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: WORKERS,
			leaseMs: WORK_LEASE_MS,
			definitions: [{ definition: child, path: childPath, exportName }],
		});
		const store = createStore();
		const runId = randomUUID();
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		const stopped: number[] = [];
		try {
			const running = run(parent, {}, { runId, cwd: directory, store, durableBackend: backend, signal: budget });
			await waitUntil(
				() => arrivals(directory, FIRST_GATE).length === CHILDREN,
				"every child at the first gate",
				budget,
			);
			const [killed, paused, kept] = arrivals(directory, FIRST_GATE).sort((left, right) => left.index - right.index);
			const uninterrupted = kept!.index;
			process.kill(killed!.pid, "SIGKILL");
			process.kill(paused!.pid, "SIGSTOP");
			stopped.push(paused!.pid);
			await writeFileEnsuringDir(join(directory, `release-${FIRST_GATE}`), "");
			// The killed and stopped children are replayed from their first step by other workers.
			await waitUntil(
				() => new Set(arrivals(directory, SECOND_GATE).map((gate) => gate.index)).size === CHILDREN,
				"every child at the second gate",
				budget,
			);
			resume(paused!.pid);
			stopped.length = 0;
			const children = () => store.childRuns(runId);
			await waitUntil(
				() => children().length === CHILDREN && children().every(holdsWorkerState),
				"the root's copy of every child to show its worker's state",
				budget,
			);
			for (const copy of children()) {
				const nodes = copy.toolNodes.map((node) => node.name);
				assert.deepEqual(
					nodes,
					Array.from({ length: SECOND_GATE + 1 }, (_, step) => `step-${step}`),
					`every step once, in order, in ${copy.id}`,
				);
				const ended = copy.toolNodes
					.slice(0, -1)
					.filter((node) => node.status === "running" || node.status === "pending");
				assert.deepEqual(ended, [], `every step before the gate ended in ${copy.id}`);
				const hosts = copy.stages;
				assert.equal(hosts.length, Math.ceil((SECOND_GATE + 1) / PUBLISHING_NESTED_EVERY), JSON.stringify(hosts));
				for (const host of hosts) {
					assert.equal(host.status, "completed", JSON.stringify(host));
					assert.equal(host.workerExecution?.reconnecting, undefined, "no stage of an earlier attempt is left");
				}
				// A replayed child takes its nested results from the journal without running them again, so only the
				// child no worker failed under shows a nested run for each of its nested workflows.
				if (copy.inputs.index !== uninterrupted) continue;
				const nested = store.childRuns(copy.id);
				assert.deepEqual(
					nested.map((entry) => [entry.parentStageId, entry.status]),
					hosts.map((host) => [host.id, "completed"]),
				);
			}
			await writeFileEnsuringDir(join(directory, `release-${SECOND_GATE}`), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(outputs.length, CHILDREN);
			for (const output of outputs)
				assert.equal((output as { steps?: number }).steps, STEPS, JSON.stringify(outputs));
			await pool.close();
		} finally {
			for (const pid of stopped) resume(pid);
			// After a failure the pool is closed again without hiding that failure; a passing run closed it above.
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
