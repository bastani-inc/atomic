/**
 * Invariant checker of the distributed fork chaos scenario (#4321). Runs on a test VM with Bun from the
 * repository root, reading the shared journal directly with SQL (independently of the fork code path):
 *
 *   bun run test/distributed/fork-chaos/check.ts snapshot <sources.json> <out.json>
 *   bun run test/distributed/fork-chaos/check.ts check <collected-dir> <before.json> <timeline.json> <out.json>
 *
 * `collected-dir` holds every node's attempt logs (`<node>/*.jsonl`). The result is JSON: each invariant with
 * `pass`, its numbers and up to 25 example violations.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/index.js";
import { RUN_RESULT_CHECKPOINT_NAME } from "../../../packages/workflows/src/durable/run-result.js";
import { type Json, LEDGER_TABLE, loadConfig, NAMED_TOOLS, openSharedStorage } from "./shared.js";
import { assertChaosInvariants, ChaosInvariantError, expectedForkRetryable } from "./verdict.mjs";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

interface Event {
	readonly seq: number;
	readonly epoch: number;
	readonly key: string | null;
	readonly type: string;
	readonly payloadText: string;
	readonly payload: Record<string, Json> | undefined;
	readonly at: number;
}

interface RunRow {
	readonly runId: string;
	readonly name: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly status: string;
	readonly headerJson: string;
}

interface Checkpoint {
	readonly seq: number;
	readonly at: number;
	readonly kind: string;
	readonly checkpointId: string;
	readonly name: string;
	readonly replayKey?: string;
	readonly workflowId: string;
	readonly output: Json;
	readonly topology?: {
		readonly boundary?: { readonly child?: { readonly runId?: string; readonly rootRunId?: string } };
		readonly run?: { readonly runId?: string; readonly rootRunId?: string };
		readonly occurrenceKey?: string;
	};
}

const num = (value: Row[string] | undefined): number => Number(value ?? 0);
const str = (value: Row[string] | undefined): string => (value === null || value === undefined ? "" : String(value));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function loadRuns(database: SqliteDatabase): Promise<RunRow[]> {
	const rows = await database.all<Row>(
		"SELECT run_id, name, cwd, created_at, status, header_json FROM wf_runs ORDER BY run_id",
	);
	return rows.map((row) => ({
		runId: str(row.run_id),
		name: str(row.name),
		cwd: str(row.cwd),
		createdAt: num(row.created_at),
		status: str(row.status),
		headerJson: str(row.header_json),
	}));
}

async function loadEvents(database: SqliteDatabase, runId: string): Promise<Event[]> {
	const rows = await database.all<Row>(
		"SELECT seq, epoch, key, type, payload, at FROM wf_events WHERE run_id = ? ORDER BY seq",
		runId,
	);
	return rows.map((row) => {
		let payload: Record<string, Json> | undefined;
		try {
			payload = JSON.parse(str(row.payload)) as Record<string, Json>;
		} catch {
			payload = undefined;
		}
		return {
			seq: num(row.seq),
			epoch: num(row.epoch),
			key: row.key === null ? null : str(row.key),
			type: str(row.type),
			payloadText: str(row.payload),
			payload,
			at: num(row.at),
		};
	});
}

function hashOf(value: Json): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function runFingerprint(run: RunRow, events: readonly Event[]) {
	return {
		runRowHash: hashOf([run.name, run.cwd, run.createdAt, run.status, run.headerJson]),
		eventsHash: hashOf(
			events.map((event) => [event.seq, event.epoch, event.key, event.type, event.payloadText, event.at]),
		),
		events: events.length,
		lastSeq: events.at(-1)?.seq ?? 0,
	};
}

async function snapshot(sourcesFile: string, out: string): Promise<void> {
	const config = loadConfig();
	const { database } = await openSharedStorage(config);
	const sources = JSON.parse(readFileSync(sourcesFile, "utf8")) as { runId: string }[];
	const runs = new Map((await loadRuns(database)).map((run) => [run.runId, run]));
	const result: Record<string, Json> = {};
	for (const { runId } of sources) {
		const run = runs.get(runId);
		result[runId] = run === undefined ? null : runFingerprint(run, await loadEvents(database, runId));
	}
	const now = await database.get<Row>("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now");
	writeFileSync(out, JSON.stringify({ takenAtSqld: num(now?.now), sources: result }, null, 2));
	console.log(JSON.stringify({ sources: Object.keys(result).length }));
	await database.close();
}

interface LogRecord {
	readonly t: string;
	readonly id?: string;
	readonly pid: number;
	readonly localNow: number;
	readonly node?: string;
	readonly [key: string]: Json;
}

function readLogs(dir: string): {
	readonly records: (LogRecord & { readonly logNode: string })[];
	readonly files: number;
} {
	const records: (LogRecord & { readonly logNode: string })[] = [];
	let files = 0;
	for (const node of readdirSync(dir)) {
		const nodeDir = join(dir, node);
		if (!statSync(nodeDir).isDirectory()) continue;
		for (const file of readdirSync(nodeDir)) {
			if (!file.endsWith(".jsonl")) continue;
			files++;
			for (const line of readFileSync(join(nodeDir, file), "utf8").split("\n")) {
				if (line.length === 0) continue;
				try {
					records.push({ ...(JSON.parse(line) as LogRecord), logNode: node });
				} catch {
					// A torn final line of a killed process is skipped; every complete line was fsynced.
				}
			}
		}
	}
	return { records, files };
}

class Invariant {
	pass = true;
	readonly violations: Json[] = [];
	readonly numbers: Record<string, Json> = {};
	fail(violation: Json): void {
		this.pass = false;
		if (this.violations.length < 25) this.violations.push(violation);
		this.numbers.violationCount = (Number(this.numbers.violationCount ?? 0) as number) + 1;
	}
	toJSON(): Json {
		return { pass: this.pass, ...this.numbers, violations: this.violations };
	}
}

function counter(): Map<string, number> {
	return new Map();
}
function bump(map: Map<string, number>, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}
const obj = (map: Map<string, number>): Json => Object.fromEntries([...map].sort());

function rejectionsByNode(list: readonly { readonly logNode: string }[]): Map<string, number> {
	const map = counter();
	for (const record of list) bump(map, record.logNode);
	return map;
}

function stats(values: readonly number[]): Json {
	if (values.length === 0) return { count: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	return { count: sorted.length, min: sorted[0]!, median: at(0.5), p95: at(0.95), max: sorted.at(-1)! };
}

function checkpointsOf(events: readonly Event[]): Checkpoint[] {
	return events
		.filter((event) => event.type === "CheckpointRecorded" && event.payload !== undefined)
		.map((event) => ({ ...(event.payload as unknown as Checkpoint), seq: event.seq, at: event.at }));
}

/** Run ids a run's own execution used: the run and its nested children. */
function ownIds(runId: string, checkpoints: readonly Checkpoint[]): Set<string> {
	const ids = new Set([runId]);
	for (const checkpoint of checkpoints) {
		const run = checkpoint.topology?.run;
		if (run?.runId !== undefined && (run.rootRunId === runId || run.runId === runId)) ids.add(run.runId);
		const child = checkpoint.topology?.boundary?.child;
		if (child?.runId !== undefined && child.rootRunId === runId) ids.add(child.runId);
	}
	return ids;
}

