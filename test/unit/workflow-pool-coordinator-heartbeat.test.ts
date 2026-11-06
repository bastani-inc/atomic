import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { isDebugEnabled } from "../../packages/coding-agent/src/core/debug.js";
import { setDebugSetting } from "../../packages/coding-agent/src/core/debug-setting.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	openSqlPoolQueue,
	type PoolControl,
	type PoolWork,
	type PoolWorkDescriptor,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import type { PoolCoordinationStats } from "../../packages/workflows/src/shared/store-types.js";
import {
	type CoordinatorCommandBody,
	type CoordinatorEvent,
	type CoordinatorInbound,
	type CoordinatorNotice,
	type CoordinatorPort,
	POOL_COORDINATION_STATS_INTERVAL_MS,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { POOL_DURABLE_JOURNAL_ENV } from "../../packages/workflows/src/workers/pool-journal.js";
import type {
	DistributiveOmit,
	WorkerInbound,
	WorkerReply,
	WorkerRequest,
	WorkerStart,
} from "../../packages/workflows/src/workers/protocol.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** A worker process as the coordinator sees it: IPC both ways, driven by the test instead of a worker's loop. */
class FakeWorker extends EventEmitter {
	readonly pid: number;
	readonly start: WorkerStart;
	readonly options: ForkOptions;
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly stderr = undefined;
	/** Messages the coordinator pushed without a request: pool control, stage commands, shared limits. */
	readonly pushed: Exclude<WorkerInbound, WorkerReply>[] = [];
	/** Set to make every push to this worker fail, as for a channel that closed. */
	refusePushes = false;
	killedWith?: NodeJS.Signals;
	private sequence = 0;
	private readonly replies = new Map<number, (reply: WorkerReply) => void>();

	constructor(pid: number, args: readonly string[], options: ForkOptions) {
		super();
		this.pid = pid;
		this.start = JSON.parse(args[0]!) as WorkerStart;
		this.options = options;
	}

	send(message: WorkerInbound, callback?: (error: Error | null) => void): boolean {
		if ("kind" in message) {
			if (this.refusePushes) {
				callback?.(new Error("channel closed"));
				return false;
			}
			this.pushed.push(message);
		} else {
			this.replies.get(message.id)?.(message);
			this.replies.delete(message.id);
		}
		callback?.(null);
		return true;
	}

	request(body: DistributiveOmit<WorkerRequest, "id">): Promise<WorkerReply> {
		const id = ++this.sequence;
		return new Promise((resolve) => {
			this.replies.set(id, resolve);
			this.emit("message", { ...body, id });
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.killedWith = signal;
		this.signalCode = signal;
		this.connected = false;
		setImmediate(() => {
			this.emit("disconnect");
			this.emit("exit", null, signal);
			this.emit("close", null, signal);
		});
		return true;
	}

	disconnect(): void {
		this.connected = false;
		this.emit("disconnect");
	}
}

const forked = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		fork(_modulePath: string, args: readonly string[], options: ForkOptions) {
			const worker = new FakeWorker(4_000_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

/**
 * Every SQLite connection in this file, the coordinator's own included, reads its clock from `Date`, so a test that fakes
 * `Date` sets the journal's time and the coordinator's together.
 */
vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class DateClockedDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			this.function("unixepoch", { varargs: true }, () => Date.now() / 1_000);
		}
	}
	return { ...actual, DatabaseSync: DateClockedDatabase };
});

afterEach(() => {
	vi.useRealTimers();
	forked.length = 0;
});

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const SOURCE = { path: "fixture", exportName: "child", digest: "sha256:child" };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

interface FixtureOptions {
	readonly workers?: number;
	/** Workers that report ready at start; the rest stay starting until the test readies them. */
	readonly ready?: number;
	readonly leaseMs?: number;
	/** Control the root asked for before its pool was prepared. */
	readonly control?: PoolControl["state"];
	/** Whether to start workers and enqueue one child; a prepared-only coordinator runs no recovery. */
	readonly start?: boolean;
	/** The execution recorded for the enqueued child. */
	readonly execution?: PoolWorkDescriptor["execution"];
}

/** A coordinator in this process over a real journal, its workers {@link FakeWorker}s. */
async function coordinatorFixture(options: FixtureOptions = {}) {
	const workers = options.workers ?? 2;
	const directory = makeTempDirectory("pool-coordinator-heartbeat-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "root-holder");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
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
				if (reply.error !== undefined) throw new Error(reply.error);
				return reply.value;
			}
			await delay(5);
		}
	};
	const notice = (body: CoordinatorNotice) => {
		for (const listener of listeners) listener(body);
	};
	await command({
		kind: "prepare",
		root: "root",
		lease,
		options: {
			journalPath: path,
			workers,
			leaseMs: options.leaseMs ?? LEASE_MS,
			heartbeatMs: HEARTBEAT_MS,
			startupTimeoutMs: 30_000,
			workerEntry: "fake-worker",
		},
		...(options.control === undefined ? {} : { control: options.control }),
	});
	if (options.start !== false) {
		const starting = command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
		while (forked.length < workers) await delay(5);
		for (const worker of forked.slice(0, options.ready ?? workers)) await worker.request({ kind: "ready" });
		await starting;
		const { work, boundary } = poolWorkFixture();
		const descriptor = {
			...work,
			...(options.execution === undefined ? {} : { execution: options.execution }),
			definition: `${SOURCE.path}#${SOURCE.exportName}`,
			digest: SOURCE.digest,
		};
		await command({ kind: "enqueue", descriptor, boundary });
	}
	const queue = await openSqlPoolQueue(journal);
	return {
		database,
		journal,
		lease,
		events,
		command,
		notice,
		queue,
		usage: await openSqlPoolUsage(journal),
		workers: [...forked],
		reports: () => events.flatMap((event) => (event.kind === "coordination" ? [event.stats] : [])),
		/** The coordinator's next report of its counts, sent within a second while they change. */
		async nextStats(after: number): Promise<PoolCoordinationStats> {
			for (;;) {
				const report = events.slice(after).find((event) => event.kind === "coordination");
				if (report?.kind === "coordination") return report.stats;
				await delay(20);
			}
		},
		async close() {
			await command({ kind: "close" });
			await coordinator.shutdown();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("one heartbeat request renews the attempt, records its usage and answers pool control in one journal write (#4313)", async () => {
	const f = await coordinatorFixture();
	try {
		const [holder, idle] = f.workers as [FakeWorker, FakeWorker];
		assert.equal(holder.start.heartbeatMs, HEARTBEAT_MS, "each worker learns its heartbeat interval at start");
		const claimed = (await holder.request({ kind: "claim" })).value as PoolWork;
		assert.equal(claimed.worker !== null, true);
		assert.equal((await idle.request({ kind: "claim" })).value, undefined, "one work item, one attempt");
		const reports = [{ key: "stage:child:agent", usage: { ...zero, input: 120, output: 30, cost: 2 } }];
		const statsFrom = f.events.length;
		const reply = await holder.request({ kind: "heartbeat", reports });
		assert.equal(reply.error, undefined);
		assert.deepEqual(reply.value, { state: "running", revision: 1 });
		const renewed = (await f.queue.inspect("root"))[0]!;
		assert.ok(renewed.renewedAt >= claimed.renewedAt, "the heartbeat renewed the attempt's lease");
		assert.ok(renewed.expiresAt >= renewed.renewedAt + LEASE_MS);
		assert.deepEqual(await f.usage.total("root"), reports[0]!.usage, "and recorded its usage");
		while (!f.events.some((event) => event.kind === "activity" && event.usage !== undefined)) await delay(5);
		assert.deepEqual(
			f.events.find((event) => event.kind === "activity" && event.usage !== undefined),
			{ kind: "activity", batch: 1, entries: [], usage: reports[0]!.usage },
			"the root's budget hears of the usage the heartbeat recorded",
		);
		const again = await holder.request({ kind: "heartbeat", reports });
		assert.deepEqual(again.value, { state: "running", revision: 1 });
		const orphan = await idle.request({ kind: "heartbeat", reports: [] });
		assert.equal(orphan.error, "Worker has no active attempt", "a heartbeat needs an attempt to renew");

		let stats = await f.nextStats(statsFrom);
		while (stats.requests.heartbeat?.count !== 3) stats = await f.nextStats(f.events.length);
		assert.equal(stats.writes.heartbeat?.count, 2, "each answered heartbeat cost one write, the refused one none");
		assert.equal(stats.requests.claim?.count, 2);
		assert.ok((stats.writes.claim?.count ?? 0) > 0, "claims' writes count as the claims'");
		assert.ok((stats.writes["root-prepare"]?.count ?? 0) > 0, "the root's commands are counted as root-<kind>");
		// Recovery reads attempts whose leases hold without a write; an attempt whose lease lapsed is renewed, and that
		// write counts as recovery's.
		await delay(1_500);
		await holder.request({ kind: "heartbeat", reports: [] });
		stats = await f.nextStats(f.events.length);
		assert.equal(stats.writes.recovery?.count ?? 0, 0, "recovery passes write nothing while every lease holds");
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE root = 'root' AND state = 'leased'");
		while ((stats.writes.recovery?.count ?? 0) === 0) stats = await f.nextStats(f.events.length);
		assert.ok((stats.writes.recovery?.count ?? 0) > 0, "expired-lease recovery's writes count as recovery");
		assert.equal(
			(await holder.request({ kind: "activity", runs: [] })).value,
			undefined,
			"another request of the attempt is answered as its own kind, not as a heartbeat",
		);
		assert.equal(stats.requests["root-enqueue"]?.count, 1);
		for (const kind of ["renew", "usage", "control"])
			assert.equal(stats.requests[kind], undefined, `no worker request of kind ${kind}`);
		assert.ok(stats.since <= Date.now());
		assert.ok((stats.requests.heartbeat?.perSecond ?? 0) > 0);
		// Recovery looks for expired leases with a read (#4314), so it writes only once a lease has expired: run the shared
		// clock past the attempt's expiry, and recovery renews the lease of the attempt's live worker.
		vi.useFakeTimers({ toFake: ["Date"], now: (await f.queue.inspect("root"))[0]!.expiresAt + 1 });
		while ((stats.writes.recovery?.count ?? 0) === 0) stats = await f.nextStats(f.events.length);
		assert.ok((stats.writes.recovery?.count ?? 0) > 0, "expired-lease recovery's writes count as recovery");
	} finally {
		await f.close();
	}
});

test("pool control is pushed to ready workers once per revision and reconciled in heartbeat replies (#4313)", async () => {
	const f = await coordinatorFixture();
	try {
		const [holder, idle] = f.workers as [FakeWorker, FakeWorker];
		await holder.request({ kind: "claim" });
		const pausing = f.command({ kind: "control", state: "paused" });
		while (holder.pushed.length === 0 || idle.pushed.length === 0) await delay(5);
		const pushed = { kind: "pool-control", control: { state: "paused", revision: 2 } };
		assert.deepEqual(holder.pushed, [pushed], "the attempt's worker hears of the pause without waiting to poll");
		assert.deepEqual(idle.pushed, [pushed], "and so does an idle worker");
		await holder.request({ kind: "controlled", revision: 2 });
		await idle.request({ kind: "controlled", revision: 2 });
		assert.equal(await pausing, 0, "every ready worker acknowledged the pause");
		assert.equal(await f.command({ kind: "control", state: "paused" }), 0);
		assert.equal(holder.pushed.length, 1, "an unchanged control is not pushed again");
		const reply = await holder.request({ kind: "heartbeat", reports: [] });
		assert.deepEqual(reply.value, { state: "paused", revision: 2 }, "a heartbeat reply carries the current control");

		idle.refusePushes = true;
		const resuming = f.command({ kind: "control", state: "running" });
		while (holder.pushed.length < 2) await delay(5);
		assert.deepEqual(holder.pushed[1], { kind: "pool-control", control: { state: "running", revision: 3 } });
		while (idle.killedWith === undefined) await delay(5);
		assert.equal(idle.killedWith, "SIGKILL", "a worker the push cannot reach is stopped and replaced");
		while (forked.length < 3) await delay(5);
		// The replacement reads pool control before it claims, as a starting worker does, and acknowledges it.
		const replacement = forked[2]!;
		await replacement.request({ kind: "ready" });
		assert.deepEqual((await replacement.request({ kind: "control" })).value, { state: "running", revision: 3 });
		await replacement.request({ kind: "controlled", revision: 3 });
		assert.deepEqual(replacement.pushed, [], "a worker that was not ready when control changed was not pushed it");
		await holder.request({ kind: "controlled", revision: 3 });
		assert.equal(await resuming, 0);
	} finally {
		await f.close();
	}
});

test("a heartbeat of an attempt that lost its work is refused as fenced, with nothing recorded (#4313)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		const [holder] = f.workers as [FakeWorker];
		const claimed = (await holder.request({ kind: "claim" })).value as PoolWork;
		assert.equal(await f.queue.releaseExited(f.lease, claimed), true);
		const reports = [{ key: "stage:child:agent", usage: { ...zero, input: 50 } }];
		const reply = await holder.request({ kind: "heartbeat", reports });
		assert.equal(reply.error, "Stale work lease");
		assert.equal(reply.fenced, true, "the worker ends the attempt without failing");
		assert.deepEqual(await f.usage.total("root"), zero, "a refused heartbeat records no usage");
		const work = (await f.queue.inspect("root"))[0]!;
		assert.equal(work.state, "ready", "and does not renew work it no longer holds");
	} finally {
		await f.close();
	}
});

