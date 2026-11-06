import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SqliteRow } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const worker = fileURLToPath(new URL("../fixtures/shared-pool-chaos-worker.mjs", import.meta.url));
const skewedClock = pathToFileURL(fileURLToPath(new URL("../fixtures/skewed-clock.mjs", import.meta.url))).href;
const PREFIX = "chaos_";
/** Concurrent writers: one attempt per process, every one writing the same database. Crabbox runs raise it. */
const WORKERS = Number(process.env.ATOMIC_CHAOS_WORKERS ?? "6");
const STAGES = 3;
const INPUTS = 8;
/** A stage lease short enough that a displaced holder's inputs are taken over within the test. */
const STAGE_LEASE_MS = 1_500;
/** The stage lease the stopped worker holds: long enough that its replacement is sure to find the stage held. */
const HELD_STAGE_LEASE_MS = 12_000;
/** Each worker process loads the workflow sources through jiti; this bounds the whole test. */
const CHAOS_TIMEOUT_MS = 240_000;
const definition = { definition: "fixture/child", digest: "sha256:child" };

type Row = SqliteRow;

function lines(log: string, pid: number): string[][] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" "))
		.filter((fields) => Number(fields.at(-2)) === pid);
}

test.skipIf(process.platform === "win32")(
	"stage inputs survive SIGKILL, SIGSTOP and clock skew under many concurrent writers: each is acknowledged once, in order, and a displaced worker writes nothing (#4310)",
	async () => {
		const directory = makeTempDirectory("shared-pool-chaos-");
		const url = pathToFileURL(join(directory, "shared.db")).href;
		const log = join(directory, "chaos.log");
		const database = await openLibsqlDatabase({ url });
		const journal = await SqlRunJournal.open(database, { prefix: PREFIX });
		const deadline = Date.now() + CHAOS_TIMEOUT_MS - 30_000;
		const running = new Set<BudgetedProcess>();
		let renewal: NodeJS.Timeout | undefined;
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "chaos-root");
			if (acquired.status !== "acquired") assert.fail("the root holds no lease");
			const lease: Lease = acquired.lease;
			renewal = setInterval(() => void journal.renew(lease).catch(() => {}), 1_000);
			const queue = await openSqlPoolQueue(journal);
			await queue.initialize(lease, 60_000);
			const shared = await SqlSharedPool.open(journal, queue);
			const attempts: PoolWork[] = [];
			for (let index = 0; index < WORKERS; index++) {
				const { work, boundary } = poolWorkFixture(`work${index}`);
				await queue.enqueue(lease, work, boundary);
				const held = await queue.claim(lease, `chaos/${index}-a`, [definition], 120_000);
				assert.ok(held);
				attempts.push(held);
				for (let stage = 0; stage < STAGES; stage++)
					for (let seq = 0; seq < INPUTS; seq++)
						await shared.appendStageInput(lease, {
							work: held.id,
							runId: held.childRunId,
							stageId: `stage${stage}`,
							kind: "user-message",
							op: `${stage}:${seq}`,
							payload: JSON.stringify({ deliveryOp: `${stage}:${seq}`, text: `${seq}`, intent: "followUp" }),
						});
			}
			const spawn = (
				attempt: PoolWork,
				env: Record<string, string> = {},
				processMs = 30,
				leaseMs = STAGE_LEASE_MS,
			) => {
				const child = spawnWithinBudget(
					[
						process.execPath,
						...(env.SKEWED_CLOCK_MS === undefined ? [] : ["--import", skewedClock]),
						worker,
						url,
						PREFIX,
						"root",
						JSON.stringify({
							id: attempt.id,
							generation: attempt.generation,
							worker: attempt.worker,
							epoch: attempt.epoch,
						}),
						log,
						String(leaseMs),
						String(processMs),
					],
					{ cwd: directory, stdout: "ignore", env: { ...process.env, ...env } },
					deadline,
				);
				running.add(child);
				return child;
			};
			const acked = (pid: number) => lines(log, pid).filter((fields) => fields[0] === "acked").length;
			const took = (pid: number) => lines(log, pid).filter((fields) => fields[0] === "took");
			const until = async (what: string, check: () => boolean) => {
				while (!check()) {
					if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
					await sleep(20);
				}
			};
			// Worker 1 is stopped mid-input, holding a long stage lease its replacement has to wait out.
			const children = attempts.map((attempt, index) =>
				index === 1 ? spawn(attempt, {}, 400, HELD_STAGE_LEASE_MS) : spawn(attempt),
			);
			// The attempt replaced while it holds a stage: its worker is stopped mid-input, after it took the input.
			const stopped = children[1]!;
			const stoppedPid = stopped.process.pid!;
			await until("the stopped worker's first input", () => {
				try {
					return took(stoppedPid).length > acked(stoppedPid);
				} catch {
					return false;
				}
			});
			stopped.process.kill("SIGSTOP");
			const inFlight = took(stoppedPid).at(-1)!;
			// Killed workers: SIGKILL wherever they are, mid-transaction or not.
			const killed = children.slice(2, 4);
			for (const child of killed) {
				await until("a killed worker's progress", () => {
					try {
						return acked(child.process.pid!) >= 2;
					} catch {
						return false;
					}
				});
				child.process.kill("SIGKILL");
				await child.process.exited;
				running.delete(child);
			}
			// Recovery: each lost attempt is released and claimed again by a replacement, one of them with its clock an
			// hour fast, which must not let it take a stage another holder's lease still covers.
			const replacements: { child: BudgetedProcess; attempt: PoolWork; skewed: boolean }[] = [];
			for (const index of [1, 2, 3]) {
				assert.equal(await queue.releaseExited(lease, attempts[index]!), true);
				const replacement = (await queue.claim(lease, `chaos/${index}-b`, [definition], 120_000, {
					kind: "work",
					id: attempts[index]!.id,
					generation: attempts[index]!.generation,
				}))!;
				assert.ok(replacement, "the released work is claimed again");
				const skewed = index === 1;
				replacements.push({
					attempt: replacement,
					skewed,
					child: spawn(replacement, skewed ? { SKEWED_CLOCK_MS: String(60 * 60_000) } : {}),
				});
			}
			for (const { child } of replacements) await expectExitedCleanly(child);
			// The stopped worker wakes up holding an input its attempt lost: its acknowledgement is refused.
			stopped.process.kill("SIGCONT");
			await expectExitedCleanly(stopped);
			for (const child of children)
				if (!killed.includes(child) && child !== stopped) await expectExitedCleanly(child);
			running.clear();
			const refusal = lines(log, stoppedPid).find((fields) => fields[0] === "refused");
			assert.ok(refusal, "the displaced worker's write was refused");
			assert.deepEqual(refusal.slice(1, 3), ["stale-stage-lease", "attempt-replaced"]);
			// Its input was taken over only once its stage lease expired by the database's clock, even by a worker whose
			// clock ran an hour ahead: that worker found the stage held at least once before it took it.
			const skewedPid = replacements.find((replacement) => replacement.skewed)!.child.process.pid!;
			const declined = lines(log, skewedPid).filter(
				(fields) => fields[0] === "declined" && fields[2] === inFlight[2],
			).length;
			assert.ok(declined > 0, "the skewed worker waited for the stopped holder's stage lease");

			const inputs = await database.all<Row>(
				`SELECT work, stage_id, seq, state, receipt, settled_at FROM ${PREFIX}wf_runs_stage_inputs ORDER BY work, stage_id, seq`,
			);
			assert.equal(inputs.length, WORKERS * STAGES * INPUTS);
			assert.deepEqual(
				inputs.filter((input) => input.state !== "done"),
				[],
				"no input was lost",
			);
			// Acknowledged once each, in each stage's order: no input was acknowledged by two processes. A process killed
			// between its acknowledgement and its log line leaves one line fewer, never one more.
			const ackLines = readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("acked "));
			const keys = ackLines.map((line) => line.split(" ").slice(1, 4).join(" "));
			assert.equal(new Set(keys).size, keys.length, "no input was acknowledged twice");
			assert.ok(keys.length <= WORKERS * STAGES * INPUTS);
			const byStage = new Map<string, number[]>();
			for (const input of inputs) {
				const key = `${input.work} ${input.stage_id}`;
				byStage.set(key, [...(byStage.get(key) ?? []), Number(input.settled_at)]);
			}
			for (const settled of byStage.values())
				assert.deepEqual(
					settled,
					[...settled].sort((left, right) => left - right),
					"a stage's inputs settle in order",
				);
			const receipts = new Set(inputs.map((input) => String(input.receipt)));
			assert.ok([...receipts].every((receipt) => typeof JSON.parse(receipt).pid === "number"));
			const integrity = await database.get<Row>("PRAGMA integrity_check");
			assert.equal(integrity?.integrity_check, "ok");
			const leases = await database.all<Row>(`SELECT seq FROM ${PREFIX}wf_runs_stage_leases WHERE seq IS NOT NULL`);
			assert.deepEqual(leases, [], "no stage is left holding an input");
		} finally {
			clearInterval(renewal);
			for (const child of running) {
				child.process.kill("SIGCONT");
				child.process.kill("SIGKILL");
			}
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	CHAOS_TIMEOUT_MS,
);
