/**
 * Distributed fork chaos workload (#4321). Runs on every test VM with Bun from the repository root:
 *
 *   bun run test/distributed/fork-chaos/workload.ts <seed|forker|stopper|resume|local|tlscheck> [args]
 *
 * `FC_CONFIG` names the node config; `FC_CONTROL` (optional) names the control file the controller rewrites while
 * the scenario runs (default `<stateDir>/control.json`). Every step of every fork attempt is appended, fsynced, to
 * `<stateDir>/attempts-<node>-<pid>.jsonl`, which the checker reads.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteTransactionOptions,
} from "../../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../../packages/storage-libsql/libsql.js";
import { isForkError } from "../../../packages/workflows/src/durable/fork-errors.js";
import type { ForkPoint } from "../../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../../packages/workflows/src/durable/journal/journal-backend.js";
import type { SqlRunJournal } from "../../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../../packages/workflows/src/durable/journal/types.js";
import { forkRun, listForkPoints } from "../../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { run } from "../../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../../packages/workflows/src/shared/store.js";
import type { WorkflowInputValues } from "../../../packages/workflows/src/shared/types.js";
import {
	attemptScope,
	chaosWorkflows,
	describeError,
	type ErrorRecord,
	echoAdapters,
	ensureLedger,
	type Json,
	JsonlLog,
	loadConfig,
	type NodeConfig,
	openSharedStorage,
	openSharedStorageWithRetry,
	recordExecution,
	repoRoot,
	type SharedStorage,
	STORE_NOW_SQL,
	sleep,
} from "./shared.js";

/** What the controller steers at runtime; re-read before every attempt and at every hook. */
interface Control {
	readonly concurrency: number;
	readonly sources: readonly string[];
	readonly hotSource?: string;
	readonly hotP: number;
	readonly killAfterClaimP: number;
	readonly killMidTxP: number;
	readonly killAfterCommitP: number;
	readonly killInToolP: number;
	readonly abortP: number;
	readonly probeP: number;
	readonly forkOfForkP: number;
	readonly inputsP: number;
	readonly carryAllP: number;
	readonly wholeRunP: number;
	readonly otherCwdP: number;
	/** The next claim of `source` stops this process with SIGSTOP, once per token. */
	readonly stopAfterClaim?: { readonly source: string; readonly token: string };
	/** Stop starting attempts; finish the ones in flight, then exit 0. */
	readonly drain: boolean;
	/** For `stopper`: how many attempts to run before draining. */
	readonly maxAttempts?: number;
}

const DEFAULT_CONTROL: Control = {
	concurrency: 2,
	sources: [],
	hotP: 0.3,
	killAfterClaimP: 0,
	killMidTxP: 0,
	killAfterCommitP: 0,
	killInToolP: 0,
	abortP: 0.05,
	probeP: 0.04,
	forkOfForkP: 0.1,
	inputsP: 0.3,
	carryAllP: 0.5,
	wholeRunP: 0.08,
	otherCwdP: 0.15,
	drain: false,
};

type Probe = "target-not-found" | "definition-mismatch" | "source-not-found" | "invalid-option";
const PROBE_CODES: Readonly<Record<Probe, string>> = {
	"target-not-found": "target-not-found",
	"definition-mismatch": "definition-mismatch",
	"source-not-found": "source-not-found",
	"invalid-option": "invalid-option",
};

interface AttemptPlan {
	readonly source: string;
	readonly forkOfFork: boolean;
	readonly probe?: Probe;
	readonly wholeRun: boolean;
	readonly pick: number;
	readonly inputs?: WorkflowInputValues;
	readonly carryMessages: "before" | "all";
	readonly cwd?: string;
	readonly abortAfterMs?: number;
}

const mode = process.argv[2];
const config: NodeConfig = loadConfig();
const controlPath = process.env.FC_CONTROL ?? join(config.stateDir, "control.json");
const logTag = mode === "stopper" ? "stopper" : mode === "resume" ? "resume" : "attempts";
const log = new JsonlLog(join(config.stateDir, `${logTag}-${config.node}-${process.pid}-${Date.now()}.jsonl`));