test("a worker that is not ready yet is not pushed control, and a pause committed while preparing is not pushed again (#4313)", async () => {
	const f = await coordinatorFixture({ ready: 1, control: "paused" });
	try {
		const [ready, starting] = f.workers as [FakeWorker, FakeWorker];
		const pausing = f.command({ kind: "control", state: "paused" });
		await ready.request({ kind: "controlled", revision: 1 });
		assert.equal(await pausing, 0, "only the ready worker is waited for");
		assert.deepEqual(ready.pushed, [], "the pause committed while preparing is not pushed a second time");
		const resuming = f.command({ kind: "control", state: "running" });
		while (ready.pushed.length === 0) await delay(5);
		assert.deepEqual(ready.pushed, [{ kind: "pool-control", control: { state: "running", revision: 2 } }]);
		await ready.request({ kind: "controlled", revision: 2 });
		await resuming;
		assert.deepEqual(starting.pushed, [], "a starting worker reads control itself before it claims");
		await starting.request({ kind: "ready" });
	} finally {
		await f.close();
	}
});

test("a budget notice holds claims until the root lifts it (#4313)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		f.notice({ kind: "budget", blocked: true });
		assert.equal((await worker.request({ kind: "claim" })).value, undefined, "an exhausted budget claims nothing");
		f.notice({ kind: "budget", blocked: false });
		assert.notEqual((await worker.request({ kind: "claim" })).value, undefined, "the queued child is claimed after");
	} finally {
		await f.close();
	}
});