function comparableOutput(checkpoint: Checkpoint): Json {
	const output = checkpoint.output;
	if (output !== null && typeof output === "object" && !Array.isArray(output) && "runId" in output) {
		const { runId: _runId, ...rest } = output as Record<string, Json>;
		return rest;
	}
	return output;
}

async function check(collectedDir: string, beforeFile: string, timelineFile: string, out: string): Promise<boolean> {
	const config = loadConfig();
	const { database } = await openSharedStorage(config);
	const started = Date.now();
	const before = JSON.parse(readFileSync(beforeFile, "utf8")) as {
		sources: Record<string, ReturnType<typeof runFingerprint> | null>;
	};
	const timeline = JSON.parse(readFileSync(timelineFile, "utf8")) as {
		readonly stops?: readonly {
			readonly token: string;
			readonly node: string;
			readonly source: string;
			readonly stoppedAtController?: number;
			readonly continuedAtController?: number;
			readonly skew?: Record<string, number>;
		}[];
		readonly [key: string]: Json;
	};
	const sourceIds = new Set(Object.keys(before.sources));
	const runs = await loadRuns(database);
	const runById = new Map(runs.map((run) => [run.runId, run]));
	const events = new Map<string, Event[]>();
	for (const run of runs) events.set(run.runId, await loadEvents(database, run.runId));
	const checkpoints = new Map([...events].map(([runId, list]) => [runId, checkpointsOf(list)]));
	const orphanEventRuns = await database.all<Row>(
		"SELECT DISTINCT run_id FROM wf_events WHERE run_id NOT IN (SELECT run_id FROM wf_runs)",
	);
	const integrity = await database.all<Row>("PRAGMA integrity_check");
	const leases = await database.all<Row>("SELECT run_id, holder_id, epoch, renewed_at FROM wf_leases");
	const ledger = await database.all<Row>(
		`SELECT execution_id, ctx_run_id, tool, node, pid, attempt_id, at FROM ${LEDGER_TABLE} ORDER BY at`,
	);
	const { records, files } = readLogs(collectedDir);

	// --- Sources untouched -------------------------------------------------------------------------------
	const sourcesUntouched = new Invariant();
	for (const [runId, fingerprint] of Object.entries(before.sources)) {
		const run = runById.get(runId);
		const after = run === undefined ? null : runFingerprint(run, events.get(runId) ?? []);
		if (fingerprint === null || after === null || JSON.stringify(after) !== JSON.stringify(fingerprint))
			sourcesUntouched.fail({ runId, before: fingerprint as unknown as Json, after: after as unknown as Json });
	}
	sourcesUntouched.numbers.sources = sourceIds.size;

	// --- Corruption and atomicity -------------------------------------------------------------------------
	const noCorruption = new Invariant();
	noCorruption.numbers.integrityCheck = integrity.map((row) => Object.values(row).map(String).join(",")).join(";");
	if (noCorruption.numbers.integrityCheck !== "ok")
		noCorruption.fail({ integrityCheck: noCorruption.numbers.integrityCheck });
	noCorruption.numbers.eventsWithoutRunRow = orphanEventRuns.length;
	for (const row of orphanEventRuns) noCorruption.fail({ eventsWithoutRunRow: str(row.run_id) });
	let unparsable = 0;
	let totalEvents = 0;
	for (const [runId, list] of events) {
		totalEvents += list.length;
		list.forEach((event, index) => {
			if (event.payload === undefined) {
				unparsable++;
				noCorruption.fail({ runId, seq: event.seq, problem: "payload is not JSON" });
			}
			if (event.seq !== index + 1)
				noCorruption.fail({ runId, seq: event.seq, expected: index + 1, problem: "seq gap" });
		});
		if (list.length === 0) noCorruption.fail({ runId, problem: "run row without events" });
		else if (list[0]!.type !== "RunStarted") noCorruption.fail({ runId, problem: `first event ${list[0]!.type}` });
	}
	noCorruption.numbers.runs = runs.length;
	noCorruption.numbers.events = totalEvents;
	noCorruption.numbers.unparsablePayloads = unparsable;

	// --- Attempt logs -----------------------------------------------------------------------------------
	interface Attempt {
		readonly id: string;
		node: string;
		plan?: Record<string, Json>;
		readonly records: LogRecord[];
		terminal?: string;
	}
	const attempts = new Map<string, Attempt>();
	const copyBegins = new Map<string, { attemptId: string; pid: number }[]>();
	const deadPids = new Set<number>();
	const pidEnds = new Map<number, string>();
	for (const record of records) {
		if (record.t === "self-kill") deadPids.add(record.pid);
		if (record.t === "drained" || record.t === "redrive-complete") pidEnds.set(record.pid, record.t);
		if (record.id === undefined || record.id === null) continue;
		let attempt = attempts.get(record.id);
		if (attempt === undefined) {
			attempt = { id: record.id, node: record.logNode, records: [] };
			attempts.set(record.id, attempt);
		}
		attempt.records.push(record);
		if (record.t === "intent") attempt.plan = record.plan as Record<string, Json>;
		if (
			["done", "aborted", "probe-ok", "failed-nonretryable", "gave-up", "probe-unexpected-success"].includes(
				record.t,
			)
		)
			attempt.terminal = record.t;
		if (record.t === "copy-begin" && typeof record.forkRunId === "string") {
			const list = copyBegins.get(record.forkRunId) ?? [];
			list.push({ attemptId: record.id, pid: record.pid });
			copyBegins.set(record.forkRunId, list);
		}
	}
	const forkAttempts = [...attempts.values()].filter((attempt) => attempt.plan !== undefined);

	// --- Fork runs: atomicity, copied prefix, wrong-tree replay ------------------------------------------
	const atomicity = new Invariant();
	const wrongTree = new Invariant();
	const work = new Invariant();
	const forkRuns = runs.filter((run) => {
		const first = events.get(run.runId)?.[0];
		return (
			first?.type === "RunStarted" &&
			(first.payload?.forkedFrom as { runId?: string } | undefined)?.runId !== undefined
		);
	});
	const allowedMemo = new Map<string, Set<string>>();
	const forkedFromOf = (runId: string) =>
		events.get(runId)?.[0]?.payload?.forkedFrom as { runId?: string; stagePath?: string } | undefined;
	const allowedIds = (runId: string, depth = 0): Set<string> => {
		const memo = allowedMemo.get(runId);
		if (memo !== undefined) return memo;
		const ids = ownIds(runId, checkpoints.get(runId) ?? []);
		const parent = forkedFromOf(runId)?.runId;
		if (parent !== undefined && depth < 50) for (const id of allowedIds(parent, depth + 1)) ids.add(id);
		allowedMemo.set(runId, ids);
		return ids;
	};
	const rootOf = new Map<string, string>();
	for (const run of runs)
		for (const id of ownIds(run.runId, checkpoints.get(run.runId) ?? [])) rootOf.set(id, run.runId);
	for (const run of runs)
		if (!sourceIds.has(run.runId) && !forkRuns.includes(run))
			atomicity.fail({ runId: run.runId, problem: "neither a source nor a fork" });

	const ledgerByRunTool = new Map<string, Row[]>();
	let unattributedLedger = 0;
	const unattributed: Json[] = [];
	for (const row of ledger) {
		const root = rootOf.get(str(row.ctx_run_id));
		if (root === undefined) {
			unattributedLedger++;
			if (unattributed.length < 25)
				unattributed.push({
					ctxRunId: str(row.ctx_run_id),
					tool: str(row.tool),
					node: str(row.node),
					attempt: str(row.attempt_id),
				});
			continue;
		}
		const key = `${root}:${str(row.tool)}`;
		const list = ledgerByRunTool.get(key) ?? [];
		list.push(row);
		ledgerByRunTool.set(key, list);
	}
	let copiedCheckpointsTotal = 0;
	let forksCompleted = 0;
	let replayedTools = 0;
	let executedTools = 0;
	let atLeastOnceExtraRows = 0;
	let trueDuplicateRows = 0;
	const forkDepth = counter();
	for (const run of forkRuns) {
		const list = events.get(run.runId)!;
		const seedEnd = list.findIndex((event) => event.epoch !== 0);
		const seed = list.slice(0, seedEnd === -1 ? list.length : seedEnd);
		const forkedFrom = forkedFromOf(run.runId)!;
		const seedCheckpoints = checkpointsOf(seed);
		copiedCheckpointsTotal += seedCheckpoints.length;
		const last = seed.at(-1);
		if (seed[0]?.type !== "RunStarted" || last?.type !== "StatusChanged")
			atomicity.fail({
				runId: run.runId,
				problem: "seed is not RunStarted..StatusChanged",
				types: seed.map((event) => event.type),
			});
		else if (Number(last.payload?.completedCheckpoints) !== seedCheckpoints.length)
			atomicity.fail({
				runId: run.runId,
				problem: "completedCheckpoints mismatch",
				recorded: Number(last.payload?.completedCheckpoints),
				copied: seedCheckpoints.length,
			});
		for (const event of seed.slice(1, -1))
			if (!["CheckpointRecorded", "MessageSettled", "MessageDelivered"].includes(event.type))
				atomicity.fail({ runId: run.runId, seq: event.seq, problem: `unexpected seed event ${event.type}` });
		const source = forkedFrom.runId!;
		let depth = 1;
		for (
			let parent = forkedFromOf(source)?.runId;
			parent !== undefined && depth < 50;
			parent = forkedFromOf(parent)?.runId
		)
			depth++;
		bump(forkDepth, String(depth));
		const sourceCheckpoints = checkpoints.get(source);
		if (sourceCheckpoints === undefined) {
			atomicity.fail({ runId: run.runId, problem: "forkedFrom names no run", source });
			continue;
		}
		const stagePath = forkedFrom.stagePath;
		let cut = Number.POSITIVE_INFINITY;
		if (stagePath !== undefined) {
			const name = stagePath.split(".").at(-1)!.replace(/#\d+$/, "");
			const target = sourceCheckpoints.find(
				(checkpoint) =>
					checkpoint.kind === "stage" &&
					checkpoint.name === name &&
					checkpoint.output !== undefined &&
					checkpoint.topology?.occurrenceKey === undefined,
			);
			if (target === undefined) {
				atomicity.fail({ runId: run.runId, problem: "fork point not in source", stagePath });
				continue;
			}
			cut = Math.min(
				...sourceCheckpoints
					.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.replayKey === target.replayKey)
					.map((checkpoint) => checkpoint.seq),
			);
		}
		const prefix = sourceCheckpoints.filter((checkpoint) => checkpoint.seq < cut);
		const completedKeys = new Set(
			prefix
				.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.output !== undefined)
				.map((checkpoint) => checkpoint.replayKey),
		);
		const expected =
			stagePath === undefined
				? sourceCheckpoints
				: prefix.filter((checkpoint) =>
						checkpoint.kind === "tool"
							? checkpoint.name !== RUN_RESULT_CHECKPOINT_NAME
							: checkpoint.kind !== "stage" ||
								checkpoint.topology?.boundary !== undefined ||
								completedKeys.has(checkpoint.replayKey),
					);
		if (expected.length !== seedCheckpoints.length)
			atomicity.fail({
				runId: run.runId,
				problem: "copied checkpoint count",
				expected: expected.length,
				copied: seedCheckpoints.length,
				stagePath: stagePath ?? null,
			});
		const allowed = allowedIds(run.runId);
		const own = ownIds(run.runId, checkpoints.get(run.runId)!);
		seedCheckpoints.forEach((copied, index) => {
			const original = expected[index];
			if (original === undefined) return;
			const same =
				copied.kind === original.kind &&
				copied.checkpointId === original.checkpointId &&
				copied.name === original.name &&
				copied.replayKey === original.replayKey &&
				JSON.stringify(comparableOutput(copied)) === JSON.stringify(comparableOutput(original));
			if (!same || copied.workflowId !== run.runId)
				wrongTree.fail({
					runId: run.runId,
					source,
					copied: copied.checkpointId,
					expected: original.checkpointId,
					workflowId: copied.workflowId,
				});
		});
		const runCheckpoints = checkpoints.get(run.runId)!;
		const seedSeqs = new Set(seedCheckpoints.map((checkpoint) => checkpoint.seq));
		for (const checkpoint of runCheckpoints) {
			if (checkpoint.workflowId !== run.runId)
				wrongTree.fail({ runId: run.runId, seq: checkpoint.seq, workflowId: checkpoint.workflowId });
			if (typeof checkpoint.output !== "string") continue;
			const isNamedTool = checkpoint.kind === "tool" && (NAMED_TOOLS as readonly string[]).includes(checkpoint.name);
			const isNamedStage = checkpoint.kind === "stage" && /^[sc]\d$/.test(checkpoint.name);
			if (!isNamedTool && !isNamedStage) continue;
			for (const id of checkpoint.output.match(UUID) ?? []) {
				const scope = seedSeqs.has(checkpoint.seq) ? allowed : isNamedTool ? own : allowed;
				if (!scope.has(id))
					wrongTree.fail({
						runId: run.runId,
						seq: checkpoint.seq,
						name: checkpoint.name,
						foreignRunId: id,
						executed: !seedSeqs.has(checkpoint.seq),
					});
			}
		}
		// Work: replayed tools never re-run, executed tools run exactly once.
		if (run.status !== "completed") {
			work.fail({ runId: run.runId, problem: "fork run did not complete", status: run.status });
			continue;
		}
		forksCompleted++;
		for (const tool of NAMED_TOOLS) {
			const copied = seedCheckpoints.filter((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === tool);
			const executed = runCheckpoints.filter(
				(checkpoint) => checkpoint.kind === "tool" && checkpoint.name === tool && !seedSeqs.has(checkpoint.seq),
			);
			const rows = ledgerByRunTool.get(`${run.runId}:${tool}`) ?? [];
			if (copied.length + executed.length !== 1)
				work.fail({
					runId: run.runId,
					tool,
					problem: "tool checkpoint count",
					copied: copied.length,
					executed: executed.length,
				});
			if (copied.length === 1) {
				replayedTools++;
				if (rows.length > 0)
					work.fail({ runId: run.runId, tool, problem: "replayed tool executed again", rows: rows.length });
				continue;
			}
			executedTools++;
			if (rows.length === 0) {
				work.fail({ runId: run.runId, tool, problem: "executed tool has no ledger row (lost work)" });
				continue;
			}
			const committedAt = executed[0]?.at ?? Number.POSITIVE_INFINITY;
			for (const row of rows.slice(1)) {
				if (num(row.at) > committedAt) {
					trueDuplicateRows++;
					work.fail({
						runId: run.runId,
						tool,
						problem: "tool executed after its checkpoint committed",
						rowAt: num(row.at),
						committedAt,
						pid: num(row.pid),
						node: str(row.node),
					});
				} else atLeastOnceExtraRows++;
			}
		}
	}
	atomicity.numbers.forkRuns = forkRuns.length;
	atomicity.numbers.copiedCheckpoints = copiedCheckpointsTotal;
	atomicity.numbers.forkGenerations = obj(forkDepth);
	wrongTree.numbers.forkRunsChecked = forkRuns.length;

	// --- Attempt accounting ------------------------------------------------------------------------------
	const terminals = counter();
	const categories = counter();
	const copiesPerAttempt = counter();
	for (const attempt of forkAttempts) {
		bump(terminals, attempt.terminal ?? "none");
		if (attempt.terminal === undefined || attempt.terminal === "gave-up")
			work.fail({
				attempt: attempt.id,
				node: attempt.node,
				problem: "attempt did not converge",
				terminal: attempt.terminal ?? null,
			});
		if (attempt.terminal === "failed-nonretryable" || attempt.terminal === "probe-unexpected-success")
			work.fail({ attempt: attempt.id, problem: attempt.terminal });
		const created = new Set(
			attempt.records
				.filter(
					(record) =>
						record.t === "copy-begin" && typeof record.forkRunId === "string" && runById.has(record.forkRunId),
				)
				.map((record) => record.forkRunId as string),
		);
		bump(copiesPerAttempt, String(created.size));
		if (created.size > 1)
			work.fail({ attempt: attempt.id, problem: "one attempt created several forks", forkRunIds: [...created] });
		if (attempt.terminal === "aborted" && created.size > 0)
			work.fail({ attempt: attempt.id, problem: "abort reported but a fork run exists", forkRunIds: [...created] });
		for (const record of attempt.records) {
			if (record.t !== "forked") continue;
			const forkRunId = record.forkRunId as string;
			const run = runById.get(forkRunId);
			if (run === undefined) work.fail({ attempt: attempt.id, forkRunId, problem: "reported fork run missing" });
			else if (forkedFromOf(forkRunId)?.runId !== (record.forkedFrom as { runId?: string }).runId)
				work.fail({ attempt: attempt.id, forkRunId, problem: "forkedFrom differs from report" });
		}
		if (attempt.terminal === "done") {
			const done = attempt.records.find((record) => record.t === "done");
			if (runById.get(done?.forkRunId as string)?.status !== "completed")
				work.fail({ attempt: attempt.id, problem: "done but fork run not completed" });
		}
	}
	for (const run of forkRuns) {
		const begins = copyBegins.get(run.runId);
		if (begins === undefined) {
			work.fail({ runId: run.runId, problem: "fork run without a recorded attempt (orphan)" });
			bump(categories, "orphan");
			continue;
		}
		const attempt = attempts.get(begins[0]!.attemptId)!;
		const reported = attempt.records.some((record) => record.t === "forked" && record.forkRunId === run.runId);
		const copyFailed = attempt.records.some(
			(record) => record.t === "copy-failed-but-created" && record.forkRunId === run.runId,
		);
		const adoptedAfterTypedError = attempt.records.some(
			(record) => record.t === "created-despite-error" && record.forkRunId === run.runId,
		);
		const pid = begins[0]!.pid;
		const ended = attempt.records.find(
			(record) => record.pid === pid && record.t === "copy-end" && record.forkRunId === run.runId,
		);
		if (reported) bump(categories, "reported-success");
		else if (copyFailed) bump(categories, "copy-failed-but-created");
		else if (adoptedAfterTypedError) bump(categories, "written-then-typed-error-adopted");
		else if (deadPids.has(pid) || !pidEnds.has(pid))
			bump(categories, ended === undefined ? "killed-mid-copy-committed" : "killed-after-commit");
		else {
			bump(categories, "unreported");
			work.fail({
				runId: run.runId,
				attempt: attempt.id,
				problem: "fork run exists but its live attempt never reported it",
			});
		}
	}
	work.numbers.attempts = forkAttempts.length;
	work.numbers.attemptTerminals = obj(terminals);
	work.numbers.forkRunsByCategory = obj(categories);
	work.numbers.forkRunsPerAttempt = obj(copiesPerAttempt);
	work.numbers.forkRunsCompleted = forksCompleted;
	work.numbers.toolsReplayedFromCheckpoints = replayedTools;
	work.numbers.toolsExecuted = executedTools;
	work.numbers.extraLedgerRowsBeforeCheckpointCommit = atLeastOnceExtraRows;
	work.numbers.toolExecutionsAfterCheckpointCommit = trueDuplicateRows;
	work.numbers.ledgerRows = ledger.length;
	work.numbers.ledgerRowsUnattributed = unattributedLedger;
	work.numbers.ledgerRowsUnattributedExamples = unattributed;
	for (const sourceId of sourceIds) {
		for (const tool of NAMED_TOOLS) {
			const rows = ledgerByRunTool.get(`${sourceId}:${tool}`) ?? [];
			if (rows.length !== 1)
				work.fail({ runId: sourceId, tool, problem: "source tool ledger rows", rows: rows.length });
		}
	}

	// --- Typed errors -------------------------------------------------------------------------------------
	const typed = new Invariant();
	const byCode = counter();
	const untyped = counter();
	const cleanup = counter();
	const execution = counter();
	let retries = 0;
	let aborted = 0;
	for (const record of records) {
		if (record.t === "try" && Number(record.n) > 1) retries++;
		if (record.t === "aborted") aborted++;
		if (record.t === "release" && record.ok === false) bump(cleanup, `${(record.error as { name?: string }).name}`);
		if (record.t === "resume-error") bump(execution, `${(record.error as { name?: string }).name}`);
		if (record.t !== "error") continue;
		const error = record.error as {
			fork: boolean;
			copyPhase?: string;
			name: string;
			code?: string;
			reason?: string;
			retryable?: boolean;
			causeName?: string;
			message: string;
		};
		const phase = String(record.phase);
		if (error.fork) {
			bump(
				byCode,
				`${phase}:${error.code}${error.reason === undefined ? "" : `:${error.reason}`}${error.copyPhase === undefined ? "" : `@${error.copyPhase}`}`,
			);
			const shouldRetry = expectedForkRetryable(error.code, error.copyPhase);
			if (error.retryable !== shouldRetry)
				typed.fail({ attempt: record.id ?? null, problem: "retryable flag", code: error.code ?? null });
		} else {
			bump(untyped, `${phase}:${error.name}${error.causeName === undefined ? "" : `<-${error.causeName}`}`);
			typed.fail({
				attempt: record.id ?? null,
				phase,
				name: error.name,
				causeName: error.causeName ?? null,
				message: error.message,
			});
		}
	}
	for (const record of records)
		if (record.t === "copy-failed-but-created")
			typed.fail({
				attempt: record.id ?? null,
				forkRunId: record.forkRunId ?? null,
				problem: "ForkCopyFailedError reported but the fork run was written",
			});
	typed.numbers.forkErrorsByPhaseCode = obj(byCode);
	typed.numbers.nonForkErrorsByPhaseName = obj(untyped);
	typed.numbers.abortedWithSignalReason = aborted;
	typed.numbers.claimReleaseFailures = obj(cleanup);
	typed.numbers.executionResumeErrors = obj(execution);
	typed.numbers.retries = retries;
	const probes = counter();
	for (const record of records) if (record.t === "probe-ok") bump(probes, `${record.probe}:${record.code}`);
	typed.numbers.probesAnsweredWithExpectedCode = obj(probes);

	// --- Fencing ------------------------------------------------------------------------------------------
	const fencing = new Invariant();
	const episodes: Json[] = [];
	const claimRecords = records.filter((record) => record.t === "claim");
	for (const stop of timeline.stops ?? []) {
		const stopping = records.find((record) => record.t === "stopping" && record.token === stop.token);
		if (stopping === undefined) {
			fencing.fail({ token: stop.token, problem: "the stopper never claimed the source" });
			continue;
		}
		const holder = String(stopping.holder);
		const claim = claimRecords.find((record) => record.holder === holder && record.status === "acquired");
		const t0 = Number(claim?.leaseRenewedAt ?? claim?.sqldNow);
		const competitors = claimRecords.filter(
			(record) => record.source === stop.source && record.holder !== holder && Number(record.sqldNow) >= t0,
		);
		const heldByStopped = competitors.filter((record) => record.status === "held" && record.heldBy === holder);
		// A decision happened between the journal-clock reads taken just before and just after the claim call.
		const heldAfterWindow = heldByStopped.filter(
			(record) => typeof record.sqldBefore === "number" && record.sqldBefore - t0 >= 120_000,
		);
		const acquired = competitors
			.filter((record) => record.status === "acquired")
			.map((record) => ({
				node: record.logNode,
				holder: String(record.holder),
				grantAt: record.leaseHolder === record.holder ? Number(record.leaseRenewedAt) : Number(record.sqldNow),
				exact: record.leaseHolder === record.holder,
				offsetMs: record.localNow - Number(record.sqldNow),
			}))
			.sort((a, b) => a.grantAt - b.grantAt);
		for (const grant of acquired)
			if (grant.grantAt - t0 < 120_000)
				fencing.fail({
					token: stop.token,
					problem: "claim taken over inside the 120 s window",
					ageMs: grant.grantAt - t0,
					...grant,
				});
		const offsets = new Map<string, number[]>();
		const continuedRecord = records.find((record) => record.t === "continued" && record.holder === holder);
		const windowEnd = continuedRecord === undefined ? Number.POSITIVE_INFINITY : Number(continuedRecord.sqldNow);
		for (const record of competitors.filter((entry) => Number(entry.sqldNow) <= windowEnd)) {
			const list = offsets.get(record.logNode) ?? [];
			list.push(record.localNow - Number(record.sqldNow));
			offsets.set(record.logNode, list);
		}
		const continued = records.find((record) => record.t === "continued" && record.holder === holder);
		const stopperAttempt = attempts.get(String(stopping.id));
		const release = stopperAttempt?.records.find((record) => record.t === "release" && record.holder === holder);
		const stoppedCopy = stopperAttempt?.records.find(
			(record) => record.t === "copy-end" && record.pid === stopping.pid,
		);
		const finalLease = leases.find((row) => str(row.run_id) === stop.source);
		if (str(finalLease?.holder_id) === holder)
			fencing.fail({ token: stop.token, problem: "stale holder still holds the lease at the end" });
		if (heldByStopped.length === 0)
			fencing.fail({ token: stop.token, problem: "no competitor observed the fresh claim" });
		if (acquired.length === 0)
			fencing.fail({ token: stop.token, problem: "no competitor proceeded after the window" });
		episodes.push({
			token: stop.token,
			node: stop.node,
			source: stop.source,
			claimAtSqld: t0,
			competitorsRejectedForeignLease: heldByStopped.length,
			competitorRejectionsByNode: obj(rejectionsByNode(heldByStopped)),
			lastRejectionAgeMs:
				heldByStopped.length === 0 ? null : Math.max(...heldByStopped.map((record) => Number(record.sqldNow) - t0)),
			lastRejectionCallStartAgeMs:
				heldByStopped.length === 0
					? null
					: Math.max(...heldByStopped.map((record) => Number(record.sqldBefore ?? Number.NaN) - t0)),
			rejectionsWhoseCallStartedAfter120s: heldAfterWindow.length,
			firstTakeoverAgeMs: acquired[0] === undefined ? null : acquired[0].grantAt - t0,
			firstTakeoverExact: acquired[0]?.exact ?? null,
			takeoversAfterWindow: acquired.length,
			competitorClockOffsetMsByNode: Object.fromEntries(
				[...offsets].map(([node, list]) => [node, stats(list) as Json]),
			),
			stoppedForMs: continued === undefined ? null : Number(continued.sqldNow) - t0,
			leaseHolderWhenResumed: continued === undefined ? null : (continued.leaseHolder as string | null),
			resumedCopy: (stoppedCopy?.result as string | undefined) ?? (stoppedCopy?.error as Json) ?? null,
			resumedRelease: release === undefined ? null : release.ok === true ? "ok" : (release.error as Json),
			stopperTerminal: stopperAttempt?.terminal ?? null,
			finalLeaseHolder: str(finalLease?.holder_id) || null,
			skew: (stop.skew ?? null) as Json,
		});
	}
	fencing.numbers.episodes = episodes;

	// --- Recovery -----------------------------------------------------------------------------------------
	const recovery = new Invariant();
	const unfinished = forkRuns.filter((run) => run.status !== "completed").length;
	const unconverged = forkAttempts.filter(
		(attempt) => attempt.terminal === undefined || attempt.terminal === "gave-up",
	).length;
	if (unfinished > 0) recovery.fail({ problem: "fork runs not completed", count: unfinished });
	if (unconverged > 0) recovery.fail({ problem: "attempts not converged", count: unconverged });
	const adopted = records.filter((record) => record.t === "adopted").length;
	const redriven = records.filter((record) => record.t === "redrive").length;
	recovery.numbers.attemptsRedrivenAfterKill = redriven;
	recovery.numbers.forksAdoptedAfterKill = adopted;
	recovery.numbers.copyFailedButCreated = records.filter((record) => record.t === "copy-failed-but-created").length;
	recovery.numbers.writtenThenTypedErrorAdopted = records.filter(
		(record) => record.t === "created-despite-error",
	).length;
	recovery.numbers.resumedExecutions = records.filter(
		(record) =>
			record.t === "exec" && Number(record.resume) > 0 && record.status === "completed" && record.already !== true,
	).length;
	recovery.numbers.convergence = (timeline.convergence ?? null) as Json;

	const attemptsByNode = counter();
	for (const attempt of forkAttempts) bump(attemptsByNode, attempt.node);
	const forked = records.filter((record) => record.t === "forked");
	const selfKills = counter();
	for (const record of records) if (record.t === "self-kill") bump(selfKills, String(record.point));
	const latencyByNode = new Map<string, number[]>();
	for (const record of forked) {
		const list = latencyByNode.get(record.logNode) ?? [];
		list.push(Number(record.latencyMs));
		latencyByNode.set(record.logNode, list);
	}
	const result = {
		checkedAt: new Date().toISOString(),
		checkMs: Date.now() - started,
		logFiles: files,
		invariants: {
			sourcesUntouched: sourcesUntouched.toJSON(),
			noCorruption: noCorruption.toJSON(),
			atomicForkRuns: atomicity.toJSON(),
			noLostOrDuplicatedWork: work.toJSON(),
			noWrongTreeReplay: wrongTree.toJSON(),
			fencing: fencing.toJSON(),
			typedErrors: typed.toJSON(),
			recovery: recovery.toJSON(),
		},
		numbers: {
			forkAttempts: forkAttempts.length,
			forkAttemptsByNode: obj(attemptsByNode),
			tries: records.filter((record) => record.t === "try").length,
			successfulForkCalls: forked.length,
			forkLatencyMs: stats(forked.map((record) => Number(record.latencyMs))),
			forkLatencyMsByNode: Object.fromEntries([...latencyByNode].map(([node, list]) => [node, stats(list) as Json])),
			listForkPointsMs: stats(records.filter((record) => record.t === "points").map((record) => Number(record.ms))),
			selfKillsByPoint: obj(selfKills),
			processesKilled: deadPids.size,
			claims: claimRecords.length,
			claimsHeld: claimRecords.filter((record) => record.status === "held").length,
			runsInJournal: runs.length,
			forkRuns: forkRuns.length,
			finalLeasesHeld: leases.filter((row) => row.holder_id !== null).length,
			finalLeasesHeldDetail: leases
				.filter((row) => row.holder_id !== null)
				.map((row) => {
					const claim = claimRecords.find((record) => record.holder === str(row.holder_id));
					return {
						runId: str(row.run_id),
						holderKind: str(row.holder_id).startsWith("fork:") ? "fork claim" : "run execution",
						holderProcessSelfKilled: claim === undefined ? null : deadPids.has(claim.pid),
						holderNode: claim?.logNode ?? null,
						source: sourceIds.has(str(row.run_id)),
					};
				}),
		},
	};
	writeFileSync(out, JSON.stringify(result, null, 2));
	console.log(
		JSON.stringify(
			Object.fromEntries(
				Object.entries(result.invariants).map(([name, value]) => [name, (value as { pass: boolean }).pass]),
			),
		),
	);
	await database.close();
	// The report is written either way; the exit status says whether every invariant passed.
	try {
		assertChaosInvariants(JSON.stringify(result));
		return true;
	} catch (error) {
		if (!(error instanceof ChaosInvariantError)) throw error;
		console.error(error.message);
		return false;
	}
}

let passed = true;
switch (process.argv[2]) {
	case "snapshot":
		await snapshot(process.argv[3]!, process.argv[4]!);
		break;
	case "check":
		passed = await check(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!);
		break;
	default:
		throw new Error(`unknown mode ${process.argv[2]}`);
}
process.exit(passed ? 0 : 1);