function control(): Control {
	try {
		return { ...DEFAULT_CONTROL, ...(JSON.parse(readFileSync(controlPath, "utf8")) as Partial<Control>) };
	} catch {
		return DEFAULT_CONTROL;
	}
}

function selfKill(point: string, extra: { readonly [key: string]: Json } = {}): void {
	const scope = attemptScope.getStore();
	(scope?.log ?? log).write({ t: "self-kill", id: scope?.attemptId ?? null, point, ...extra });
	process.kill(process.pid, "SIGKILL");
}

/** Copy context: which attempt a `createRunWithEvents` transaction belongs to. */
const copyScope = new AsyncLocalStorage<{ readonly forkRunId: string }>();

async function storeClock(database: SqliteDatabase, journal: RunJournal, runId: string) {
	try {
		const row = await database.get<{ now: number }>(`SELECT ${STORE_NOW_SQL} AS now`);
		const lease = await journal.leaseState(runId);
		return {
			sqldNow: row === undefined ? null : Number(row.now),
			leaseHolder: lease?.holderId ?? null,
			leaseRenewedAt: lease?.renewedAt ?? null,
			leaseEpoch: lease?.epoch ?? null,
		};
	} catch (error) {
		return { clockError: describeError(error).name };
	}
}

/** Chaos hooks around the shared journal: claim, copy, release and the copy transaction. */
const hooks = {
	database(database: SqliteDatabase): void {
		const transaction = database.transaction.bind(database);
		database.transaction = <T>(
			body: (tx: SqliteExecutor) => Promise<T>,
			options?: SqliteTransactionOptions,
		): Promise<T> =>
			transaction(async (tx) => {
				const result = await body(tx);
				const copy = copyScope.getStore();
				if (copy !== undefined && Math.random() < control().killMidTxP)
					selfKill("mid-copy-transaction", { forkRunId: copy.forkRunId });
				return result;
			}, options);
	},
	journal(journal: SqlRunJournal, database: SqliteDatabase): void {
		const takeoverExpired = journal.takeoverExpired.bind(journal);
		journal.takeoverExpired = async (runId, holderId, staleAfterMs) => {
			const scope = attemptScope.getStore();
			if (scope === undefined || !holderId.startsWith("fork:"))
				return takeoverExpired(runId, holderId, staleAfterMs);
			const before = await database
				.get<{ now: number }>(`SELECT ${STORE_NOW_SQL} AS now`)
				.then((row) => (row === undefined ? null : Number(row.now)))
				.catch(() => null);
			const outcome = await takeoverExpired(runId, holderId, staleAfterMs);
			const clock = await storeClock(database, journal, runId);
			scope.log.write({
				t: "claim",
				id: scope.attemptId,
				source: runId,
				holder: holderId,
				status: outcome.status,
				sqldBefore: before,
				heldBy: outcome.status === "held" ? outcome.holderId : null,
				epoch: outcome.status === "acquired" ? outcome.lease.epoch : outcome.epoch,
				...clock,
			});
			if (outcome.status !== "acquired") return outcome;
			const current = control();
			const stop = current.stopAfterClaim;
			const used = stop === undefined ? "" : join(config.stateDir, `stop-${stop.token}.used`);
			if (stop !== undefined && stop.source === runId && !existsSync(used)) {
				writeFileSync(used, JSON.stringify({ holder: holderId, ...clock, pid: process.pid }));
				scope.log.write({ t: "stopping", id: scope.attemptId, source: runId, holder: holderId, token: stop.token });
				process.kill(process.pid, "SIGSTOP");
				scope.log.write({
					t: "continued",
					id: scope.attemptId,
					source: runId,
					holder: holderId,
					...(await storeClock(database, journal, runId)),
				});
			}
			if (Math.random() < current.killAfterClaimP) selfKill("after-claim", { source: runId, holder: holderId });
			return outcome;
		};
		const createRunWithEvents = journal.createRunWithEvents.bind(journal);
		journal.createRunWithEvents = async (header, events) => {
			const scope = attemptScope.getStore();
			if (scope === undefined) return createRunWithEvents(header, events);
			scope.log.write({ t: "copy-begin", id: scope.attemptId, forkRunId: header.runId, events: events.length });
			try {
				const result = await copyScope.run({ forkRunId: header.runId }, () => createRunWithEvents(header, events));
				scope.log.write({ t: "copy-end", id: scope.attemptId, forkRunId: header.runId, result });
				if (result === "created" && Math.random() < control().killAfterCommitP)
					selfKill("after-commit", { forkRunId: header.runId });
				return result;
			} catch (error) {
				scope.log.write({
					t: "copy-end",
					id: scope.attemptId,
					forkRunId: header.runId,
					error: describeError(error),
				});
				throw error;
			}
		};
		const release = journal.release.bind(journal);
		journal.release = async (lease) => {
			const scope = attemptScope.getStore();
			if (scope === undefined || !lease.holderId.startsWith("fork:")) return release(lease);
			try {
				await release(lease);
				scope.log.write({
					t: "release",
					id: scope.attemptId,
					source: lease.runId,
					holder: lease.holderId,
					ok: true,
				});
			} catch (error) {
				scope.log.write({
					t: "release",
					id: scope.attemptId,
					source: lease.runId,
					holder: lease.holderId,
					ok: false,
					error: describeError(error),
				});
				throw error;
			}
		};
	},
};