/** A whole second, which SQLite's `unixepoch('subsec')` reads back exactly, for tests that fake `Date`. */
const CLOCK_START_MS = Date.UTC(2026, 0, 1);

test("a request of an attempt renews its lease once half of it is spent, and not before (#4313)", async () => {
	const leaseMs = 2_000;
	vi.useFakeTimers({ toFake: ["Date"], now: CLOCK_START_MS });
	const f = await coordinatorFixture({ workers: 1, leaseMs });
	try {
		const [holder] = f.workers as [FakeWorker];
		const claimed = (await holder.request({ kind: "claim" })).value as PoolWork;
		assert.deepEqual(
			{ renewedAt: claimed.renewedAt, expiresAt: claimed.expiresAt },
			{ renewedAt: CLOCK_START_MS, expiresAt: CLOCK_START_MS + leaseMs },
			"the claim's lease runs on the test's clock",
		);
		const activityAt = async (now: number) => {
			vi.setSystemTime(now);
			assert.equal((await holder.request({ kind: "activity", runs: [] })).error, undefined);
			const { renewedAt, expiresAt } = (await f.queue.inspect("root"))[0]!;
			return { renewedAt, expiresAt };
		};
		const halfSpentAt = (expiresAt: number) => expiresAt - leaseMs / 2;
		assert.deepEqual(
			await activityAt(halfSpentAt(claimed.expiresAt) - 1),
			{ renewedAt: claimed.renewedAt, expiresAt: claimed.expiresAt },
			"a lease 1 ms short of half spent is left as it is",
		);
		const atHalf = halfSpentAt(claimed.expiresAt);
		assert.deepEqual(
			await activityAt(atHalf),
			{ renewedAt: atHalf, expiresAt: atHalf + leaseMs },
			"a lease exactly half spent is renewed",
		);
		const pastHalf = halfSpentAt(atHalf + leaseMs) + 1;
		assert.deepEqual(
			await activityAt(pastHalf),
			{ renewedAt: pastHalf, expiresAt: pastHalf + leaseMs },
			"and so is a lease more than half spent",
		);
	} finally {
		await f.close();
	}
});

