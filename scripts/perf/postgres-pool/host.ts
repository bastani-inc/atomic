#!/usr/bin/env bun
/**
 * One worker host of the PostgreSQL worker-pool benchmark (#5102): its own process and connections, `slots` workers
 * that each claim a child, commit its checkpoints with a heartbeat running, and complete it, until nothing is ready.
 * Reads its settings from `BENCH_HOST` (JSON), prints `ready`, waits for a line on stdin, and prints its measurements
 * as one JSON line when every worker is done.
 */
import { createInterface } from "node:readline";
import { sqlPoolStorage } from "../../../packages/workflows/src/durable/journal/internal.js";
import { openSqlPoolQueue, type PoolWork } from "../../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../../packages/workflows/src/durable/journal/types.js";
import { type Connection, DEFINITION, openDatabase, toolCheckpoint } from "./shared.js";

interface HostSettings {
	readonly connection: Connection;
	readonly prefix: string;
	readonly lease: Lease;
	readonly host: number;
	readonly slots: number;
	readonly steps: number;
	readonly payload: number;
	readonly leaseMs: number;
	readonly heartbeatMs: number;
}

const settings = JSON.parse(process.env.BENCH_HOST ?? "") as HostSettings;
const { lease, slots, steps, payload, leaseMs, heartbeatMs } = settings;
const database = await openDatabase(settings.connection, slots + 2);
const journal = await SqlRunJournal.open(database, { prefix: settings.prefix });
const queue = await openSqlPoolQueue(journal);
const usage = await openSqlPoolUsage(journal);
if (sqlPoolStorage(journal) === undefined) throw new Error("The benchmark needs a SQL journal");

const claims: number[] = [];
const emptyClaims: number[] = [];
const commits: number[] = [];
const completes: number[] = [];
const heartbeats: number[] = [];
const commitTimes: number[] = [];
const errors: Record<string, number> = {};
const claimed: { id: string; generation: number }[] = [];

function failed(stage: string, error: unknown): void {
	// By kind, not by message: a message names the work item.
	const { name, reason, code } = error as Error & { reason?: string; code?: string };
	const kind = `${stage}: ${name}${reason === undefined ? "" : ` (${reason})`}${code === undefined ? "" : ` [${code}]`}`;
	errors[kind] = (errors[kind] ?? 0) + 1;
}

async function timed<T>(into: number[], action: () => Promise<T>): Promise<T> {
	const started = performance.now();
	const result = await action();
	into.push(performance.now() - started);
	return result;
}

async function runChild(work: PoolWork, worker: string): Promise<void> {
	const token = { id: work.id, generation: work.generation, worker, epoch: work.epoch };
	let beating = Promise.resolve();
	const timer = setInterval(() => {
		beating = beating.then(() =>
			timed(heartbeats, () =>
				queue.heartbeat(
					lease,
					token,
					leaseMs,
					usage.recording(lease, token, [
						{ key: `bench:${work.id}`, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 } },
					]),
				),
			).then(
				() => {},
				(error) => failed("heartbeat", error),
			),
		);
	}, heartbeatMs);
	try {
		for (let step = 0; step < steps; step++) {
			const checkpoint = toolCheckpoint(work, step, payload);
			await timed(commits, () => queue.commit(lease, token, `step-${step}`, { kind: "checkpoint", checkpoint }));
			commitTimes.push(Date.now());
		}
		await timed(completes, () => queue.complete(lease, token, { runId: work.childRunId, status: "completed" }));
	} finally {
		clearInterval(timer);
		await beating;
	}
}

async function worker(slot: number): Promise<void> {
	const id = `host-${settings.host}-worker-${slot}`;
	for (;;) {
		let work: PoolWork | undefined;
		const started = performance.now();
		try {
			work = await queue.claim(lease, id, [DEFINITION], leaseMs);
		} catch (error) {
			failed("claim", error);
			continue;
		}
		const elapsed = performance.now() - started;
		if (work === undefined) {
			emptyClaims.push(elapsed);
			// Every child is queued before the hosts start, and none expires, so nothing ready means nothing left.
			if ((await queue.readyCandidates(lease, [DEFINITION], 1)).length === 0) return;
			continue;
		}
		claims.push(elapsed);
		claimed.push({ id: work.id, generation: work.generation });
		try {
			await runChild(work, id);
		} catch (error) {
			failed("child", error);
		}
	}
}

process.stdout.write("ready\n");
const input = createInterface({ input: process.stdin });
await new Promise<void>((resolve) => input.once("line", () => resolve()));
input.close();
await Promise.all(Array.from({ length: slots }, (_, slot) => worker(slot)));
await journal.close();
await database.close();
process.stdout.write(
	`${JSON.stringify({ host: settings.host, claims, emptyClaims, commits, completes, heartbeats, commitTimes, errors, claimed })}\n`,
);
