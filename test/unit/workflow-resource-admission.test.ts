import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test, vi } from "vitest";
import { currentResourceAdmission } from "../../packages/coding-agent/src/core/resource-admission-scope.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { RunOpts } from "../../packages/workflows/src/authoring.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	isAdmissionHolderStoppedError,
	isRetryableWorkflowError,
	QuarantinedCapacityError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { admitWorkflowSessions } from "../../packages/workflows/src/workers/admission-binding.js";
import { isWorkflowAdmissionConfigError } from "../../packages/workflows/src/workers/admission-errors.js";
import * as admissionHost from "../../packages/workflows/src/workers/admission-host.js";
import {
	QUARANTINED_CAPACITY_WAIT_MS,
	REAP_KILL_GRACE_MS,
	REAP_TERM_GRACE_MS,
	RELEASED_PERMIT_RETENTION,
	SqlResourceAdmission,
	STAGE_START_SPACING_MS,
} from "../../packages/workflows/src/workers/resource-admission.js";
import { staleWorkLease } from "../helpers/pool-errors.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

async function fixture() {
	const directory = makeTempDirectory("resource-admission-");
	const path = join(directory, "journal.sqlite");
	const databases = await Promise.all([openNodeSqliteDatabase(path), openNodeSqliteDatabase(path)]);
	const journals = await Promise.all(databases.map((database) => SqlRunJournal.open(database)));
	return {
		path,
		journals,
		databases,
		async close() {
			for (const journal of journals) await journal.close();
			for (const database of databases) await database.close();
			removeTempDirectory(directory);
		},
	};
}

const ADMISSION_OBSERVATION_TIMEOUT_MS = 5_000;
async function waitForReason(admission: SqlResourceAdmission, reason: string): Promise<void> {
	const signal = AbortSignal.timeout(ADMISSION_OBSERVATION_TIMEOUT_MS);
	while (!(await admission.inspect()).some((row) => row.state === "waiting" && row.reason === reason)) {
		signal.throwIfAborted();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

test("persisted pause closes root and worker resource grants before root status changes (#3869)", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "coordinator");
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(acquired.lease, 60_000);
		const item = poolWorkFixture();
		await queue.enqueue(acquired.lease, item.work, item.boundary);
		const work = (await queue.claim(acquired.lease, "worker", [item.work], 60_000))!;
		await queue.setControl(acquired.lease, "paused");
		for (const attempt of [undefined, work]) {
			const admission = await SqlResourceAdmission.open(f.journals[1]!, {
				root: "root",
				holder: "worker",
				attempt,
				limits: { session: 2 },
			});
			const pending = admission.acquire("session");
			await waitForReason(admission, "root paused");
			assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 0);
			await queue.setControl(acquired.lease, "running");
			await (await pending)();
			await queue.setControl(acquired.lease, "paused");
		}
	} finally {
		await f.close();
	}
});

test("independent connections share root/user caps and FIFO cancellation (#3869)", async () => {
	const f = await fixture();
	try {
		const options = { root: "root", limits: { session: 2 }, userLimits: { session: 2 }, userDatabase: f.path };
		const first = await SqlResourceAdmission.open(f.journals[0]!, { ...options, holder: "local" });
		const worker = await SqlResourceAdmission.open(f.journals[1]!, { ...options, holder: "worker" });
		const other = await SqlResourceAdmission.open(f.journals[1]!, {
			...options,
			root: "ordinary",
			holder: "ordinary",
		});
		const release1 = await first.acquire("session");
		const release2 = await worker.acquire("session");
		const cancel = new AbortController();
		const cancelled = worker.acquire("session", cancel.signal);
		await waitForReason(worker, "root:root session");
		cancel.abort(new Error("cancelled waiter"));
		await assert.rejects(cancelled, /cancelled waiter/);
		let granted = false;
		const waiting = other.acquire("session").then((release) => {
			granted = true;
			return release;
		});
		await waitForReason(other, "user session");
		assert.equal(granted, false);
		assert.equal((await first.inspect()).filter((row) => row.state === "granted").length, 2);
		await release1();
		const release3 = await waiting;
		assert.equal((await first.inspect()).filter((row) => row.state === "granted").length, 2);
		await Promise.all([release2(), release2(), release3()]);
		assert.equal((await first.inspect()).filter((row) => row.state === "granted").length, 0);
		await assert.rejects(
			SqlResourceAdmission.open(f.journals[0]!, { ...options, holder: "bad", userDatabase: "elsewhere" }),
			(error: Error) => isWorkflowAdmissionConfigError(error) && error.code === "user-database-mismatch",
		);
		await assert.rejects(
			SqlResourceAdmission.open(f.journals[0]!, { ...options, holder: "bad", userLimits: { session: 3 } }),
			/configuration/,
		);
	} finally {
		await f.close();
	}
});

test("host gates persist a reason and cleanup, not elapsed leases, releases resources (#3869)", async () => {
	const f = await fixture();
	try {
		let memory = 0;
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			limits: { session: 1, process: 1 },
			host: { minFreeMemoryBytes: 100 },
			sampleHost: () => ({ freeMemoryBytes: memory, load: 0 }),
		});
		const pending = admission.acquire("process");
		await waitForReason(admission, "host memory");
		memory = 1000;
		const release = await pending;
		await admission.releaseStoppedSessions("worker");
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 1);
		await release();
		await release();
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 0);
	} finally {
		await f.close();
	}
});