test("a coordinator reports its counts only while they change, and once more as it closes (#4313)", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const f = await coordinatorFixture({ workers: 1, start: false });
	try {
		const { work, boundary } = poolWorkFixture();
		await assert.rejects(
			f.command({ kind: "enqueue", descriptor: { ...work, scope: "workflow:elsewhere:0" }, boundary }),
			Error,
			"a refused command is answered with its error",
		);
		vi.advanceTimersByTime(POOL_COORDINATION_STATS_INTERVAL_MS);
		assert.equal(f.reports().length, 1, "changed counts are sent at the next interval");
		vi.advanceTimersByTime(3 * POOL_COORDINATION_STATS_INTERVAL_MS);
		assert.equal(f.reports().length, 1, "unchanged counts are not sent again");
		f.notice({ kind: "budget", blocked: true });
		await f.command({ kind: "close" });
		const closing = f.reports().at(-1)!;
		assert.equal(
			closing.requests["root-budget"]?.count,
			1,
			"the last report, sent as the pool closes, has every count",
		);
		assert.equal(closing.requests["root-close"]?.count, 1);
		f.notice({ kind: "budget", blocked: false });
		vi.advanceTimersByTime(3 * POOL_COORDINATION_STATS_INTERVAL_MS);
		assert.equal(f.reports().at(-1), closing, "a closed coordinator reports nothing more");
	} finally {
		await f.close();
	}
});

