/**
 * Shared pieces of the distributed fork chaos scenario (#4321): node configuration, the shared libSQL journal, the
 * deterministic workflow under test, the work ledger and the per-process attempt log.
 *
 * The sqld token is resolved only through Atomic's storage secrets (`{ file }`) and is never logged.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir } from "../../../packages/coding-agent/src/config.js";
import { resolveAdapterOptions, type SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../../packages/storage-libsql/libsql.js";
import { workflow } from "../../../packages/workflows/src/authoring/workflow.js";
import { isForkError } from "../../../packages/workflows/src/durable/fork-errors.js";
import { SqlRunJournal } from "../../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { WorkflowToolPrimitive } from "../../../packages/workflows/src/shared/types.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** One test VM's settings, written by the controller to the file `FC_CONFIG` names. */
export interface NodeConfig {
	readonly node: string;
	readonly region: string;
	/** `https://<sqld private ip>:8443`; the TLS proxy in front of sqld. */
	readonly url: string;
	/** Mode-600 file holding the per-run JWT. */
	readonly tokenFile: string;
	readonly stateDir: string;
	/** A directory that exists on every node, used as a fork destination `cwd`. */
	readonly altCwd: string;
	/** How long each `ctx.tool` callback works, so kills land mid-execution. */
	readonly toolMs: number;
}

export function loadConfig(): NodeConfig {
	const path = process.env.FC_CONFIG;
	if (path === undefined || path.length === 0) throw new Error("FC_CONFIG must name the node config file");
	return JSON.parse(readFileSync(path, "utf8")) as NodeConfig;
}

export type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The current time on the journal's clock, the clock leases are measured on. */
export const STORE_NOW_SQL = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** Append-only JSONL log, fsynced per line so a SIGKILL never loses a recorded step. */
export class JsonlLog {
	private readonly fd: number;
	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.fd = openSync(path, "a");
	}
	write(record: { readonly [key: string]: Json }): void {
		writeSync(this.fd, `${JSON.stringify({ ...record, pid: process.pid, localNow: Date.now() })}\n`);
		fsyncSync(this.fd);
	}
}

export interface AttemptScope {
	readonly attemptId: string;
	readonly log: JsonlLog;
}
/** The fork attempt the current async context works for; tool callbacks and journal hooks read it. */
export const attemptScope = new AsyncLocalStorage<AttemptScope>();

export interface SharedStorage {
	readonly database: SqliteDatabase;
	readonly journal: SqlRunJournal;
}

export interface StorageHooks {
	database?(database: SqliteDatabase): void;
	journal?(journal: SqlRunJournal, database: SqliteDatabase): void;
}

/**
 * Opens the shared journal on sqld. The token goes through Atomic's storage secrets resolution (`{ file }`), the
 * same path a settings selection with `secrets.authToken.file` takes.
 */
export async function openSharedStorage(config: NodeConfig, hooks: StorageHooks = {}): Promise<SharedStorage> {
	const options = await resolveAdapterOptions(
		{
			kind: "adapter",
			module: join(repoRoot, "packages/storage-libsql/libsql.js"),
			options: { url: config.url },
			secrets: { authToken: { file: config.tokenFile } },
		},
		{ agentDir: getAgentDir(), domain: "journal" },
	);
	const database = await openLibsqlDatabase({ url: String(options.url), authToken: String(options.authToken) });
	try {
		hooks.database?.(database);
		const journal = await SqlRunJournal.open(database);
		hooks.journal?.(journal, database);
		return { database, journal };
	} catch (error) {
		await database.close().catch(() => undefined);
		throw error;
	}
}

/** Opens the shared journal, retrying while the network or sqld is faulted. */
export async function openSharedStorageWithRetry(
	config: NodeConfig,
	hooks: StorageHooks = {},
	onFailure: (error: unknown, attempt: number) => void = () => undefined,
): Promise<SharedStorage> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await openSharedStorage(config, hooks);
		} catch (error) {
			onFailure(error, attempt);
			await sleep(Math.min(10_000, 500 * attempt));
		}
	}
}

export const LEDGER_TABLE = "chaos_ledger";

export async function ensureLedger(database: SqliteDatabase): Promise<void> {
	await database.exec(
		`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}(execution_id TEXT PRIMARY KEY, ctx_run_id TEXT NOT NULL, tool TEXT NOT NULL, node TEXT NOT NULL, pid INTEGER NOT NULL, attempt_id TEXT, at INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS ${LEDGER_TABLE}_run ON ${LEDGER_TABLE}(ctx_run_id)`,
	);
}

/**
 * Records one execution of a tool callback. The execution id is fixed before the first try, so a retried insert
 * whose first response was lost does not count twice: two rows always mean two callback executions.
 */
export async function recordExecution(
	database: SqliteDatabase,
	node: string,
	ctxRunId: string,
	tool: string,
): Promise<void> {
	const executionId = randomUUID();
	const attempt = attemptScope.getStore()?.attemptId ?? null;
	for (let tryNumber = 1; ; tryNumber++) {
		try {
			await database.run(
				`INSERT INTO ${LEDGER_TABLE} VALUES (?, ?, ?, ?, ?, ?, ${STORE_NOW_SQL}) ON CONFLICT(execution_id) DO NOTHING`,
				executionId,
				ctxRunId,
				tool,
				node,
				process.pid,
				attempt,
			);
			return;
		} catch (error) {
			if (tryNumber >= 400) throw error;
			await sleep(Math.min(5_000, 100 * tryNumber));
		}
	}
}