test("pooled stage starts are paced while the host is overloaded, in order, and delegated sessions and processes pass", async () => {
	const f = await fixture();
	try {
		let load = 5;
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			stageStartMaxLoadPerCpu: 3,
			sampleHost: () => ({ freeMemoryBytes: 1 << 30, load }),
		});
		const elapse = () =>
			f.databases[0]!.run("UPDATE wf_runs_resource_permits SET granted_at = granted_at - ?", STAGE_START_SPACING_MS);
		// No stage started lately: the first one starts however busy the host is.
		const first = await admission.acquire("session");
		const second = admission.acquire("session");
		await waitForReason(admission, "paced for host load");
		const third = admission.acquire("session");
		let thirdStarted = false;
		void third.then(() => {
			thirdStarted = true;
		});
		// A stage's delegated session and its tool processes are not stage starts: they are never held for load.
		const delegated = await admission.acquire("session", undefined, { delegated: true });
		const process = await admission.acquire("process");
		// One spacing later the earliest waiting start goes, while the first stage still holds its session.
		await elapse();
		const secondStarted = await second;
		assert.equal(thirdStarted, false, "starts go one per spacing, in the order they asked");
		load = 1;
		const thirdRelease = await third;
		for (const release of [first, secondStarted, thirdRelease, delegated, process]) await release();
	} finally {
		await f.close();
	}
});

test("a running stage's subagents neither delay a paced stage start nor are refused because a start is paced", async () => {
	const f = await fixture();
	try {
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			limits: { session: 10 },
			stageStartMaxLoadPerCpu: 3,
			sampleHost: () => ({ freeMemoryBytes: 1 << 30, load: 5 }),
		});
		const running = await admission.acquire("session");
		const paced = admission.acquire("session");
		let started = false;
		void paced.then(() => {
			started = true;
		});
		await waitForReason(admission, "paced for host load");
		// The running stage starts a subagent: capacity remains, and a stage start being paced does not refuse it.
		const subagent = await admission.acquire("session", undefined, { delegated: true });
		// One spacing after the running stage started, the paced stage starts: the subagent's launch is no stage start.
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_permits SET granted_at = granted_at - ? WHERE ticket = (SELECT MIN(ticket) FROM wf_runs_resource_permits)",
			STAGE_START_SPACING_MS,
		);
		const deadline = Date.now() + ADMISSION_OBSERVATION_TIMEOUT_MS;
		while (!started && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(started, true, "the paced stage started one spacing after the last stage start");
		for (const release of [running, subagent, await paced]) await release();
	} finally {
		await f.close();
	}
});

test("expired work retains live resources and fenced waiters cannot relaunch (#3869)", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "coordinator");
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(acquired.lease, 60_000);
		const fixture = poolWorkFixture();
		await pool.enqueue(acquired.lease, fixture.work, fixture.boundary);
		const work = await pool.claim(acquired.lease, "worker", [fixture.work], 60_000);
		assert.ok(work);
		const admission = await SqlResourceAdmission.open(journal, {
			root: "root",
			holder: "worker",
			attempt: work,
			limits: { process: 1 },
		});
		const release = await admission.acquire("process");
		await f.databases[0]!.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", work.id);
		// A lapsed lease alone is a renewal a busy coordinator has not made yet: the launch waits for it.
		const lapsed = admission.acquire("session");
		const outcome = lapsed.then(
			() => "granted",
			(error: unknown) => error,
		);
		await waitForReason(admission, "waiting for its attempt lease");
		await pool.expire(acquired.lease, work);
		// Only work recovery took from the attempt: that refuses its launch.
		staleWorkLease({ root: "root", workId: work.id, generation: work.generation, reason: "superseded" })(
			await outcome,
		);
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 1);
		await admission.releaseStoppedSessions("worker");
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 1);
		await release();
	} finally {
		await f.close();
	}
});

test("a shared pool releases the session permit of an owner on another host once its attempt is replaced, and only then (#4310)", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "coordinator");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(acquired.lease, 60_000);
		const fixture = poolWorkFixture();
		await pool.enqueue(acquired.lease, fixture.work, fixture.boundary);
		const work = await pool.claim(acquired.lease, "host-a/worker", [fixture.work], 60_000);
		assert.ok(work);
		const options = { root: "root", limits: { session: 1 } };
		const remote = await SqlResourceAdmission.open(journal, {
			...options,
			holder: "host-a/worker",
			attempt: work,
			crossHost: true,
		});
		await remote.acquire("session");
		// Its owner is a process on another host that stopped renewing: this host cannot probe it.
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET host = 'host-a.invalid', expires_at = 0 WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE holder = 'host-a/worker')",
		);
		const granted = async () =>
			(await remote.inspect()).filter((row) => row.kind === "session").map((row) => [row.state, row.reason]);
		const local = await SqlResourceAdmission.open(journal, { ...options, holder: "host-b/worker", crossHost: true });
		await local.reconcile();
		assert.deepEqual(
			await granted(),
			[["granted", "owner expired; cleanup unconfirmed"]],
			"a current attempt keeps it",
		);
		await pool.releaseExited(acquired.lease, work);
		const unshared = await SqlResourceAdmission.open(journal, {
			...options,
			holder: "local",
			rootLimits: "unchanged",
		});
		await unshared.reconcile();
		assert.deepEqual(
			await granted(),
			[["granted", "owner expired; cleanup unconfirmed"]],
			"an admission that is not shared across hosts never releases it",
		);
		await local.reconcile();
		assert.deepEqual(await granted(), [["released", "owner on another host expired; attempt replaced"]]);
		const release = await local.acquire("session");
		await release();
	} finally {
		await f.close();
	}
});

