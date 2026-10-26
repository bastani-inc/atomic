import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import * as admissionHost from "../../packages/workflows/src/workers/admission-host.js";
import {
	REAP_KILL_GRACE_MS,
	REAP_TERM_GRACE_MS,
	SqlResourceAdmission,
} from "../../packages/workflows/src/workers/resource-admission.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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
			/canonical/,
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
		await assert.rejects(admission.acquire("session"), /Stale/);
		await pool.expire(acquired.lease, work);
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 1);
		await admission.releaseStoppedSessions("worker");
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 1);
		await release();
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
		const rejected = assert.rejects(last, /holder was stopped/);
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