export const NAMED_TOOLS = ["t1", "t2", "ct1", "ct2", "t3", "t4"] as const;
export const NAMED_STAGES = ["s1", "s2", "c1", "c2", "c3", "child", "s3", "s4"] as const;
export const SOURCE_WORKFLOW = "fc-source";

export interface ToolRuntime {
	/** Called at the start of every tool callback; the chaos hooks may kill the process here. */
	readonly beforeTool: (tool: string) => Promise<void> | void;
	readonly record: (ctxRunId: string, tool: string) => Promise<void>;
	readonly toolMs: number;
}

/**
 * The deterministic workflow under test: six `ctx.tool` steps and seven stages, three of them inside a nested
 * child workflow, so fork points such as `child.c2` exist. Every tool output names the run that executed it, so a
 * checkpoint copied from the wrong run is detectable.
 */
export function chaosWorkflows(runtime: ToolRuntime) {
	const step = (
		ctx: { readonly runId?: string; readonly tool: WorkflowToolPrimitive },
		tool: string,
		objective: string,
	): Promise<string> =>
		ctx.tool(tool, { step: tool }, async () => {
			const runId = ctx.runId ?? "unknown-run";
			await runtime.beforeTool(tool);
			await runtime.record(runId, tool);
			await sleep(runtime.toolMs);
			return `${tool}:${runId}:${objective}`;
		});
	const child = workflow({
		name: "fc-child",
		description: "Nested child of the fork chaos source workflow",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const first = await step(ctx, "ct1", "-");
			await ctx.stage("c1").complete(`c1|${first}`);
			const second = await step(ctx, "ct2", "-");
			await ctx.stage("c2").complete(`c2|${second}`);
			await ctx.stage("c3").complete("c3");
			return {};
		},
	});
	const source = workflow({
		name: SOURCE_WORKFLOW,
		description: "Fork chaos source workflow",
		inputs: { objective: Type.String({ default: "base" }) },
		outputs: { summary: Type.String() },
		run: async (ctx) => {
			const objective = ctx.inputs.objective;
			const t1 = await step(ctx, "t1", objective);
			await ctx.stage("s1").complete(`s1|${t1}`);
			const t2 = await step(ctx, "t2", objective);
			await ctx.stage("s2").complete(`s2|${t2}`);
			await ctx.workflow(child, { stageName: "child" });
			const t3 = await step(ctx, "t3", objective);
			await ctx.stage("s3").complete(`s3|${t3}`);
			const t4 = await step(ctx, "t4", objective);
			const s4 = await ctx.stage("s4").complete(`s4|${t4}`);
			return { summary: String(s4) };
		},
	});
	/** A definition with another name, for the definition-mismatch probe. */
	const other = workflow({
		name: "fc-other",
		description: "Not the source workflow",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	return { source, child, other };
}

/** Stage adapters: `complete` echoes its text, so no model is called. */
export const echoAdapters = { complete: { complete: async (text: string) => text } };

/** What an observed failure was, without its message text beyond a short head (no secret ever reaches it). */
export interface ErrorRecord {
	readonly [key: string]: Json;
	readonly fork: boolean;
	readonly name: string;
	readonly code?: string;
	readonly reason?: string;
	readonly retryable?: boolean;
	readonly forkRunId?: string;
	readonly copyPhase?: string;
	readonly holderId?: string;
	readonly storageScope?: string;
	readonly storageAdapter?: string;
	readonly hintJoin?: boolean;
	readonly causeName?: string;
	readonly cleanupCauseName?: string;
	readonly message: string;
}

interface ErrorShape {
	readonly name?: unknown;
	readonly code?: unknown;
	readonly reason?: unknown;
	readonly retryable?: unknown;
	readonly forkRunId?: unknown;
	readonly phase?: unknown;
	readonly holderId?: unknown;
	readonly hint?: unknown;
	readonly storage?: { readonly scope?: unknown; readonly adapter?: unknown };
	readonly cause?: { readonly name?: unknown };
	readonly cleanupCause?: { readonly name?: unknown };
	readonly message?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function describeError(error: unknown): ErrorRecord {
	const shape = (typeof error === "object" && error !== null ? error : {}) as ErrorShape;
	const hint = text(shape.hint);
	return {
		fork: isForkError(error),
		name: text(shape.name) ?? typeof error,
		code: text(shape.code),
		reason: text(shape.reason),
		retryable: typeof shape.retryable === "boolean" ? shape.retryable : undefined,
		forkRunId: text(shape.forkRunId),
		copyPhase: text(shape.phase),
		holderId: text(shape.holderId),
		storageScope: text(shape.storage?.scope),
		storageAdapter: text(shape.storage?.adapter),
		hintJoin: hint === undefined ? undefined : hint.includes("atomic team join"),
		causeName: text(shape.cause?.name),
		cleanupCauseName: text(shape.cleanupCause?.name),
		message: (text(shape.message) ?? String(error)).slice(0, 200),
	};
}