test("a shared pool releases only an expired remote owner's session permits of a replaced attempt (#4310)", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "coordinator");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(acquired.lease, 60_000);
		const fixture = poolWorkFixture();
		await pool.enqueue(acquired.lease, fixture.work, fixture.boundary);
		const work = await pool.claim(acquired.lease, "host-a/worker", [fixture.work], 60_000);
		assert.ok(work);
		const open = (holder: string, attempt?: typeof work) =>
			SqlResourceAdmission.open(journal, {
				root: "root",
				holder,
				limits: { session: 4, process: 4 },
				crossHost: true,
				...(attempt === undefined ? {} : { attempt }),
			});
		// A session permit of the replaced attempt on another host whose owner stopped renewing is released. Kept: a
		// session permit on this host, a process permit and an attempt-less session permit on another host of owners that
		// stopped renewing, and a session permit on another host that is still renewing.
		const replaced = await open("replaced", work);
		await replaced.acquire("session");
		const local = await open("local", work);
		await local.acquire("session");
		const processes = await open("processes", work);
		await processes.acquire("process");
		const unbound = await open("unbound");
		await unbound.acquire("session");
		const live = await open("live", work);
		await live.acquire("session");
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET host = 'host-a.invalid', expires_at = 0 WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE holder IN ('replaced', 'processes', 'unbound'))",
		);
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET expires_at = 0 WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE holder = 'local')",
		);
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET host = 'host-a.invalid' WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE holder = 'live')",
		);
		await pool.releaseExited(acquired.lease, work);
		const observer = await open("observer");
		await observer.reconcile();
		const states = Object.fromEntries(
			(await observer.inspect()).map((permit) => [permit.holder, [permit.kind, permit.state, permit.reason]]),
		);
		assert.deepEqual(states.replaced, ["session", "released", "owner on another host expired; attempt replaced"]);
		assert.deepEqual(
			[states.local, states.processes, states.unbound, states.live].map((state) => state?.slice(0, 2)),
			[
				["session", "granted"],
				["process", "granted"],
				["session", "granted"],
				["session", "granted"],
			],
		);
		// Once the expired owners are marked, nothing is left to fence: a reconcile takes no write lock.
		const storage = sqlPoolStorage(journal)!;
		const { transaction } = storage;
		let transactions = 0;
		Object.assign(storage, {
			transaction: (body: Parameters<typeof transaction>[0]) => {
				transactions++;
				return transaction(body);
			},
		});
		try {
			await observer.reconcile();
		} finally {
			Object.assign(storage, { transaction });
		}
		assert.equal(transactions, 0);
	} finally {
		await f.close();
	}
});

test("a launch whose attempt lease lapsed under load waits for the renewal instead of failing its stage", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "coordinator");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(acquired.lease, 60_000);
		const fixture = poolWorkFixture();
		await pool.enqueue(acquired.lease, fixture.work, fixture.boundary);
		const work = await pool.claim(acquired.lease, "worker", [fixture.work], 60_000);
		assert.ok(work);
		const admission = await SqlResourceAdmission.open(journal, { root: "root", holder: "worker", attempt: work });
		await f.databases[0]!.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", work.id);
		const launch = admission.acquire("session");
		const validated = admission.validate();
		await waitForReason(admission, "waiting for its attempt lease");
		await pool.extend(acquired.lease, work, 60_000);
		const release = await launch;
		await validated;
		await release();
	} finally {
		await f.close();
	}
});

const FENCE_WAITERS =
	"UPDATE wf_runs_resource_permits SET state = 'released', reason = 'abandoned waiter fenced' WHERE state = 'waiting'";

async function rejection(admission: Promise<unknown>): Promise<unknown> {
	return admission.then(
		() => assert.fail("a waiter released for good must not be granted"),
		(caught: unknown) => caught,
	);
}

test("a live waiter fenced after its owner lease lapsed under load rejoins the queue instead of failing (#4179)", async () => {
	const f = await fixture();
	try {
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			limits: { session: 1 },
		});
		const release = await admission.acquire("session");
		const waiter = admission.acquire("session");
		await waitForReason(admission, "root:root session");
		// What another worker's reconcile does to a waiter whose owner lease lapsed while its process stalled.
		await f.databases[1]!.run(FENCE_WAITERS);
		await release();
		const releaseWaiter = await waiter;
		assert.deepEqual(
			(await admission.inspect()).filter((row) => row.state === "granted").map((row) => row.kind),
			["session"],
		);
		await releaseWaiter();
	} finally {
		await f.close();
	}
});