test("workers start with the root's debug setting, and a change reaches the workers started after it (#4360)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		const [first] = f.workers as [FakeWorker];
		assert.equal(first.options.env?.ATOMIC_DEBUG_SETTING, "0", "debug mode was off when it started");
		assert.equal(first.options.env?.AI_AGENT, "atomic", "a worker gets Atomic's child environment");
		assert.equal(
			POOL_DURABLE_JOURNAL_ENV in (first.options.env ?? {}),
			false,
			"and no durable journal it does not use",
		);
		f.notice({ kind: "debug", enabled: true });
		assert.equal(isDebugEnabled(), true, "the coordinator takes the root's setting");
		assert.equal(first.options.env?.ATOMIC_DEBUG_SETTING, "0", "a running worker keeps what it started with");
		first.kill("SIGKILL");
		while (forked.length < 2) await delay(5);
		assert.equal(forked[1]!.options.env?.ATOMIC_DEBUG_SETTING, "1", "its replacement starts in debug mode");
		f.notice({ kind: "published", batch: 0, rejected: [] });
		assert.equal(isDebugEnabled(), true, "other notices leave the setting alone");
		f.notice({ kind: "debug", enabled: false });
		assert.equal(isDebugEnabled(), false);
	} finally {
		setDebugSetting(false);
		await f.close();
	}
});

