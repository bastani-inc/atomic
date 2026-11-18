import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { FLEET_RATE_STORE_TIMEOUT_MS } from "../../packages/workflows/src/workers/fleet-rate-limits.js";
import { fileExists, makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * Fleet-wide model rate limits across hosts (#4768): each host is a process of its own, as a pool's hosts are, that
 * calls a fake provider through Atomic's request admission while the shared journal (a SQLite file here, which every
 * process opens) meters the calls and carries their 429 cooldowns.
 */

const host = fileURLToPath(new URL("../fixtures/fleet-rate-host.mjs", import.meta.url));
/** A host process loads Atomic's sources through jiti before it calls: a structural cost, on top of its run. */
const HOST_RUN_TIMEOUT_MS = 90_000;
/** The store deadline plus half a deadline for admission overhead; a peer timer tests ordering despite scheduling lag. */
const FALLBACK_DEADLINE_TIMER_MS = FLEET_RATE_STORE_TIMEOUT_MS * 1.5;

interface HostRun {
	readonly calls: readonly { readonly at: number; readonly status: number }[];
	readonly modes: readonly string[];
	readonly waits: readonly number[];
	readonly overdueRequests: number;
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function fleet() {
	const directory = makeTempDirectory("fleet-rate-int-");
	directories.push(directory);
	const path = join(directory, "journal.sqlite");
	// The journal exists, with its bucket table, before any host opens it.
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await SqlRateBuckets.open(journal);
	await journal.close();
	// Windows refuses to remove a database file a connection still holds.
	await database.close();
	let next = 0;
	return {
		path,
		/** Starts a host; resolves with what it recorded once it exits. */
		start(env: Record<string, string>): { readonly ready: string; readonly done: Promise<HostRun> } {
			const id = next++;
			const out = join(directory, `host-${id}.json`);
			const ready = join(directory, `host-${id}.ready`);
			const child = spawn(process.execPath, [host], {
				env: { ...process.env, JOURNAL_PATH: path, OUT: out, READY: ready, ...env },
				stdio: ["ignore", "inherit", "inherit"],
			});
			const done = new Promise<HostRun>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => {
					if (code !== 0) reject(new Error(`host ${id} exited ${code}`));
					else resolve(readJson<HostRun>(out));
				});
			});
			return { ready, done };
		},
	};
}

async function until(path: string): Promise<void> {
	while (!(await fileExists(path))) await sleep(20);
}

test(
	"a 429 one host gets holds every host's calls until its cooldown ends (#4768)",
	async () => {
		const f = await fleet();
		const limits = { RPM: "60000", BURST: "100", PACE_MS: "50" };
		const b = f.start({ ...limits, DURATION_MS: "7000" });
		await until(b.ready);
		const a = f.start({ ...limits, DURATION_MS: "4000", FAIL_AT: "3", RETRY_AFTER_S: "2" });
		const [runA, runB] = await Promise.all([a.done, b.done]);
		const limited = runA.calls.find((call) => call.status === 429);
		assert.ok(limited !== undefined, "host A was rate limited");
		const until_ = limited.at + 2_000;
		const hosts: readonly (readonly [string, HostRun])[] = [
			["A", runA],
			["B", runB],
		];
		for (const [name, run] of hosts) {
			// B learns the cooldown from the journal: through its next acquire, or its poll, within a few hundred ms.
			const during: HostRun["calls"] = run.calls.filter(
				(call) => call.at > limited.at + 400 && call.at < until_ - 50,
			);
			assert.deepEqual(during, [], `host ${name} called during the shared cooldown`);
			assert.ok(
				run.calls.some((call) => call.at >= until_ - 50),
				`host ${name} resumed once the cooldown ended`,
			);
		}
		assert.ok(
			runB.calls.some((call) => call.at > limited.at && call.at < limited.at + 400) ||
				runB.calls.some((call) => call.at < limited.at),
			"host B was calling while A hit the limit",
		);
	},
	HOST_RUN_TIMEOUT_MS,
);

test(
	"two hosts calling as fast as they can share one rate: never more than the burst plus the rate's tokens (#4768)",
	async () => {
		const f = await fleet();
		const limits = { RPM: "600", BURST: "2", PACE_MS: "0", DURATION_MS: "3000" };
		const a = f.start(limits);
		const b = f.start(limits);
		const runs = await Promise.all([a.done, b.done]);
		const calls = runs.flatMap((run) => run.calls);
		const first = Math.min(...calls.map((call) => call.at));
		const last = Math.max(...calls.map((call) => call.at));
		const allowed = 2 + Math.ceil(((last - first) / 1_000) * 10);
		assert.ok(calls.length <= allowed + 1, `${calls.length} calls in ${last - first} ms, at most ${allowed} allowed`);
		// Both hosts got their turn, and the fleet was not starved.
		for (const run of runs) assert.ok(run.calls.length >= 5, String(run.calls.length));
		assert.ok(calls.length >= allowed / 2, `${calls.length} of ${allowed}`);
	},
	HOST_RUN_TIMEOUT_MS,
);

test(
	"while the journal does not answer, calls fall back to a local bucket within a second, and go back to it once it does (#4768, #5520)",
	async () => {
		const f = await fleet();
		const run = f.start({
			RPM: "600",
			BURST: "2",
			PACE_MS: "50",
			DURATION_MS: "6000",
			RETRY_STORE_MS: "300",
			WAIT_DEADLINE_MS: String(FALLBACK_DEADLINE_TIMER_MS),
		});
		await until(run.ready);
		// Holding the journal's write lock stands for a store that stopped answering.
		const lock = new DatabaseSync(f.path);
		lock.exec("PRAGMA busy_timeout = 10000");
		lock.exec("BEGIN IMMEDIATE");
		await sleep(2_500);
		lock.exec("COMMIT");
		lock.close();
		const { modes, waits, overdueRequests } = await run.done;
		assert.ok(modes.includes("local-fallback"), "the host fell back while the journal held its lock");
		assert.equal(modes.at(-1), "store", "the host went back to the journal once it answered");
		assert.equal(
			overdueRequests,
			0,
			`a call outlived its ${FALLBACK_DEADLINE_TIMER_MS} ms deadline timer; wall waits: ${waits.join(", ")}`,
		);
	},
	HOST_RUN_TIMEOUT_MS,
);