test("forty waiters keep their admissions while their waiting permits are fenced over and over (#4179)", async () => {
	const f = await fixture();
	let fencing = true;
	try {
		const admissions = await Promise.all(
			f.journals.map((journal, index) =>
				SqlResourceAdmission.open(journal, { root: "root", holder: `worker-${index}`, limits: { session: 4 } }),
			),
		);
		const fencer = (async () => {
			while (fencing) {
				await f.databases[1]!.run(FENCE_WAITERS);
				await sleep(5);
			}
		})();
		const outcomes = await Promise.allSettled(
			Array.from({ length: 40 }, async (_, index) => {
				const release = await admissions[index % admissions.length]!.acquire("session");
				await sleep(10);
				await release();
			}),
		);
		fencing = false;
		await fencer;
		assert.deepEqual(
			outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => String(outcome.reason)),
			[],
		);
		assert.equal((await admissions[0]!.inspect()).filter((row) => row.state !== "released").length, 0);
	} finally {
		fencing = false;
		await f.close();
	}
});

test("history pruning keeps a fenced waiter's permit while its owner may be alive, then prunes it (#4179)", async () => {
	const f = await fixture();
	try {
		const admission = await SqlResourceAdmission.open(f.journals[0]!, { root: "root", holder: "worker" });
		const release = await admission.acquire("session");
		const owner = (await admission.inspect())[0]?.owner;
		assert.ok(owner);
		const insert = "INSERT INTO wf_runs_resource_permits(operation, root, holder, kind, state, reason, owner)";
		await f.databases[0]!.run(
			`${insert} VALUES ('fenced-waiter', 'root', 'worker', 'session', 'released', 'abandoned waiter fenced', ?)`,
			owner,
		);
		for (let index = 0; index < RELEASED_PERMIT_RETENTION + 50; index += 1)
			await f.databases[0]!.run(
				`${insert} VALUES (?, 'root', 'other', 'session', 'released', 'resource cleanup confirmed', NULL)`,
				`history-${index}`,
			);
		const fencedWaiter = async () => (await admission.inspect()).some((row) => row.operation === "fenced-waiter");

		await admission.reconcile();
		assert.equal(await fencedWaiter(), true, "kept while its owner's lease is current");
		assert.equal(
			(await admission.inspect()).filter((row) => row.operation.startsWith("history-")).length,
			RELEASED_PERMIT_RETENTION,
		);

		await f.databases[0]!.run("UPDATE wf_runs_resource_owners SET expires_at = 0 WHERE id = ?", owner);
		await admission.reconcile();
		assert.equal(await fencedWaiter(), false, "pruned once its owner has been gone longer than the retention");
		await release();
	} finally {
		await f.close();
	}
});

for (const [label, release, permitReason] of [
	[
		"released for a host reboot",
		"UPDATE wf_runs_resource_permits SET state = 'released', reason = 'host reboot confirmed' WHERE state = 'waiting'",
		"host reboot confirmed",
	],
	["gone from history", "DELETE FROM wf_runs_resource_permits WHERE state = 'waiting'", "permit no longer recorded"],
	[
		"released without a recorded reason",
		"UPDATE wf_runs_resource_permits SET state = 'released', reason = NULL WHERE state = 'waiting'",
		undefined,
	],
] as const) {
	test(`a waiter whose permit was ${label} is refused as a retryable fault of the pool (#4179)`, async () => {
		const f = await fixture();
		try {
			const admission = await SqlResourceAdmission.open(f.journals[0]!, {
				root: "root",
				holder: "worker",
				limits: { session: 1 },
			});
			const releaseHolder = await admission.acquire("session");
			const waiter = admission.acquire("session");
			await waitForReason(admission, "root:root session");
			await f.databases[1]!.run(release);
			const error = await rejection(waiter);
			assert.ok(isAdmissionHolderStoppedError(error), String(error));
			assert.equal(error.code, "stale_work_lease");
			assert.equal(error.permitReason, permitReason);
			assert.ok(isRetryableWorkflowError(error));
			await releaseHolder();
		} finally {
			await f.close();
		}
	});
}

test("a fenced waiter that is then cancelled becomes ordinary history that pruning removes (#4179)", async () => {
	const f = await fixture();
	try {
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			limits: { session: 1 },
		});
		const releaseHolder = await admission.acquire("session");
		const cancel = new AbortController();
		const waiter = admission.acquire("session", cancel.signal);
		await waitForReason(admission, "root:root session");
		const operation = (await admission.inspect()).find((row) => row.state === "waiting")?.operation;
		assert.ok(operation);
		await f.databases[1]!.run(FENCE_WAITERS);
		cancel.abort();
		await assert.rejects(waiter);
		const reason = async () => (await admission.inspect()).find((row) => row.operation === operation)?.reason;
		assert.equal(await reason(), "launch cancelled or refused");

		// The same owner keeps renewing (it admits more work), and history grows past the retention.
		await (await admission.acquire("process"))();
		const insert = "INSERT INTO wf_runs_resource_permits(operation, root, holder, kind, state, reason, owner)";
		for (let index = 0; index <= RELEASED_PERMIT_RETENTION; index += 1)
			await f.databases[0]!.run(
				`${insert} VALUES (?, 'root', 'other', 'session', 'released', 'resource cleanup confirmed', NULL)`,
				`history-${index}`,
			);
		await admission.reconcile();
		assert.equal(await reason(), undefined, "pruned like any other finished permit");
		await releaseHolder();
	} finally {
		await f.close();
	}
});