let storage: SharedStorage | undefined;
async function shared(): Promise<SharedStorage> {
	storage ??= await openSharedStorageWithRetry(config, hooks, (error, attempt) =>
		log.write({ t: "open-retry", attempt, error: describeError(error) }),
	);
	return storage;
}

function toolRuntime(database: SqliteDatabase) {
	return chaosWorkflows({
		toolMs: config.toolMs,
		beforeTool: (tool) => {
			if (attemptScope.getStore() !== undefined && Math.random() < control().killInToolP)
				selfKill("in-tool", { tool });
		},
		record: (ctxRunId, tool) => recordExecution(database, config.node, ctxRunId, tool),
	});
}

const pick = <T>(items: readonly T[], at: number): T => items[Math.floor(at * items.length) % items.length]!;

function backoffMs(tryNumber: number): number {
	return Math.min(8_000, 250 * 2 ** Math.min(tryNumber - 1, 6)) * (0.5 + Math.random());
}

const completedForks: string[] = [];

function planAttempt(current: Control): AttemptPlan {
	const roll = Math.random;
	const forkOfFork = completedForks.length > 0 && roll() < current.forkOfForkP;
	const sources = current.sources;
	const source = forkOfFork
		? pick(completedForks, roll())
		: current.hotSource !== undefined && roll() < current.hotP
			? current.hotSource
			: pick(sources, roll());
	const probes: readonly Probe[] = ["target-not-found", "definition-mismatch", "source-not-found", "invalid-option"];
	const probe = roll() < current.probeP ? pick(probes, roll()) : undefined;
	return {
		source,
		forkOfFork,
		...(probe === undefined ? {} : { probe }),
		wholeRun: roll() < current.wholeRunP,
		pick: roll(),
		...(roll() < current.inputsP ? { inputs: { objective: `alt-${randomUUID().slice(0, 8)}` } } : {}),
		carryMessages: roll() < current.carryAllP ? "all" : "before",
		...(roll() < current.otherCwdP ? { cwd: config.altCwd } : {}),
		...(roll() < current.abortP ? { abortAfterMs: Math.floor(roll() * 400) } : {}),
	};
}

async function collectPoints(source: string, backend: JournalDurableBackend): Promise<ForkPoint[]> {
	const points: ForkPoint[] = [];
	for await (const point of listForkPoints(source, { durableBackend: backend })) points.push(point);
	return points;
}

/**
 * Drives a fork's execution to completion: a fresh backend per try, so a lease another (possibly dead) process
 * holds is waited out, and a failed try never poisons the next.
 */
