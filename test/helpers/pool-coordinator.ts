import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	openSqlPoolQueue,
	type PoolControl,
	type PoolWorkDescriptor,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { rehydrateError, type SerializedError } from "../../packages/workflows/src/shared/error-codec.js";
import type { PoolCoordinationStats } from "../../packages/workflows/src/shared/store-types.js";
import type {
	CoordinatorCommandBody,
	CoordinatorEvent,
	CoordinatorInbound,
	CoordinatorNotice,
	CoordinatorPort,
	CoordinatorRequestBody,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import type { FakeWorker } from "./fake-pool-worker.js";
import { poolWorkFixture } from "./pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
export const SOURCE = { path: "fixture", exportName: "child", digest: "sha256:child" };

export interface CoordinatorFixtureOptions {
	readonly workers?: number;
	/** Workers that report ready at start; the rest stay starting until the test readies them. */
	readonly ready?: number;
	readonly leaseMs?: number;
	readonly startupTimeoutMs?: number;
	/** Control the root asked for before its pool was prepared. */
	readonly control?: PoolControl["state"];
	/** Whether to start workers and enqueue one child; a prepared-only coordinator runs no recovery. */
	readonly start?: boolean;
	/** Whether the pool publishes its workers' activity to the root. */
	readonly publish?: boolean;
	/** The execution recorded for the enqueued child. */
	readonly execution?: PoolWorkDescriptor["execution"];
}

/** One coordinator in this process, on its own port: commands as the root sends them, and the events it sent. */
export function openCoordinator() {
	const events: CoordinatorEvent[] = [];
	const listeners: ((message: CoordinatorInbound) => void)[] = [];
	const port: CoordinatorPort<CoordinatorEvent, CoordinatorInbound> = {
		send: (message) => events.push(JSON.parse(JSON.stringify(message)) as CoordinatorEvent),
		onMessage: (listener) => listeners.push(listener),
		onClose: () => {},
		close: async () => {},
	};
	const coordinator = new PoolCoordinator(port);
	let commandSequence = 0;
	const command = async (body: CoordinatorCommandBody): Promise<unknown> => {
		const id = ++commandSequence;
		for (const listener of listeners) listener({ ...body, id } as CoordinatorInbound);
		for (;;) {
			const reply = events.find((event) => event.kind === "reply" && event.id === id);
			if (reply?.kind === "reply") {
				if (reply.error !== undefined) throw rehydrateError(reply.error);
				return reply.value;
			}
			await delay(5);
		}
	};
	const inbound = (body: CoordinatorInbound) => {
		for (const listener of listeners) listener(body);
	};
	return { coordinator, events, command, inbound };
}

/** A coordinator in this process over a real journal, its workers the {@link FakeWorker}s `forked` collects. */
export async function coordinatorFixture(forked: readonly FakeWorker[], options: CoordinatorFixtureOptions = {}) {
	const workers = options.workers ?? 2;
	const directory = makeTempDirectory("pool-coordinator-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "root-holder");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const prepareOptions = {
		journalPath: path,
		workers,
		leaseMs: options.leaseMs ?? LEASE_MS,
		heartbeatMs: HEARTBEAT_MS,
		startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
		workerEntry: "fake-worker",
	};
	const { coordinator, events, command, inbound } = openCoordinator();
	const notice = (body: CoordinatorNotice) => inbound(body);
	await command({
		kind: "prepare",
		root: "root",
		lease,
		options: prepareOptions,
		...(options.control === undefined ? {} : { control: options.control }),
	});
	const { work, boundary } = poolWorkFixture();
	const descriptor = {
		...work,
		...(options.execution === undefined ? {} : { execution: options.execution }),
		definition: `${SOURCE.path}#${SOURCE.exportName}`,
		digest: SOURCE.digest,
	};
	if (options.start !== false) {
		const starting = command({ kind: "start", sources: [SOURCE], cwd: directory, publish: options.publish ?? false });
		while (forked.length < workers) await delay(5);
		for (const worker of forked.slice(0, options.ready ?? workers)) await worker.request({ kind: "ready" });
		await starting;
		await command({ kind: "enqueue", descriptor, boundary });
	}
	const queue = await openSqlPoolQueue(journal);
	/** The event the coordinator sent first, after `after` events, that `match` accepts. */
	const next = async <E extends CoordinatorEvent>(match: (event: CoordinatorEvent) => event is E, after = 0) => {
		for (;;) {
			const found = events.slice(after).find(match);
			if (found !== undefined) return found;
			await delay(5);
		}
	};
	/** Coordinators of later root incarnations, closed with the fixture. */
	const later: ReturnType<typeof openCoordinator>[] = [];
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await command({ kind: "close" });
		await coordinator.shutdown();
	};
	return {
		lease,
		directory,
		path,
		database,
		journal,
		coordinator,
		descriptor,
		boundary,
		events,
		command,
		notice,
		next,
		queue,
		usage: await openSqlPoolUsage(journal),
		workers: [...forked],
		/** The coordinator's next request to the root, after `after` events. */
		rootRequest: (after = 0) =>
			next(
				(event): event is { kind: "request"; id: number; request: CoordinatorRequestBody } =>
					event.kind === "request",
				after,
			),
		/** Answers a request the coordinator sent the root. */
		answer: (id: number, reply: { readonly value?: unknown; readonly error?: SerializedError }) =>
			inbound({ kind: "request-reply", id, ...reply }),
		reports: () => events.flatMap((event) => (event.kind === "coordination" ? [event.stats] : [])),
		/** The coordinator's next report of its counts, sent within a second while they change. */
		async nextStats(after: number): Promise<PoolCoordinationStats> {
			for (;;) {
				const report = events.slice(after).find((event) => event.kind === "coordination");
				if (report?.kind === "coordination") return report.stats;
				await delay(20);
			}
		},
		/** Closes this coordinator, leaving the journal open for a later incarnation. */
		stop,
		/** A prepared coordinator of a later root incarnation holding `next`, on the same journal. */
		async resume(next: Lease) {
			const resumed = openCoordinator();
			later.push(resumed);
			await resumed.command({ kind: "prepare", root: "root", lease: next, options: prepareOptions });
			return resumed;
		},
		async close() {
			await stop();
			for (const resumed of later) {
				await resumed.command({ kind: "close" });
				await resumed.coordinator.shutdown();
			}
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}