test("stopping a holder whose waiter was just fenced for a lapsed owner lease keeps that waiter refused (#4179)", async () => {
	const f = await fixture();
	try {
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			limits: { session: 1 },
		});
		const releaseHolder = await admission.acquire("session");
		const waiter = admission.acquire("session");
		await waitForReason(admission, "root:root session");
		const pool = await SqlResourceAdmission.open(f.journals[1]!, { root: "root", holder: "coordinator" });
		// The stop's own reconcile can fence the waiter first, when its owner lease lapsed; the stop must still hold.
		await f.databases[1]!.run(FENCE_WAITERS);
		await pool.releaseStoppedSessions("worker");
		await releaseHolder();
		const error = await rejection(waiter);
		assert.ok(isAdmissionHolderStoppedError(error), String(error));
		assert.equal(error.code, "stale_work_lease");
		assert.equal(error.permitReason, "worker exit confirmed");
		assert.ok(isRetryableWorkflowError(error));
	} finally {
		await f.close();
	}
});

test("FIFO grants follow tickets and stopped waiters never reacquire (#3869)", async () => {
	const f = await fixture();
	try {
		const admission = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "worker",
			limits: { session: 1 },
		});
		const release = await admission.acquire("session");
		const next = admission.acquire("session");
		await waitForReason(admission, "root:root session");
		const other = await SqlResourceAdmission.open(f.journals[1]!, {
			root: "root",
			holder: "other",
			limits: { session: 1 },
		});
		const last = other.acquire("session");
		await waitForReason(other, "root:root session");
		await release();
		const releaseNext = await next;
		assert.equal((await other.inspect()).filter((row) => row.state === "waiting").length, 1);
		const rejected = assert.rejects(last, (error) => {
			assert.ok(isAdmissionHolderStoppedError(error), String(error));
			assert.equal(error.code, "stale_work_lease");
			return true;
		});
		await other.releaseStoppedSessions("other");
		await rejected;
		await releaseNext();
		assert.equal((await other.inspect()).filter((row) => row.state === "granted").length, 0);
	} finally {
		await f.close();
	}
});

test("a confirmed host reboot releases orphan process permits but expiry alone cannot (#3869)", async () => {
	const f = await fixture();
	const boot = vi.spyOn(admissionHost, "admissionBootIdentity").mockResolvedValue("old-boot");
	try {
		const before = await SqlResourceAdmission.open(f.journals[0]!, {
			root: "root",
			holder: "before",
			limits: { process: 1 },
		});
		await before.acquire("process");
		boot.mockResolvedValue("new-boot");
		const after = await SqlResourceAdmission.open(f.journals[1]!, {
			root: "root",
			holder: "after",
			limits: { process: 1 },
		});
		assert.equal((await after.inspect()).filter((row) => row.state === "granted").length, 0);
		const release = await after.acquire("process", AbortSignal.timeout(1000));
		await release();
	} finally {
		boot.mockRestore();
		await f.close();
	}
});

test.skipIf(process.platform === "win32")(
	"pool admission without limits still holds a worker's live process group until it stops (#3887)",
	async () => {
		const f = await fixture();
		const group = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
		const exited = once(group, "exit");
		try {
			const admission = await SqlResourceAdmission.open(f.journals[0]!, { root: "root", holder: "worker" });
			const release = await admission.acquire("process");
			assert.ok(release.bindProcess, "a limit-less permit still binds the launched process group");
			await release.bindProcess({ kind: "unix-process-group", id: group.pid! });
			assert.equal(await admission.releaseStoppedSessions("worker"), 1, "a live group is quarantined");
			process.kill(-group.pid!, "SIGKILL");
			await exited;
			await admission.reconcile();
			assert.deepEqual(
				(await admission.inspect()).map((row) => [row.state, row.reason]),
				[["released", "process group cleanup confirmed"]],
			);
		} finally {
			if (group.exitCode === null && group.signalCode === null) {
				group.kill("SIGKILL");
				await exited;
			}
			await f.close();
		}
	},
);

async function boundProcessPermit(f: Awaited<ReturnType<typeof fixture>>, group: number) {
	const admission = await SqlResourceAdmission.open(f.journals[0]!, { root: "root", holder: "worker" });
	const release = await admission.acquire("process");
	await release.bindProcess!({ kind: "unix-process-group", id: group });
	return admission;
}