async function resumeUntilComplete(attemptId: string, forkRunId: string, why: string): Promise<boolean> {
	const scope = attemptScope.getStore()!;
	for (let resume = 1; resume <= 400; resume++) {
		const { database, journal } = await shared();
		let status: string | undefined;
		try {
			status = (await journal.getRun(forkRunId))?.status;
		} catch (error) {
			scope.log.write({ t: "resume-error", id: attemptId, forkRunId, resume, error: describeError(error) });
			await sleep(backoffMs(resume));
			continue;
		}
		if (status === "completed") {
			scope.log.write({ t: "exec", id: attemptId, forkRunId, status, resume, why, already: true });
			return true;
		}
		let backend: JournalDurableBackend | undefined;
		const started = performance.now();
		try {
			backend = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [forkRunId] });
			const handle = backend.getWorkflow(forkRunId);
			const { source } = toolRuntime(database);
			const result = await run(source, (handle?.inputs ?? {}) as WorkflowInputValues, {
				runId: forkRunId,
				durableBackend: backend,
				store: createStore(),
				adapters: echoAdapters,
				...(handle?.invocationCwd === undefined ? {} : { cwd: handle.invocationCwd }),
			});
			scope.log.write({
				t: "exec",
				id: attemptId,
				forkRunId,
				status: result.status,
				error: result.error?.slice(0, 200) ?? null,
				resume,
				why,
				ms: Math.round(performance.now() - started),
			});
			if (result.status === "completed") return true;
		} catch (error) {
			scope.log.write({ t: "resume-error", id: attemptId, forkRunId, resume, error: describeError(error) });
		} finally {
			await backend
				?.close()
				.catch((error: Error) => scope.log.write({ t: "close-error", error: describeError(error) }));
		}
		await sleep(Math.min(15_000, 1_000 * resume));
	}
	return false;
}