test("a fenced attempt goes back for replay until its child runs out of attempts, then that child fails (#4310)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		const states: string[] = [];
		for (let attempt = 1; attempt <= 3; attempt++) {
			const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
			assert.ok(claimed, `attempt ${attempt} was claimed`);
			assert.equal((await worker.request({ kind: "fenced" })).error, undefined);
			states.push((await f.queue.inspect("root"))[0]!.state);
		}
		assert.deepEqual(states, ["ready", "ready", "failed"], "the third fenced attempt fails the child");
		const failures = f.events.filter((event) => event.kind === "work-failure");
		assert.equal(failures.length, 1, "the child fails once, at its last attempt");
	} finally {
		await f.close();
	}
});

test("a worker that dies holding the last attempt of its child fails only that child (#4310)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		for (let attempt = 1; attempt <= 3; attempt++) {
			const worker = forked.at(-1)!;
			if (attempt > 1) await worker.request({ kind: "ready" });
			assert.ok((await worker.request({ kind: "claim" })).value, `attempt ${attempt} was claimed`);
			worker.kill("SIGKILL");
			if (attempt < 3) while (forked.length < attempt + 1) await delay(5);
		}
		while (!f.events.some((event) => event.kind === "work-failure")) await delay(5);
		assert.equal((await f.queue.inspect("root"))[0]!.state, "failed");
	} finally {
		await f.close();
	}
});

test("a root's pool that closes fails the children it left unfinished (#4310)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		assert.ok((await worker.request({ kind: "claim" })).value);
		await f.command({ kind: "close" });
		assert.deepEqual(
			(await f.queue.inspect("root")).map((work) => work.state),
			["failed"],
			"a child a stopped worker still held is no attempt's any more",
		);
	} finally {
		await f.close();
	}
});

test("a root's pool that closes after the root quit keeps its children for the root's resume (#4310)", async () => {
	const f = await coordinatorFixture({ workers: 1, control: "quit" });
	try {
		await f.command({ kind: "close" });
		assert.deepEqual(
			(await f.queue.inspect("root")).map((work) => work.state),
			["ready"],
		);
	} finally {
		await f.close();
	}
});

test("a root's pool whose lease moved closes without error and leaves its children to the next incarnation (#4310)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		const takeover = await f.journal.takeoverExpired("root", "next-incarnation", LEASE_MS);
		assert.equal(takeover.status, "acquired");
		await f.command({ kind: "close" });
		assert.deepEqual(
			(await f.queue.inspect("root")).map((work) => work.state),
			["ready"],
		);
	} finally {
		await f.close();
	}
});

test("a pool without shared placement claims a bound child like any other, in its recorded directory (#4310)", async () => {
	const binding = { remotes: ["https://example.invalid/r.git"], head: "h", tree: "t", envHash: "e" };
	const execution = { cwd: "/srv/child", workspaceBinding: binding };
	const f = await coordinatorFixture({ workers: 1, execution });
	try {
		const [worker] = f.workers as [FakeWorker];
		// Recovery passes run meanwhile: no claim window applies where no other host serves the pool.
		await delay(1_200);
		const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.deepEqual(claimed.execution, execution);
		const recorded = await worker.request({ kind: "stage-workspace", runId: claimed.childRunId, stageId: "agent" });
		assert.deepEqual(
			[recorded.error, recorded.value],
			[undefined, undefined],
			"only a shared pool records workspaces",
		);
		assert.deepEqual(
			f.events.filter((event) => event.kind === "failure" || event.kind === "work-failure"),
			[],
		);
	} finally {
		await f.close();
	}
});

test("a coordinator that closes before it served any root closes cleanly, and serves none after (#4310)", async () => {
	const coordinator = new PoolCoordinator({
		send: () => {},
		onMessage: () => {},
		onClose: () => {},
		close: async () => {},
	});
	await coordinator.stopSatellite();
	await coordinator.shutdown();
	await assert.rejects(coordinator.attachSatellite({} as never), { message: "Local worker pool is closed" });
});

test("a root's pool without shared placement keeps its budget block to itself, publishing it nowhere (#4310)", async () => {
	const f = await coordinatorFixture({ workers: 1 });
	try {
		f.notice({ kind: "budget", blocked: true });
		f.notice({ kind: "budget", blocked: false });
		await delay(200);
		assert.deepEqual(
			f.events.filter((event) => event.kind === "failure"),
			[],
		);
	} finally {
		await f.close();
	}
});