test.skipIf(process.platform === "win32")(
	"reaping a group that never disappears escalates SIGTERM to SIGKILL, gives up after a bounded wait and keeps its permit quarantined (#3986)",
	async () => {
		const f = await fixture();
		const group = 2_147_000_001;
		const signals: [number, NodeJS.Signals][] = [];
		const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("alive");
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation((target, name) => {
			signals.push([target, name]);
		});
		try {
			const admission = await boundProcessPermit(f, group);
			vi.useFakeTimers({ toFake: ["setTimeout"] });
			let settled = false;
			const reaping = admission.reapStoppedProcesses("worker").finally(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(REAP_TERM_GRACE_MS - 1);
			assert.deepEqual(signals, [[group, "SIGTERM"]], "SIGKILL waits for the SIGTERM grace");
			await vi.advanceTimersByTimeAsync(1);
			assert.deepEqual(signals, [
				[group, "SIGTERM"],
				[group, "SIGKILL"],
			]);
			await vi.advanceTimersByTimeAsync(REAP_KILL_GRACE_MS - 1);
			assert.equal(settled, false, "the reap waits out the SIGKILL grace");
			await vi.advanceTimersByTimeAsync(1);
			assert.deepEqual(await reaping, [group], "the surviving group is reported");
			vi.useRealTimers();
			assert.deepEqual(
				(await admission.inspect()).map((row) => row.state),
				["granted"],
				"the permit of a live group stays quarantined",
			);
		} finally {
			vi.useRealTimers();
			probe.mockRestore();
			signal.mockRestore();
			await f.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a reaped group holding only zombies releases its permit without waiting (#3986)",
	async () => {
		const f = await fixture();
		const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("zombie");
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
		const pause = vi.spyOn(admissionHost, "reapPause");
		try {
			const admission = await boundProcessPermit(f, 2_147_000_002);
			assert.deepEqual(await admission.reapStoppedProcesses("worker"), []);
			assert.equal(signal.mock.calls.length, 0, "zombies hold no resources and need no signal");
			assert.equal(pause.mock.calls.length, 0);
			assert.deepEqual(
				(await admission.inspect()).map((row) => [row.state, row.reason]),
				[["released", "process group cleanup confirmed"]],
			);
		} finally {
			probe.mockRestore();
			signal.mockRestore();
			pause.mockRestore();
			await f.close();
		}
	},
);

/** A detached `sleep` process group the kernel reports as existing until the test kills it. */
function liveGroup() {
	const leader = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	const exited = once(leader, "exit");
	return {
		group: leader.pid!,
		async kill() {
			if (leader.exitCode === null && leader.signalCode === null) {
				process.kill(-leader.pid!, "SIGKILL");
				await exited;
			}
		},
	};
}

const scanOf =
	(...scans: admissionHost.ProcessGroupScan[]): admissionHost.ProcessGroupScanner =>
	() =>
		scans.shift() ?? { members: new Map(), complete: false };

test.skipIf(process.platform === "win32")(
	"a live process group counts as only zombies only after two complete, identical, non-empty all-zombie scans (#3986)",
	async () => {
		const live = liveGroup();
		try {
			const zombies = { members: new Map([[live.group, "Z"]]), complete: true };
			const cases: [string, admissionHost.ProcessGroupScanner, admissionHost.ProcessGroupState][] = [
				["an empty scan", scanOf({ members: new Map(), complete: true }), "alive"],
				["a scan with a read failure", scanOf({ members: new Map([[live.group, "Z"]]), complete: false }), "alive"],
				[
					"a second scan that finds a member forked during the first",
					scanOf(zombies, { members: new Map([...zombies.members, [live.group + 1, "S"]]), complete: true }),
					"alive",
				],
				[
					"a second scan that changes members",
					scanOf(zombies, { members: new Map([[1, "Z"]]), complete: true }),
					"alive",
				],
				["two stable all-zombie scans", scanOf(zombies, zombies), "zombie"],
			];
			for (const [name, scan, expected] of cases)
				assert.equal(admissionHost.processGroupState(live.group, scan), expected, name);
			await live.kill();
			assert.equal(
				admissionHost.processGroupState(live.group, scanOf()),
				"gone",
				"the kernel alone reports a group gone",
			);
		} finally {
			await live.kill();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"an empty process scan of a live group never releases its permit (#3986)",
	async () => {
		const f = await fixture();
		const live = liveGroup();
		const scanProbe = admissionHost.processGroupState;
		// The kernel still reports the group, but every scan of the process table comes back empty.
		const probe = vi
			.spyOn(admissionHost, "processGroupState")
			.mockImplementation((group) => scanProbe(group, () => ({ members: new Map(), complete: true })));
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
		const pause = vi.spyOn(admissionHost, "reapPause").mockResolvedValue();
		try {
			const admission = await boundProcessPermit(f, live.group);
			assert.deepEqual(await admission.reapStoppedProcesses("worker"), [live.group]);
			assert.deepEqual(
				(await admission.inspect()).map((row) => row.state),
				["granted"],
				"the live group's permit stays quarantined",
			);
		} finally {
			probe.mockRestore();
			signal.mockRestore();
			pause.mockRestore();
			await live.kill();
			await f.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a process admission that only quarantined permits block is refused after a bound, while one blocked by live work keeps waiting",
	async () => {
		const f = await fixture();
		const live = liveGroup();
		const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("alive");
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
		const pause = vi.spyOn(admissionHost, "reapPause").mockResolvedValue();
		const limits = { process: 1 };
		try {
			// Root "root": an exited worker's permit, whose group survives its reap, fills the root's limit.
			const worker = await SqlResourceAdmission.open(f.journals[0]!, { root: "root", holder: "worker", limits });
			const orphan = await worker.acquire("process");
			await orphan.bindProcess!({ kind: "unix-process-group", id: live.group });
			assert.equal(await worker.releaseStoppedSessions("worker"), 1);
			assert.deepEqual(await worker.reapStoppedProcesses("worker"), [live.group]);
			// Root "other": live work holds the root's only permit.
			const busy = await SqlResourceAdmission.open(f.journals[1]!, { root: "other", holder: "busy", limits });
			const held = await busy.acquire("process");
			// Only the clock the bound reads is faked; the admissions poll the journal in real time.
			vi.useFakeTimers({ toFake: ["performance"] });
			// The clock is far from its origin before the wait begins: the bound counts from the wait's own start.
			await vi.advanceTimersByTimeAsync(5 * QUARANTINED_CAPACITY_WAIT_MS);
			const replay = await SqlResourceAdmission.open(f.journals[1]!, { root: "root", holder: "replay", limits });
			const waiter = await SqlResourceAdmission.open(f.journals[0]!, { root: "other", holder: "waiter", limits });
			const refusal = replay.acquire("process").then(
				(): Error => assert.fail("capacity that only a quarantined permit holds was granted"),
				(error: Error) => error,
			);
			let refused = false;
			void refusal.finally(() => {
				refused = true;
			});
			let granted = false;
			const waiting = waiter.acquire("process").then((release) => {
				granted = true;
				return release;
			});
			await waitForReason(replay, "root:root process");
			await waitForReason(waiter, "root:other process");
			await sleep(200);
			await vi.advanceTimersByTimeAsync(QUARANTINED_CAPACITY_WAIT_MS - 1_000);
			await sleep(300);
			assert.equal(refused, false, "the admission waits out the bound for the quarantined group to exit");
			await vi.advanceTimersByTimeAsync(1_000);
			const error = await refusal;
			assert.ok(error instanceof QuarantinedCapacityError, String(error));
			assert.equal(error.code, "worker_cleanup_unconfirmed");
			assert.ok(isRetryableWorkflowError(error));
			assert.deepEqual(error.limits, ["admission.limits.process (1)"]);
			assert.deepEqual(error.processGroups, [live.group]);
			assert.ok(error.waitedMs >= QUARANTINED_CAPACITY_WAIT_MS, String(error.waitedMs));
			assert.ok(
				error.waitedMs < 2 * QUARANTINED_CAPACITY_WAIT_MS,
				`waited ${error.waitedMs} ms, not since a far start`,
			);
			await vi.advanceTimersByTimeAsync(10 * QUARANTINED_CAPACITY_WAIT_MS);
			await sleep(300);
			assert.equal(granted, false, "capacity held by live work is waited for past the bound");
			const permits = await worker.inspect();
			assert.deepEqual(
				permits.filter((row) => row.state !== "released").map((row) => [row.holder, row.state, row.reason]),
				[
					["worker", "granted", "cleanup unconfirmed; permit quarantined"],
					["busy", "granted", null],
					["waiter", "waiting", "root:other process"],
				],
				"the quarantined permit keeps its capacity, and the refused admission holds none",
			);
			// The reconcile a later admission runs keeps the quarantined permit's reason.
			await worker.reconcile();
			assert.equal(
				(await worker.inspect()).find((row) => row.holder === "worker")?.reason,
				"cleanup unconfirmed; permit quarantined",
			);
			await held();
			await (await waiting)();
		} finally {
			vi.useRealTimers();
			probe.mockRestore();
			signal.mockRestore();
			pause.mockRestore();
			await live.kill();
			await f.close();
		}
	},
);

test("only a cross-host admission releases another host's expired permits of a replaced attempt; a current attempt's stay (#4310)", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "coordinator");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(acquired.lease, 60_000);
		const first = poolWorkFixture("first");
		const second = poolWorkFixture("second");
		await pool.enqueue(acquired.lease, first.work, first.boundary);
		await pool.enqueue(acquired.lease, second.work, second.boundary);
		const replacedWork = await pool.claim(acquired.lease, "host-a/worker-1", [first.work, second.work], 60_000);
		const currentWork = await pool.claim(acquired.lease, "host-a/worker-2", [first.work, second.work], 60_000);
		assert.ok(replacedWork && currentWork);
		const open = (holder: string, crossHost: boolean, attempt?: typeof replacedWork) =>
			SqlResourceAdmission.open(journal, {
				root: "root",
				holder,
				limits: { session: 4, process: 4 },
				...(crossHost ? { crossHost: true } : {}),
				...(attempt === undefined ? {} : { attempt }),
			});
		await (await open("replaced", true, replacedWork)).acquire("session");
		await (await open("current", true, currentWork)).acquire("session");
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET host = 'host-a.invalid', expires_at = 0 WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE holder IN ('replaced', 'current'))",
		);
		await pool.releaseExited(acquired.lease, replacedWork);
		const states = async (observer: SqlResourceAdmission) =>
			Object.fromEntries((await observer.inspect()).map((permit) => [permit.holder, permit.state]));
		const local = await open("local-observer", false);
		await local.reconcile();
		assert.deepEqual(
			await states(local),
			{ replaced: "granted", current: "granted" },
			"one host's pool never releases them",
		);
		const cross = await open("cross-observer", true);
		await cross.reconcile();
		assert.deepEqual(await states(cross), { replaced: "released", current: "granted" });
		const storage = sqlPoolStorage(journal)!;
		const { transaction } = storage;
		let transactions = 0;
		Object.assign(storage, {
			transaction: (body: Parameters<typeof transaction>[0]) => {
				transactions++;
				return transaction(body);
			},
		});
		try {
			await cross.reconcile();
		} finally {
			Object.assign(storage, { transaction });
		}
		assert.equal(transactions, 0, "a current attempt's expired permit needs no fencing");
	} finally {
		await f.close();
	}
});

test("a shared root's own sessions are released by another host once the root resumed there under a newer epoch (#4310)", async () => {
	const f = await fixture();
	try {
		const journal = f.journals[0]!;
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const first = await journal.acquire("root", "incarnation-1");
		if (first.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(first.lease, 60_000);
		const roots = await SqlResourceAdmission.open(journal, {
			root: "root",
			holder: "root-sessions",
			limits: { session: 2, process: 2 },
			crossHost: true,
			rootEpoch: first.lease.epoch,
		});
		await roots.acquire("session");
		// The root's host stops renewing: its owner is on another host and expired.
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET host = 'host-a.invalid', expires_at = 0 WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE holder = 'root-sessions')",
		);
		const observer = await SqlResourceAdmission.open(journal, {
			root: "root",
			holder: "observer",
			limits: { session: 2, process: 2 },
			crossHost: true,
		});
		const state = async () =>
			(await observer.inspect()).filter((permit) => permit.holder === "root-sessions").map((permit) => permit.state);
		await observer.reconcile();
		assert.deepEqual(await state(), ["granted"], "the root still holds its lease: its sessions may still run");
		const resumed = await journal.takeover("root", "incarnation-2", first.lease.holderId);
		assert.equal(resumed.status, "acquired");
		await observer.reconcile();
		const [permit] = (await observer.inspect()).filter((entry) => entry.holder === "root-sessions");
		assert.deepEqual(
			[permit?.state, permit?.reason],
			["released", "owner on another host expired; root resumed elsewhere"],
		);
	} finally {
		await f.close();
	}
});

test("a shared root admits its sessions on a brand-new journal, before its pool's tables exist (#4310)", async () => {
	const f = await fixture();
	const journal = f.journals[0]!;
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const lease = await journal.acquire("root", "incarnation-1");
		if (lease.status !== "acquired") assert.fail("no lease");
		const tables = () =>
			f.databases[0]!.all<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wf_runs_work'",
			);
		assert.deepEqual(await tables(), [], "no pool ever ran on this journal");
		const result = await admitWorkflowSessions(
			backend,
			{ runId: "root", workers: { placement: "shared" }, admission: { limits: { session: 8, process: 8 } } },
			async () => {
				await currentResourceAdmission()!.acquire("session");
				return { runId: "root", status: "completed", stages: [], toolNodes: [] };
			},
		);
		assert.equal(result.status, "completed");
		const [permit] = await f.databases[0]!.all<{ root_epoch: number | null }>(
			"SELECT root_epoch FROM wf_runs_resource_permits",
		);
		assert.equal(permit?.root_epoch, lease.lease.epoch, "the session was admitted across hosts");
	} finally {
		await backend.close();
		await f.close();
	}
});