/** One logical fork attempt: retries retryable failures until the fork exists and its execution completed. */
async function driveAttempt(attemptId: string, plan: AttemptPlan, backend: JournalDurableBackend): Promise<void> {
	const scope = attemptScope.getStore()!;
	for (let tryNumber = 1; tryNumber <= 400; tryNumber++) {
		const { database, journal } = await shared();
		const { source: definition, other } = toolRuntime(database);
		scope.log.write({ t: "try", id: attemptId, n: tryNumber });
		const sourceId = plan.probe === "source-not-found" ? randomUUID() : plan.source;
		let fromStage: string | undefined;
		if (plan.probe === "target-not-found") fromStage = "no-such-stage";
		else if (!plan.wholeRun && plan.probe !== "source-not-found") {
			const listed = performance.now();
			try {
				const points = await collectPoints(sourceId, backend);
				fromStage = points.length === 0 ? undefined : pick(points, plan.pick).stagePath;
				scope.log.write({
					t: "points",
					id: attemptId,
					n: tryNumber,
					count: points.length,
					fromStage: fromStage ?? null,
					ms: Math.round(performance.now() - listed),
				});
			} catch (error) {
				const failure = describeError(error);
				scope.log.write({ t: "error", id: attemptId, n: tryNumber, phase: "listForkPoints", error: failure });
				await sleep(backoffMs(tryNumber));
				continue;
			}
		}
		const abort = plan.abortAfterMs === undefined ? undefined : new AbortController();
		const reason = new Error(`chaos abort of attempt ${attemptId}`);
		const timer = abort === undefined ? undefined : setTimeout(() => abort.abort(reason), plan.abortAfterMs);
		const started = performance.now();
		let forkRunId: string;
		try {
			const forked = await forkRun(sourceId, {
				...(fromStage === undefined ? {} : { fromStage }),
				...(plan.inputs === undefined ? {} : { inputs: plan.inputs }),
				...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
				carryMessages: plan.probe === "invalid-option" ? ("sideways" as "all") : plan.carryMessages,
				definition: plan.probe === "definition-mismatch" ? (other as unknown as typeof definition) : definition,
				durableBackend: backend,
				store: createStore(),
				adapters: echoAdapters,
				...(abort === undefined ? {} : { signal: abort.signal }),
			}).finally(() => clearTimeout(timer));
			forkRunId = forked.runId;
			scope.log.write({
				t: "forked",
				id: attemptId,
				n: tryNumber,
				forkRunId,
				forkedFrom: { runId: forked.forkedFrom.runId, stagePath: forked.forkedFrom.stagePath ?? null },
				latencyMs: Math.round(performance.now() - started),
				aborted: abort?.signal.aborted ?? false,
			});
			if (plan.probe !== undefined)
				scope.log.write({ t: "probe-unexpected-success", id: attemptId, probe: plan.probe });
			let status: string;
			try {
				const result = await forked.result;
				status = result.status;
				scope.log.write({
					t: "exec",
					id: attemptId,
					forkRunId,
					status,
					error: result.error?.slice(0, 200) ?? null,
					resume: 0,
					ms: Math.round(performance.now() - started),
				});
			} catch (error) {
				status = "rejected";
				scope.log.write({ t: "exec", id: attemptId, forkRunId, status, error: describeError(error), resume: 0 });
			}
			const done = status === "completed" || (await resumeUntilComplete(attemptId, forkRunId, `initial-${status}`));
			if (done) completedForks.push(forkRunId);
			scope.log.write({ t: done ? "done" : "gave-up", id: attemptId, forkRunId });
			return;
		} catch (error) {
			const latencyMs = Math.round(performance.now() - started);
			if (abort?.signal.aborted === true && error === reason) {
				scope.log.write({ t: "aborted", id: attemptId, n: tryNumber, latencyMs });
				return;
			}
			const failure: ErrorRecord = describeError(error);
			scope.log.write({ t: "error", id: attemptId, n: tryNumber, phase: "forkRun", error: failure, latencyMs });
			if (plan.probe !== undefined && failure.fork && failure.code === PROBE_CODES[plan.probe]) {
				scope.log.write({ t: "probe-ok", id: attemptId, probe: plan.probe, code: failure.code });
				return;
			}
			// A typed failure that names a fork run may have written it: copy-failed must not have (the checker flags
			// it if it did); journal-unavailable in phase "hydrate" did. Either way, never fork that attempt twice.
			if (
				failure.forkRunId !== undefined &&
				(failure.code === "copy-failed" || failure.code === "journal-unavailable")
			) {
				const created = await runExists(journal, failure.forkRunId);
				if (created) {
					scope.log.write({
						t: failure.code === "copy-failed" ? "copy-failed-but-created" : "created-despite-error",
						id: attemptId,
						forkRunId: failure.forkRunId,
						code: failure.code,
						phase: failure.copyPhase ?? null,
					});
					const done = await resumeUntilComplete(attemptId, failure.forkRunId, `adopted-after-${failure.code}`);
					scope.log.write({ t: done ? "done" : "gave-up", id: attemptId, forkRunId: failure.forkRunId });
					return;
				}
			}
			if (isForkError(error) && failure.retryable !== true) {
				scope.log.write({ t: "failed-nonretryable", id: attemptId, code: failure.code ?? null });
				return;
			}
			await sleep(backoffMs(tryNumber));
		}
	}
	scope.log.write({ t: "gave-up", id: attemptId });
}

/** Whether a run exists, asking until the journal answers. */
async function runExists(journal: RunJournal, runId: string): Promise<boolean> {
	for (let tryNumber = 1; ; tryNumber++) {
		try {
			return (await journal.getRun(runId)) !== undefined;
		} catch (error) {
			attemptScope.getStore()?.log.write({ t: "exists-retry", runId, error: describeError(error) });
			await sleep(backoffMs(tryNumber));
		}
	}
}

interface AttemptState {
	intent?: { readonly plan: AttemptPlan };
	terminal: boolean;
	readonly forkRunIds: Set<string>;
}

