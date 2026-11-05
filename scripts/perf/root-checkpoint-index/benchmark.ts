#!/usr/bin/env bun
/**
 * Benchmark for a pooled root's checkpoint index in its parent process (#4318).
 *
 * Seeds one SQLite journal with a root that started `--children` child boundaries, then writes `--checkpoints` stage
 * session checkpoints into the root's run under its lease, the way the pool coordinator writes its workers'. Each case
 * runs in its own process: a parent backend owns the root, folds those checkpoints (`catchUpWorkflow`), and reports
 * the heap it retains after a full collection, the entries its index lists, the fold cost per checkpoint, and what
 * one more checkpoint of the root itself costs (commit plus the `listCheckpoints` a boundary check reads).
 *
 * `keep-all` is the parent before #4318: its backend keeps every checkpoint of the root. `own` keeps only the root's
 * (`retainOwnCheckpoints`, as `LocalWorkerPool.prepare` calls it).
 *
 *   bun run scripts/perf/root-checkpoint-index/benchmark.ts --checkpoints 10000,100000,400000 --out /tmp/root-index.md
 *
 * `--modes keep-all` runs only the first mode, which also runs on sources from before `retainOwnCheckpoints` existed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../../packages/workflows/src/durable/journal/types.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
} from "../../../packages/workflows/src/durable/types.js";

const ROOT = "benchmark-pooled-root";
const MODES = ["keep-all", "own"] as const;
type Mode = (typeof MODES)[number];
const APPEND_BATCH = 1_000;
const OWN_COMMITS = 20;

interface Options {
	readonly checkpoints: readonly number[];
	readonly children: number;
	readonly modes: readonly Mode[];
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		checkpoints: (value("checkpoints") ?? "10000,100000,400000").split(",").map(Number),
		children: Number(value("children") ?? "450"),
		modes: (value("modes") ?? MODES.join(",")).split(",") as Mode[],
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

function scope(child: number): string {
	return `workflow:pooled-child:${child + 1}`;
}

function boundaryStart(child: number): DurableStageCheckpoint {
	const stageId = `boundary-${child}`;
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `boundary-start:${scope(child)}`,
		name: "workflow:pooled-child",
		replayKey: scope(child),
		startedAt: 1,
		completedAt: 1 + child,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId,
			parentIds: [],
			sourceOrder: child,
			status: "running",
			run: { runId: ROOT, runName: "pooled-root" },
			boundary: {
				version: DURABLE_BOUNDARY_TOPOLOGY_VERSION,
				replayScope: scope(child),
				alias: "pooled-child",
				workflow: "pooled-child",
				invocationFingerprint: `fingerprint-${child}`,
				child: {
					runId: `child-run-${child}`,
					runName: "pooled-child",
					parentRunId: ROOT,
					parentStageId: stageId,
					rootRunId: ROOT,
				},
				event: "start",
				status: "running",
			},
		},
	};
}

/** The checkpoint a worker records each time a pooled stage opens or replaces its session. */
function sessionCheckpoint(index: number, children: number): DurableStageCheckpoint {
	const child = index % children;
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${scope(child)}:session:${crypto.randomUUID()}:${crypto.randomUUID()}`,
		replayKey: `${scope(child)}:implement:${1 + (index % 7)}`,
		name: "implement",
		sessionId: crypto.randomUUID(),
		startedAt: 1_000 + index,
		completedAt: 1_000 + index,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId: `child-${child}-stage-${index % 7}`,
			parentIds: [`child-${child}-stage-${(index % 7) - 1}`],
			sourceOrder: index % 7,
			status: "running",
			run: {
				runId: `child-run-${child}`,
				runName: "pooled-child",
				parentRunId: ROOT,
				parentStageId: `boundary-${child}`,
				rootRunId: ROOT,
			},
		},
	};
}

function ownTool(index: number): DurableCheckpoint {
	const id = `root-step-${index}`;
	return {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: id,
		name: id,
		argsHash: id,
		output: id,
		completedAt: 10_000_000 + index,
	};
}

function collect(): number {
	Bun.gc(true);
	Bun.gc(true);
	return process.memoryUsage().heapUsed;
}

interface CaseResult {
	readonly mode: Mode;
	readonly checkpoints: number;
	readonly children: number;
	readonly indexEntries: number;
	readonly completedCheckpoints: number;
	readonly retainedBytes: number;
	readonly foldMs: number;
	readonly ownCommitMs: number;
	readonly listMs: number;
}

/** One case, in a process of its own so the heap it measures is its own. */
async function runCase(path: string, mode: Mode, checkpoints: number, children: number): Promise<CaseResult> {
	const database = await openNodeSqliteDatabase(path);
	await database.exec("PRAGMA synchronous=OFF");
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "pooled-root",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	for (let child = 0; child < children; child++) await backend.commitCheckpoint(boundaryStart(child));
	if (mode === "own") await backend.retainOwnCheckpoints(ROOT);
	const state = await journal.leaseState(ROOT);
	if (state === undefined) throw new Error("the root has no lease");
	const lease = { runId: ROOT, holderId: state.holderId, epoch: state.epoch };
	for (let start = 0; start < checkpoints; start += APPEND_BATCH) {
		const appends = Array.from({ length: Math.min(APPEND_BATCH, checkpoints - start) }, (_, offset) => {
			const checkpoint = sessionCheckpoint(start + offset, children);
			return {
				event: { type: RUN_EVENT_TYPES.checkpointRecorded, payload: checkpoint as never },
				key: JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]),
				context: <R>(action: () => R) => action(),
			};
		});
		for (const outcome of await journal.appendMany(lease, appends))
			if (outcome.status === "rejected") throw outcome.reason;
	}
	const before = collect();
	const foldStarted = performance.now();
	await backend.catchUpWorkflow(ROOT);
	const foldMs = performance.now() - foldStarted;
	const retainedBytes = collect() - before;
	const ownStarted = performance.now();
	let listMs = 0;
	for (let index = 0; index < OWN_COMMITS; index++) {
		await backend.commitCheckpoint(ownTool(index));
		const listStarted = performance.now();
		backend.listCheckpoints(ROOT);
		listMs += performance.now() - listStarted;
	}
	const ownCommitMs = (performance.now() - ownStarted) / OWN_COMMITS;
	const result: CaseResult = {
		mode,
		checkpoints,
		children,
		indexEntries: backend.listCheckpoints(ROOT).length,
		completedCheckpoints: backend.getWorkflow(ROOT)?.completedCheckpoints ?? -1,
		retainedBytes,
		foldMs,
		ownCommitMs,
		listMs: listMs / OWN_COMMITS,
	};
	await backend.close();
	await journal.close();
	await database.close();
	return result;
}

function row(result: CaseResult): string {
	const kib = (bytes: number) => (bytes / 1024).toFixed(1);
	return [
		result.mode,
		result.checkpoints,
		result.indexEntries,
		result.completedCheckpoints,
		(result.retainedBytes / 1024 / 1024).toFixed(1),
		kib(Math.max(0, result.retainedBytes) / result.children),
		((result.foldMs * 1000) / Math.max(1, result.checkpoints)).toFixed(2),
		result.ownCommitMs.toFixed(3),
		result.listMs.toFixed(3),
	].join(" | ");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const caseIndex = argv.indexOf("--case");
	if (caseIndex !== -1) {
		const [path, mode, checkpoints, children] = argv.slice(caseIndex + 1, caseIndex + 5);
		const result = await runCase(path!, mode as Mode, Number(checkpoints), Number(children));
		console.log(JSON.stringify(result));
		return;
	}
	const options = parseOptions(argv);
	const lines = [
		`# Pooled root checkpoint index (#4318): ${options.children} child boundaries`,
		"",
		"mode | child checkpoints | index entries | completedCheckpoints | retained heap (MiB) | retained per child (KiB) | fold (µs/checkpoint) | own commit + list (ms) | listCheckpoints (ms)",
		"--- | --- | --- | --- | --- | --- | --- | --- | ---",
	];
	for (const checkpoints of options.checkpoints)
		for (const mode of options.modes) {
			const directory = mkdtempSync(join(tmpdir(), "root-checkpoint-index-"));
			try {
				const child = spawnSync(
					process.execPath,
					[
						"run",
						import.meta.path,
						"--case",
						join(directory, "journal.sqlite"),
						mode,
						String(checkpoints),
						String(options.children),
					],
					{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
				);
				if (child.status !== 0) throw new Error(`case ${mode} ${checkpoints} failed:\n${child.stderr}`);
				const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as CaseResult;
				lines.push(row(result));
				console.log(lines.at(-1));
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	if (options.out !== undefined) writeFileSync(options.out, `${lines.join("\n")}\n`);
	console.log(`\n${lines.join("\n")}`);
}

await main();