test("a shared root's sessions carry its lease epoch, so its resume on another host gets their capacity back (#4310)", async () => {
	const f = await fixture();
	const journal = f.journals[0]!;
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const first = await journal.acquire("root", "incarnation-1");
		if (first.status !== "acquired") assert.fail("no lease");
		await (await openSqlPoolQueue(journal)).initialize(first.lease, 60_000);
		const admitSession = (opts: Pick<RunOpts, "workers" | "parentRun"> & { runId: string }) =>
			admitWorkflowSessions(backend, { ...opts, admission: { limits: { session: 8, process: 8 } } }, async () => {
				await currentResourceAdmission()!.acquire("session");
				return { runId: opts.runId, status: "completed", stages: [], toolNodes: [] };
			});
		const permits = () =>
			f.databases[0]!.all<{ root: string; root_epoch: number | null; state: string; reason: string | null }>(
				"SELECT root, root_epoch, state, reason FROM wf_runs_resource_permits ORDER BY ticket",
			);
		// A shared child, even one holding a lease of its own, never marks the root's sessions.
		await journal.createRun({ runId: "child", name: "child", cwd: "", createdAt: 0, status: "running" });
		if ((await journal.acquire("child", "child-owner")).status !== "acquired") assert.fail("no child lease");
		await admitSession({ runId: "root", workers: { placement: "shared" } });
		await admitSession({ runId: "root" });
		await admitSession({
			runId: "child",
			workers: { placement: "shared" },
			parentRun: { runId: "root", stageId: "stage", rootRunId: "root" },
		});
		await admitSession({ runId: "unleased", workers: { placement: "shared" } });
		assert.deepEqual(
			(await permits()).map((permit) => [permit.root, permit.root_epoch]),
			[
				["root", first.lease.epoch],
				["root", null],
				["root", null],
				["unleased", null],
			],
			"only a shared root holding its lease marks its own sessions",
		);
		await f.databases[0]!.run(
			"UPDATE wf_runs_resource_owners SET host = 'host-a.invalid', expires_at = 0 WHERE id IN (SELECT owner FROM wf_runs_resource_permits WHERE root_epoch IS NOT NULL)",
		);
		const resumed = await journal.takeover("root", "incarnation-2", first.lease.holderId);
		if (resumed.status !== "acquired") assert.fail("no takeover");
		await admitSession({ runId: "root", workers: { placement: "shared" } });
		const [moved, ...rest] = await permits();
		assert.deepEqual(
			[moved?.state, moved?.reason],
			["released", "owner on another host expired; root resumed elsewhere"],
		);
		assert.deepEqual(
			rest.map((permit) => [permit.root_epoch, permit.state]),
			[
				[null, "granted"],
				[null, "granted"],
				[null, "granted"],
				[resumed.lease.epoch, "granted"],
			],
		);
	} finally {
		await backend.close();
		await f.close();
	}
});