/** Folds every attempt log this node wrote, by attempt id. */
function attemptStates(): Map<string, AttemptState> {
	const states = new Map<string, AttemptState>();
	for (const file of readdirSync(config.stateDir)) {
		if (!/^(attempts|stopper|resume)-/.test(file) || !file.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(config.stateDir, file), "utf8").split("\n")) {
			if (line.length === 0) continue;
			let record: { t?: string; id?: string; plan?: AttemptPlan; forkRunId?: string };
			try {
				record = JSON.parse(line) as typeof record;
			} catch {
				continue;
			}
			if (typeof record.id !== "string") continue;
			let state = states.get(record.id);
			if (state === undefined) {
				state = { terminal: false, forkRunIds: new Set() };
				states.set(record.id, state);
			}
			if (record.t === "intent" && record.plan !== undefined) state.intent = { plan: record.plan };
			if (record.t === "copy-begin" && typeof record.forkRunId === "string") state.forkRunIds.add(record.forkRunId);
			if (
				["done", "aborted", "probe-ok", "failed-nonretryable", "gave-up", "probe-unexpected-success"].includes(
					record.t ?? "",
				)
			)
				state.terminal = true;
		}
	}
	return states;
}

/**
 * Recovery with no manual steps: every attempt a killed process left unfinished is driven again. A fork whose copy
 * transaction committed before the kill is adopted and its execution resumed, never forked a second time.
 */
async function redrive(backend: JournalDurableBackend): Promise<number> {
	const incomplete = [...attemptStates()].filter(([, state]) => !state.terminal && state.intent !== undefined);
	await Promise.all(
		incomplete.map(([attemptId, state]) =>
			attemptScope.run({ attemptId, log }, async () => {
				log.write({ t: "redrive", id: attemptId, copies: [...state.forkRunIds] });
				const { journal } = await shared();
				const existing: string[] = [];
				for (const forkRunId of state.forkRunIds) {
					for (let tryNumber = 1; ; tryNumber++) {
						try {
							if ((await journal.getRun(forkRunId)) !== undefined) existing.push(forkRunId);
							break;
						} catch (error) {
							log.write({ t: "redrive-error", id: attemptId, error: describeError(error) });
							await sleep(backoffMs(tryNumber));
						}
					}
				}
				if (existing.length > 1) log.write({ t: "multiple-created", id: attemptId, forkRunIds: existing });
				if (existing.length > 0) {
					let done = true;
					for (const forkRunId of existing) {
						log.write({ t: "adopted", id: attemptId, forkRunId });
						done = (await resumeUntilComplete(attemptId, forkRunId, "adopted-after-kill")) && done;
					}
					log.write({ t: done ? "done" : "gave-up", id: attemptId, forkRunId: existing[0]! });
					return;
				}
				await driveAttempt(attemptId, state.intent!.plan, backend);
			}),
		),
	);
	return incomplete.length;
}

async function forker(): Promise<void> {
	const { journal } = await shared();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [] });
	log.write({ t: "start", mode: mode ?? null, node: config.node });
	const redriving = (mode === "stopper" ? Promise.resolve(0) : redrive(backend)).then((count) => {
		log.write({ t: "redrive-complete", count });
	});
	let started = 0;
	const worker = async (index: number) => {
		for (;;) {
			const current = control();
			if (current.drain || current.sources.length === 0) return;
			if (current.maxAttempts !== undefined && started >= current.maxAttempts) return;
			if (index >= current.concurrency) {
				await sleep(1_000);
				continue;
			}
			started++;
			const attemptId = randomUUID();
			const plan = planAttempt(current);
			await attemptScope.run({ attemptId, log }, async () => {
				log.write({ t: "intent", id: attemptId, node: config.node, plan: plan as unknown as Json });
				await driveAttempt(attemptId, plan, backend);
			});
		}
	};
	await Promise.all([redriving, ...Array.from({ length: 8 }, (_, index) => worker(index))]);
	await backend.close();
	log.write({ t: "drained", started });
}

