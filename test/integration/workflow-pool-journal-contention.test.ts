import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";

const POOL_PROCESS_TEST_TIMEOUT_MS = 120_000;
const fixturePath = fileURLToPath(new URL("../fixtures/pool-journal-claim.mjs", import.meta.url));

async function signal(child: SpawnedProcess, expected: string): Promise<void> {
	assert.ok(child.stdout);
	const reader = child.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(await readStreamText(child.stderr));
			text += new TextDecoder().decode(next.value);
		}
		assert.equal(text, `${expected}\n`);
	} finally {
		reader.releaseLock();
	}
}

test(
	"two independent Node processes race one child lease without double claiming (#3869)",
	async () => {
		const directory = makeTempDirectory("pool-contention-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const children: SpawnedProcess[] = [];
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "coordinator");
			if (acquired.status !== "acquired") assert.fail("lease not acquired");
			const pool = await openSqlPoolQueue(journal);
			await pool.initialize(acquired.lease, 60_000);
			const { work, boundary } = poolWorkFixture();
			await pool.enqueue(acquired.lease, work, boundary);
			for (const worker of ["first", "second"]) {
				children.push(
					spawnProcess([process.execPath, fixturePath, path, JSON.stringify(acquired.lease), worker], {
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					}),
				);
			}
			await Promise.all(children.map((child) => signal(child, "ready")));
			await journal.renew(acquired.lease);
			await database.transaction(async () => {
				for (const child of children) child.stdin?.end("go\n");
				await Promise.all(children.map((child) => signal(child, "claiming")));
			});
			const claims = await Promise.all(
				children.map(async (child) => {
					const stdout = readStreamText(child.stdout);
					const stderr = readStreamText(child.stderr);
					assert.equal(await child.exited, 0, await stderr);
					return JSON.parse(await stdout) as PoolWork | null;
				}),
			);
			assert.equal(claims.filter(Boolean).length, 1);
			const winner = claims.find((claim) => claim !== null)!;
			assert.equal(winner.generation, 1);
			assert.deepEqual(await pool.inspect("root"), [winner]);
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	POOL_PROCESS_TEST_TIMEOUT_MS,
);
