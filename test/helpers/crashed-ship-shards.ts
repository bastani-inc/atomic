import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase, SqliteRow } from "@bastani/atomic/storage";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { type RunJournalOption, resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	durableJournalIdentity,
	poolDurableJournal,
	poolStateDirectory,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import type { SharedJournalSelection } from "../../packages/workflows/src/workers/worker-host-types.js";
import { openCoordinator } from "./pool-coordinator.js";
import { decodeStream, readStreamText, type SpawnedProcess, sleep, spawnProcess } from "./runtime.js";

const crashFixture = fileURLToPath(new URL("../fixtures/ship-shard-crash.mjs", import.meta.url));

const CRASH_SHIPPING = { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } as const;
const LATE_OPEN_GRACE_MS = 50;

export const shardRemovals = {
	before: undefined as undefined | { readonly prefix: string; readonly run: () => Promise<void> },
};

export interface CrashedShard {
	readonly path: string;
	readonly root: string;
	readonly work?: string;
	readonly readOnly?: boolean;
	readonly uri?: boolean;
}

export interface ShardHolder {
	readonly process: SpawnedProcess;
	kill(): Promise<void>;
}

export async function holdShards(shards: readonly CrashedShard[]): Promise<ShardHolder> {
	const child = spawnProcess([process.execPath, crashFixture, JSON.stringify(shards)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = readStreamText(child.stderr);
	const reader = decodeStream(child.stdout!).getReader();
	let buffer = "";
	while (!buffer.includes("\n")) {
		const chunk = await reader.read();
		if (chunk.done) assert.fail(`the shard holder exited before it opened its journals: ${await stderr}`);
		buffer += chunk.value;
	}
	reader.releaseLock();
	assert.equal(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).opened, shards.length);
	return {
		process: child,
		async kill() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await child.exited;
		},
	};
}

export function shardFiles(path: string): string[] {
	if (!existsSync(dirname(path))) return [];
	return readdirSync(dirname(path)).filter((name) => name.startsWith(basename(path)));
}

export async function unshippedCheckpoints(path: string): Promise<number> {
	const database = await openNodeSqliteDatabase(path, { readOnly: true });
	try {
		const row = await database.get<SqliteRow & { n: number }>(`SELECT COUNT(*) AS n FROM ship_events`);
		return Number(row?.n ?? 0);
	} finally {
		await database.close();
	}
}

export async function setRunStatus(journal: RunJournal, root: string, status: string): Promise<void> {
	const storage = sqlPoolStorage(journal)!;
	await storage.transaction((tx) =>
		tx.run(`UPDATE ${storage.tables.runs} SET status = ? WHERE run_id = ?`, status, root),
	);
}

const ENDED_WHILE_DOWN = ["completed", "failed", "deleted"] as const;
const LIVE_WHILE_DOWN = ["running", "paused"] as const;
const IN_USE = [
	"held",
	"connected",
	"retiredReader",
	"retiredWriter",
	"legacyReader",
	"legacyWriter",
	"legacyProcessReader",
	"uriUnreadReader",
	"uriSelectedReader",
	"uriWriter",
	"uriProcessReader",
	"rawUnreadReader",
	"rawRollbackReader",
	"rawRollbackWriter",
] as const;
type ShardCase =
	| (typeof ENDED_WHILE_DOWN)[number]
	| (typeof LIVE_WHILE_DOWN)[number]
	| (typeof IN_USE)[number]
	| "lateOpened";

async function retireWithUnshippedCheckpoint(
	{ path, root, work }: Required<Pick<CrashedShard, "path" | "root" | "work">>,
	legacyRollbackMode = false,
): Promise<void> {
	const shard = await ShipShard.open(path, root);
	try {
		const lease = { id: work, generation: 1, worker: "retiring-host/1", epoch: 1 };
		await shard.hold(lease, 3_600_000);
		await shard.accept(root, lease, `scope:${work}`, JSON.stringify({ unshipped: work }), 1);
	} finally {
		await shard.close({ retire: true });
	}
	if (legacyRollbackMode) {
		const database = new DatabaseSync(path);
		try {
			database.exec("PRAGMA journal_mode=DELETE");
		} finally {
			database.close();
		}
	}
}

export interface CrashedHostScenario {
	readonly selection: RunJournalOption;
	readonly agentDir: string;
	readonly restart: (journal: RunJournal) => Promise<() => Promise<void>>;
}

export function restartAsRoot(agentDir: string): (journal: RunJournal) => Promise<() => Promise<void>> {
	return async (journal) => {
		const root = `restarted-${randomUUID()}`;
		await journal.createRun({ runId: root, name: root, cwd: agentDir, createdAt: 0, status: "running" });
		const acquired = await journal.acquire(root, "restarted-host");
		if (acquired.status !== "acquired") assert.fail("the restarted host's root lease was not acquired");
		const host = openCoordinator();
		await host.command({
			kind: "prepare",
			root,
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: {
					stateDirectory: poolStateDirectory(agentDir),
					host: "restarted-host",
					claimWindowMs: 60_000,
					checkpointShipping: CRASH_SHIPPING,
				},
				workers: 1,
				leaseMs: 30_000,
				heartbeatMs: 7_500,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		return async () => {
			try {
				await host.command({ kind: "close" });
			} finally {
				await host.coordinator.shutdown();
			}
		};
	};
}

export function restartAsWorkerHost(
	selection: SharedJournalSelection,
	agentDir: string,
	workerEntry: string,
): () => Promise<() => Promise<void>> {
	return async () => {
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		const host = await startWorkflowWorkerHost({
			journal: selection,
			agentDir,
			maxWorkers: 1,
			restore: false,
			hostId: "restarted-host",
			workerEntry,
		});
		return () => host.stop();
	};
}

export async function crashHostThenRestart(scenario: CrashedHostScenario): Promise<void> {
	const journal = await resolveRunJournal({ agentDir: scenario.agentDir, journal: scenario.selection });
	let holder: ShardHolder | undefined;
	let connection: SqliteDatabase | undefined;
	let retiredReader: SqliteDatabase | undefined;
	let retiredWriter: SqliteDatabase | undefined;
	let legacyReader: SqliteDatabase | undefined;
	let legacyWriter: SqliteDatabase | undefined;
	let uriUnreadReader: SqliteDatabase | undefined;
	let uriSelectedReader: SqliteDatabase | undefined;
	let uriWriter: SqliteDatabase | undefined;
	let rawUnreadReader: DatabaseSync | undefined;
	let rawRollbackReader: DatabaseSync | undefined;
	let rawRollbackWriter: DatabaseSync | undefined;
	let lateConnection: SqliteDatabase | undefined;
	let lateUriConnection: SqliteDatabase | undefined;
	try {
		const identity = durableJournalIdentity(poolDurableJournal(journal));
		const stateDirectory = poolStateDirectory(scenario.agentDir);
		const cases = [...ENDED_WHILE_DOWN, ...LIVE_WHILE_DOWN, ...IN_USE, "lateOpened"] as const;
		const shards = Object.fromEntries(
			cases.map((name) => {
				const root = `${name}-${randomUUID()}`;
				return [name, { path: shipShardPath(stateDirectory, identity, root), root, work: `work-${root}` }];
			}),
		) as Record<ShardCase, Required<Pick<CrashedShard, "path" | "root" | "work">>>;
		for (const shard of Object.values(shards))
			await journal.createRun({
				runId: shard.root,
				name: shard.root,
				cwd: scenario.agentDir,
				createdAt: 0,
				status: "running",
			});

		const retiredCases = new Set<ShardCase>([
			"retiredReader",
			"retiredWriter",
			"legacyReader",
			"legacyWriter",
			"legacyProcessReader",
			"uriSelectedReader",
			"uriWriter",
			"uriProcessReader",
			"rawRollbackReader",
			"rawRollbackWriter",
		]);
		const killedCases = cases.filter((name) => name !== "held" && !retiredCases.has(name));
		const crashed = await holdShards(killedCases.map((name) => shards[name]));
		await crashed.kill();
		assert.equal(crashed.process.signalCode, "SIGKILL");
		for (const name of killedCases)
			assert.ok(existsSync(`${shards[name].path}-wal`), `the crashed host left ${name}'s journal mid-write`);

		await retireWithUnshippedCheckpoint(shards.retiredReader);
		await retireWithUnshippedCheckpoint(shards.retiredWriter);
		for (const legacy of [
			shards.legacyReader,
			shards.legacyWriter,
			shards.legacyProcessReader,
			shards.uriSelectedReader,
			shards.uriWriter,
			shards.uriProcessReader,
			shards.rawRollbackReader,
			shards.rawRollbackWriter,
		])
			await retireWithUnshippedCheckpoint(legacy, true);
		holder = await holdShards([
			shards.held,
			{ ...shards.legacyProcessReader, readOnly: true },
			{ ...shards.uriProcessReader, readOnly: true, uri: true },
		]);
		for (const name of [...ENDED_WHILE_DOWN, ...IN_USE, "lateOpened"] as const)
			if (name === "deleted") await journal.deleteRun(shards.deleted.root);
			else await setRunStatus(journal, shards[name].root, name === "failed" ? "failed" : "completed");
		await setRunStatus(journal, shards.paused.root, "paused");
		connection = await openNodeSqliteDatabase(shards.connected.path);
		await connection.get(`SELECT COUNT(*) AS n FROM ship_events`);
		retiredReader = await openNodeSqliteDatabase(shards.retiredReader.path, { readOnly: true });
		assert.equal(
			Number((await retiredReader.get<SqliteRow & { n: number }>(`SELECT COUNT(*) AS n FROM ship_events`))?.n),
			1,
		);
		retiredWriter = await openNodeSqliteDatabase(shards.retiredWriter.path);
		legacyReader = await openNodeSqliteDatabase(shards.legacyReader.path, { readOnly: true });
		assert.equal(
			Number((await legacyReader.get<SqliteRow & { n: number }>(`SELECT COUNT(*) AS n FROM ship_events`))?.n),
			1,
		);
		legacyWriter = await openNodeSqliteDatabase(shards.legacyWriter.path);
		uriUnreadReader = await openNodeSqliteDatabase(pathToFileURL(shards.uriUnreadReader.path).href, {
			readOnly: true,
		});
		uriSelectedReader = await openNodeSqliteDatabase(pathToFileURL(shards.uriSelectedReader.path).href, {
			readOnly: true,
		});
		assert.equal(
			Number((await uriSelectedReader.get<SqliteRow & { n: number }>(`SELECT COUNT(*) AS n FROM ship_events`))?.n),
			1,
		);
		uriWriter = await openNodeSqliteDatabase(pathToFileURL(shards.uriWriter.path).href);
		rawUnreadReader = new DatabaseSync(shards.rawUnreadReader.path, { readOnly: true });
		rawRollbackReader = new DatabaseSync(shards.rawRollbackReader.path, { readOnly: true });
		assert.equal(
			Number(
				(rawRollbackReader.prepare(`SELECT COUNT(*) AS n FROM ship_events`).get() as { n: number } | undefined)?.n,
			),
			1,
		);
		rawRollbackWriter = new DatabaseSync(shards.rawRollbackWriter.path);
		assert.equal(
			Number(
				(rawRollbackWriter.prepare(`SELECT COUNT(*) AS n FROM ship_events`).get() as { n: number } | undefined)?.n,
			),
			1,
		);

		let openedBeforeUnlink = false;
		let openedDuringRemoval = false;
		let lateOpening: Promise<SqliteDatabase> | undefined;
		let lateUriOpening: Promise<SqliteDatabase> | undefined;
		let lateReadOnlyOpening: Promise<SqliteDatabase> | undefined;
		shardRemovals.before = {
			prefix: shards.lateOpened.path,
			run: async () => {
				lateOpening = openNodeSqliteDatabase(shards.lateOpened.path).then(async (database) => {
					await database.all(`SELECT * FROM ship_events`).catch(() => []);
					openedBeforeUnlink = true;
					return database;
				});
				lateUriOpening = openNodeSqliteDatabase(pathToFileURL(shards.lateOpened.path).href).then(
					async (database) => {
						await database.all(`SELECT * FROM ship_events`).catch(() => []);
						openedBeforeUnlink = true;
						return database;
					},
				);
				lateReadOnlyOpening = openNodeSqliteDatabase(pathToFileURL(shards.lateOpened.path).href, {
					readOnly: true,
				});
				lateReadOnlyOpening.catch(() => {});
				await Promise.race([Promise.all([lateOpening, lateUriOpening]), sleep(LATE_OPEN_GRACE_MS)]);
				openedDuringRemoval = openedBeforeUnlink;
			},
		};

		let stop = await scenario.restart(journal);
		try {
			for (const name of ENDED_WHILE_DOWN)
				assert.deepEqual(shardFiles(shards[name].path), [], `the ${name} root's local journal is removed`);
			for (const name of LIVE_WHILE_DOWN) {
				assert.ok(existsSync(shards[name].path), `the ${name} root's local journal is kept`);
				assert.equal(await unshippedCheckpoints(shards[name].path), 1, `the ${name} root keeps its checkpoint`);
			}
			assert.ok(existsSync(shards.held.path), "a journal another process holds open is kept");
			assert.ok(existsSync(shards.connected.path), "a journal another connection uses is kept");
			for (const [label, reader, shard] of [
				["retained", retiredReader, shards.retiredReader],
				["0.9.88 rollback-mode", legacyReader, shards.legacyReader],
				["file: URI unread", uriUnreadReader, shards.uriUnreadReader],
				["file: URI selected", uriSelectedReader, shards.uriSelectedReader],
			] as const) {
				assert.ok(existsSync(shard.path), `a ${label} journal a read-only connection holds is kept`);
				assert.equal(
					Number((await reader.get<SqliteRow & { n: number }>(`SELECT COUNT(*) AS n FROM ship_events`))?.n),
					1,
				);
			}
			for (const [label, writer, shard] of [
				["retained", retiredWriter, shards.retiredWriter],
				["0.9.88 rollback-mode", legacyWriter, shards.legacyWriter],
				["file: URI", uriWriter, shards.uriWriter],
			] as const) {
				assert.ok(existsSync(shard.path), `a ${label} journal a writable connection opened is kept`);
				assert.equal((await writer.run(`UPDATE ship_events SET at = 2`)).changes, 1);
				assert.equal(await unshippedCheckpoints(shard.path), 1);
			}
			for (const [label, shard] of [
				["0.9.88 rollback-mode", shards.legacyProcessReader],
				["file: URI", shards.uriProcessReader],
			] as const) {
				assert.ok(existsSync(shard.path), `a ${label} journal another process reads is kept`);
			}
			for (const [label, rawReader, shard] of [
				["raw unread", rawUnreadReader, shards.rawUnreadReader],
				["raw rollback", rawRollbackReader, shards.rawRollbackReader],
			] as const) {
				assert.ok(existsSync(shard.path), `a ${label} journal a raw read-only handle holds is kept`);
				assert.equal(
					Number(
						(rawReader.prepare(`SELECT COUNT(*) AS n FROM ship_events`).get() as { n: number } | undefined)?.n,
					),
					1,
				);
			}
			assert.ok(
				existsSync(shards.rawRollbackWriter.path),
				"a raw rollback journal a raw writable handle holds is kept",
			);
			assert.equal(rawRollbackWriter.prepare(`UPDATE ship_events SET at = 3`).run().changes, 1);
			assert.ok(lateOpening !== undefined && lateUriOpening !== undefined && lateReadOnlyOpening !== undefined);
			assert.equal(openedDuringRemoval, false, "a late opener waits while the journal is being removed");
			await assert.rejects(lateReadOnlyOpening, /unable to open database file/i);
			lateConnection = await lateOpening;
			lateUriConnection = await lateUriOpening;
			assert.ok(existsSync(shards.lateOpened.path), "the late opener's file exists on disk");
			assert.equal(
				await lateConnection.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ship_events'`),
				undefined,
				"the late opener opened a fresh file after the ended journal was removed",
			);
			await lateConnection.exec(`CREATE TABLE late_check(v INTEGER); INSERT INTO late_check(v) VALUES (1);`);
			await lateUriConnection.run(`INSERT INTO late_check(v) VALUES (2)`);
			await lateConnection.close();
			lateConnection = undefined;
			await lateUriConnection.close();
			lateUriConnection = undefined;
			const verifier = await openNodeSqliteDatabase(shards.lateOpened.path, { readOnly: true });
			try {
				assert.equal(
					Number((await verifier.get<SqliteRow & { n: number }>(`SELECT COUNT(*) AS n FROM late_check`))?.n),
					2,
					"both late openers' writes landed in the file at its path",
				);
			} finally {
				await verifier.close();
			}
			for (const file of shardFiles(shards.lateOpened.path))
				rmSync(join(dirname(shards.lateOpened.path), file), { recursive: true, force: true });
		} finally {
			await stop();
		}

		await holder.kill();
		holder = undefined;
		await connection.close();
		connection = undefined;
		await retiredReader.close();
		retiredReader = undefined;
		await retiredWriter.close();
		retiredWriter = undefined;
		await legacyReader.close();
		legacyReader = undefined;
		await legacyWriter.close();
		legacyWriter = undefined;
		await uriUnreadReader.close();
		uriUnreadReader = undefined;
		await uriSelectedReader.close();
		uriSelectedReader = undefined;
		await uriWriter.close();
		uriWriter = undefined;
		rawUnreadReader.close();
		rawUnreadReader = undefined;
		rawRollbackReader.close();
		rawRollbackReader = undefined;
		rawRollbackWriter.close();
		rawRollbackWriter = undefined;
		stop = await scenario.restart(journal);
		try {
			for (const name of [...ENDED_WHILE_DOWN, ...IN_USE])
				assert.deepEqual(shardFiles(shards[name].path), [], `the ${name} root's local journal is removed`);
			for (const name of LIVE_WHILE_DOWN)
				assert.equal(await unshippedCheckpoints(shards[name].path), 1, `the ${name} root keeps its checkpoint`);
		} finally {
			await stop();
		}
	} finally {
		shardRemovals.before = undefined;
		await holder?.kill();
		await connection?.close();
		await retiredReader?.close();
		await retiredWriter?.close();
		await legacyReader?.close();
		await legacyWriter?.close();
		await uriUnreadReader?.close();
		await uriSelectedReader?.close();
		await uriWriter?.close();
		rawUnreadReader?.close();
		rawRollbackReader?.close();
		rawRollbackWriter?.close();
		await lateConnection?.close();
		await lateUriConnection?.close();
		await journal.close();
	}
}