async function seed(count: number): Promise<void> {
	const { database, journal } = await shared();
	await ensureLedger(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [] });
	const { source } = toolRuntime(database);
	const sources: { runId: string; objective: string; status: string; ms: number }[] = [];
	for (let index = 0; index < count; index++) {
		const objective = `src-${index}`;
		const runId = randomUUID();
		const started = performance.now();
		const result = await attemptScope.run({ attemptId: `seed-${index}`, log }, () =>
			run(
				source,
				{ objective },
				{ runId, durableBackend: backend, store: createStore(), adapters: echoAdapters, cwd: repoRoot },
			),
		);
		sources.push({ runId, objective, status: result.status, ms: Math.round(performance.now() - started) });
		log.write({ t: "seeded", runId, objective, status: result.status, error: result.error ?? null });
	}
	await backend.close();
	writeFileSync(join(config.stateDir, "sources.json"), JSON.stringify(sources, null, 2));
	console.log(JSON.stringify({ sources }));
}

/** Global sweep: drives every fork run in the shared journal that has not completed. */
async function sweep(sources: ReadonlySet<string>): Promise<void> {
	const { journal } = await shared();
	const pending = (await journal.listRuns()).filter(
		(summary) => !sources.has(summary.runId) && summary.status !== "completed",
	);
	log.write({ t: "sweep", pending: pending.map((summary) => `${summary.runId}:${summary.status}`) });
	for (const summary of pending)
		await attemptScope.run({ attemptId: `sweep-${summary.runId}`, log }, () =>
			resumeUntilComplete(`sweep-${summary.runId}`, summary.runId, "global-sweep"),
		);
	console.log(JSON.stringify({ swept: pending.length }));
}

/** Node-local SQLite: a local journal forks its own runs, and reports a shared run as not found with a join hint. */
async function local(sharedSourceId: string, mount: string): Promise<void> {
	const report: { [key: string]: Json } = { node: config.node, mount };
	const path = join(mount, "journal.sqlite");
	rmSync(path, { force: true });
	rmSync(`${path}-wal`, { force: true });
	rmSync(`${path}-shm`, { force: true });
	const journal = await openSqlRunJournal(path);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [] });
	const executions = new Map<string, number>();
	const { source } = chaosWorkflows({
		toolMs: 5,
		beforeTool: () => undefined,
		record: async (ctxRunId, tool) => {
			executions.set(`${ctxRunId}:${tool}`, (executions.get(`${ctxRunId}:${tool}`) ?? 0) + 1);
		},
	});
	const options = { durableBackend: backend, store: createStore(), adapters: echoAdapters };
	const seeded = await run(source, { objective: "local" }, { ...options, cwd: repoRoot });
	report.localSource = { runId: seeded.runId, status: seeded.status };
	const points: string[] = [];
	for await (const point of listForkPoints(seeded.runId, { durableBackend: backend })) points.push(point.stagePath);
	report.localForkPoints = points;
	const before = new Map(executions);
	const forked = await forkRun(seeded.runId, {
		fromStage: "child.c2",
		inputs: { objective: "local-fork" },
		definition: source,
		...options,
	});
	const result = await forked.result;
	const executedInFork = [...executions]
		.filter(([key, value]) => value !== (before.get(key) ?? 0))
		.map(([key]) => key);
	report.localFork = {
		runId: forked.runId,
		forkedFrom: { runId: forked.forkedFrom.runId, stagePath: forked.forkedFrom.stagePath ?? null },
		status: result.status,
		toolsExecutedInFork: executedInFork.map((key) => key.split(":").at(-1)!).sort(),
		journalAdapter: journal.descriptor.adapter,
	};
	const notFound = await forkRun(sharedSourceId, { definition: source, ...options }).then(
		() => undefined,
		(error: Error) => describeError(error),
	);
	report.sharedRunViaLocalJournal = notFound ?? "unexpected success";
	const pointsNotFound = await (async () => {
		try {
			for await (const _ of listForkPoints(sharedSourceId, { durableBackend: backend })) return "unexpected point";
			return "no error";
		} catch (error) {
			return describeError(error);
		}
	})();
	report.sharedRunPointsViaLocalJournal = pointsNotFound;
	// Disk full on the node-local journal: truncate the WAL so the next write must grow a file, fill the mount.
	const raw = new DatabaseSync(path);
	raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	raw.close();
	const filler = join(mount, "filler.bin");
	const stats = statfsSync(mount);
	const free = Number(stats.bavail) * Number(stats.bsize);
	const fill = Bun.spawnSync(["fallocate", "-l", String(free), filler]);
	const fillRoot = Bun.spawnSync(["dd", "if=/dev/zero", `of=${filler}.tail`, "bs=4096", "status=none"]);
	report.diskFull = {
		freeBeforeFill: free,
		fallocateExit: fill.exitCode,
		ddExit: fillRoot.exitCode,
		freeAfterFill: Number(statfsSync(mount).bavail) * Number(statfsSync(mount).bsize),
	};
	const runsBefore = (await journal.listRuns()).length;
	const full = await forkRun(seeded.runId, { fromStage: "s3", definition: source, ...options }).then(
		async (fork) => ({ forked: fork.runId, status: (await fork.result).status }),
		(error: Error) => describeError(error),
	);
	rmSync(filler, { force: true });
	rmSync(`${filler}.tail`, { force: true });
	const runsAfterFull = (await journal.listRuns()).length;
	const healed = await forkRun(seeded.runId, { fromStage: "s3", definition: source, ...options }).then(
		async (fork) => ({ forked: fork.runId, status: (await fork.result).status }),
		(error: Error) => describeError(error),
	);
	report.diskFullFork = full;
	report.runsBeforeDiskFull = runsBefore;
	report.runsAfterDiskFullAttempt = runsAfterFull;
	report.afterFreeingDisk = healed;
	const runs = await journal.listRuns();
	const partial: string[] = [];
	for (const summary of runs) {
		const events: string[] = [];
		for await (const entry of journal.read(summary.runId)) events.push(entry.event.type);
		if (events[0] !== "RunStarted" || !events.includes("StatusChanged")) partial.push(summary.runId);
	}
	report.localRuns = runs.length;
	report.localPartialRuns = partial;
	await backend.close();
	await journal.close();
	console.log(JSON.stringify(report));
}

