/**
 * What the PostgreSQL worker-pool benchmark's root and hosts share (#5102): the connection, the work they queue, and
 * the summary of a list of latencies.
 */
import { readFileSync } from "node:fs";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { openPostgresDatabase } from "../../../packages/storage-postgres/postgres.js";
import type { PoolWorkDescriptor } from "../../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "../../../packages/workflows/src/durable/types.js";

export const ROOT = "root";
export const DEFINITION = { definition: "bench/child", digest: "sha256:bench" } as const;

/** The server, as `--url` and `--password-file` (or `PGPASSWORD`) name it. */
export interface Connection {
	readonly url: string;
	readonly password: string;
}

export function openDatabase(connection: Connection, maxConnections: number): Promise<SqliteDatabase> {
	return openPostgresDatabase({ url: connection.url, password: connection.password, maxConnections });
}

export function readPassword(file: string | undefined): string {
	if (file !== undefined) return readFileSync(file, "utf8").trim();
	const password = process.env.PGPASSWORD;
	if (password === undefined || password === "") throw new Error("Pass --password-file or set PGPASSWORD");
	return password;
}

/** The `index`th child the root queues: its descriptor and the boundary checkpoint that starts it. */
export function child(index: number): { readonly work: PoolWorkDescriptor; readonly boundary: DurableStageCheckpoint } {
	const boundaryId = `boundary-${index}`;
	const work: PoolWorkDescriptor = {
		boundaryId,
		childRunId: `child-${index}`,
		scope: `workflow:${boundaryId}:0`,
		definition: DEFINITION.definition,
		digest: DEFINITION.digest,
		inputs: { index },
		execution: {},
	};
	const boundary: DurableStageCheckpoint = {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `boundary-start:${work.scope}`,
		name: "child",
		replayKey: work.scope,
		startedAt: 0,
		completedAt: 0,
		topology: {
			version: 1,
			stageId: boundaryId,
			parentIds: [],
			sourceOrder: index,
			status: "running",
			run: { runId: ROOT, runName: ROOT },
			boundary: {
				version: 1,
				event: "start",
				status: "running",
				replayScope: work.scope,
				alias: "child",
				workflow: "child",
				invocationFingerprint: "fingerprint",
				child: {
					runId: work.childRunId,
					runName: "child",
					parentRunId: ROOT,
					parentStageId: boundaryId,
					rootRunId: ROOT,
				},
			},
		},
	};
	return { work, boundary };
}

/** The `step`th tool checkpoint a child records, carrying `payload` characters of output. */
export function toolCheckpoint(work: PoolWorkDescriptor, step: number, payload: number): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: `${work.scope}:tool:${step}`,
		name: "tool",
		argsHash: `${work.scope}:args:${step}`,
		output: { text: "x".repeat(payload) },
		completedAt: Date.now(),
		topology: {
			version: 1,
			nodeId: `tool-${step}`,
			parentIds: [],
			ordinal: step,
			order: step,
			run: {
				runId: work.childRunId,
				runName: "child",
				parentRunId: ROOT,
				parentStageId: work.boundaryId,
				rootRunId: ROOT,
			},
		},
	};
}

export interface LatencySummary {
	readonly count: number;
	readonly p50: number;
	readonly p99: number;
	readonly max: number;
}

export function summarize(values: readonly number[]): LatencySummary {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (quantile: number) =>
		sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]!;
	const round = (value: number) => Math.round(value * 10) / 10;
	return { count: sorted.length, p50: round(at(0.5)), p99: round(at(0.99)), max: round(sorted.at(-1) ?? 0) };
}