/** Security verification through the real client stack: token required, TLS verified. */
async function tlscheck(): Promise<void> {
	const report: { [key: string]: Json } = { node: config.node, url: config.url };
	try {
		const { database } = await openSharedStorage(config);
		const row = await database.get<{ one: number }>("SELECT 1 AS one");
		report.withTokenAndCa = row?.one === 1 ? "ok" : "unexpected";
		await database.close();
	} catch (error) {
		report.withTokenAndCa = describeError(error);
	}
	const probe = async (url: string, label: string) => {
		try {
			const database = await openLibsqlDatabase({ url });
			await database.get("SELECT 1 AS one");
			report[label] = "ACCEPTED";
			await database.close();
		} catch (error) {
			const failure = describeError(error);
			report[label] = {
				rejected: true,
				name: failure.name,
				causeName: failure.causeName ?? null,
				message: failure.message,
			};
		}
	};
	await probe(config.url, "withoutToken");
	await probe(config.url.replace(/^https:/, "http:"), "plainHttpWithoutTls");
	console.log(JSON.stringify(report));
}

switch (mode) {
	case "seed":
		await seed(Number(process.argv[3] ?? "6"));
		break;
	case "forker":
	case "stopper":
		await forker();
		break;
	case "resume": {
		const { journal } = await shared();
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [] });
		const count = await redrive(backend);
		log.write({ t: "redrive-complete", count });
		await backend.close();
		if (process.argv[3] === "--global") {
			const sources = JSON.parse(readFileSync(join(config.stateDir, "sources.json"), "utf8")) as { runId: string }[];
			await sweep(new Set(sources.map((source) => source.runId)));
		}
		console.log(JSON.stringify({ redriven: count }));
		break;
	}
	case "local":
		mkdirSync(process.argv[4] ?? "", { recursive: true });
		await local(process.argv[3] ?? "", process.argv[4] ?? "");
		break;
	case "tlscheck":
		await tlscheck();
		break;
	default:
		throw new Error(`unknown mode ${mode}`);
}
process.exit(0);
