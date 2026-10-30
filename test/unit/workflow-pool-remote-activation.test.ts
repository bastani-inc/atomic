import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import {
	closeCoordinationJournals,
	coordinationDatabase,
	coordinationPath,
	poolDurableJournal,
	poolHostId,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { activatePublicPool } from "../../packages/workflows/src/workers/public-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const adapter = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
const workers = { count: 1, definitions: [{ path: childPath, exportName: "child" }] };

afterEach(async () => {
	vi.unstubAllEnvs();
	await closeCoordinationJournals();
});

async function withRemoteBackend<T>(
	body: (context: { directory: string; agentDir: string; backend: JournalDurableBackend }) => Promise<T>,
): Promise<T> {
	const directory = makeTempDirectory("pool-remote-activation-");
	const agentDir = join(directory, "home", "agent");
	const journal = await resolveRunJournal({
		agentDir,
		journal: { adapter, options: { path: join(directory, "r.sqlite") } },
	});
	const backend = await JournalDurableBackend.open(journal);
	try {
		return await body({ directory, agentDir, backend });
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a pool on a journal in another database records the machine whose pool database holds its work, and a resume elsewhere is refused",
	async () => {
		await withRemoteBackend(async ({ directory, agentDir, backend }) => {
			const options: RunOpts = { runId: "root", cwd: directory, localWorkers: workers };
			const pool = await activatePublicPool(backend, options);
			assert.ok(pool);
			try {
				const host = poolHostId(agentDir);
				assert.deepEqual(options.effectiveResources?.coordinator, {
					host,
					database: coordinationDatabase(poolDurableJournal(backend.journal)),
				});
				assert.ok(existsSync(coordinationPath(poolDurableJournal(backend.journal))));

				// The same machine resumes: the recorded resources match what it would run.
				const saved = options.effectiveResources;
				const resumed = await activatePublicPool(backend, {
					runId: "root",
					cwd: directory,
					effectiveResources: saved,
				});
				await resumed?.close();
				assert.ok(saved);

				// Another machine: its pool database is somewhere this one cannot see.
				const elsewhere = { ...saved, coordinator: { ...saved.coordinator!, host: "another-machine" } };
				await assert.rejects(
					activatePublicPool(backend, {
						runId: "root",
						cwd: directory,
						localWorkers: workers,
						effectiveResources: elsewhere,
					}),
					/local workers ran on another machine \(another-machine\)[\s\S]*Resume the root on that machine/,
				);
			} finally {
				await pool.close();
			}
		});
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a journal no other process can open gets no pool, and says why",
	async () => {
		const backend = await JournalDurableBackend.open(new MemoryRunJournal());
		try {
			await assert.rejects(
				activatePublicPool(backend, { runId: "root", cwd: process.cwd(), localWorkers: workers }),
				/cannot reopen a journal passed as an object/,
			);
		} finally {
			await backend.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"user limits on a journal in another database count in this machine's pool database",
	async () => {
		await withRemoteBackend(async ({ directory, backend }) => {
			const pool = coordinationPath(poolDurableJournal(backend.journal));
			await assert.rejects(
				activatePublicPool(backend, {
					runId: "root",
					cwd: directory,
					localWorkers: workers,
					admission: { userLimits: { session: 2 }, userDatabase: join(directory, "elsewhere.sqlite") },
				}),
				/admission\.userDatabase must be omitted/,
			);
			const options: RunOpts = {
				runId: "root",
				cwd: directory,
				localWorkers: workers,
				admission: { userLimits: { session: 2 } },
			};
			const activated = await activatePublicPool(backend, options);
			try {
				assert.equal(options.effectiveResources?.admission?.userDatabase, resolve(pool));
			} finally {
				await activated?.close();
			}
		});
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a default-prefix SQLite journal keeps sharing its file with the pool",
	async () => {
		const directory = makeTempDirectory("pool-local-activation-");
		const agentDir = join(directory, "home", "agent");
		const journal = await resolveRunJournal({ agentDir, journal: { path: join(directory, "journal.sqlite") } });
		const backend = await JournalDurableBackend.open(journal);
		try {
			const options: RunOpts = { runId: "root", cwd: directory, localWorkers: workers };
			const pool = await activatePublicPool(backend, options);
			assert.ok(pool);
			await pool.close();
			assert.equal(
				options.effectiveResources?.coordinator,
				undefined,
				"no coordination database, so no machine to record",
			);
			assert.equal(existsSync(join(directory, "home", "workflows", "pool")), false);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a root resumes in the same pool database when only the name of a credential reference changed, and is refused when the selection now means another",
	async () => {
		const directory = makeTempDirectory("pool-identity-");
		const agentDir = join(directory, "home", "agent");
		vi.stubEnv("POOL_TEST_TOKEN", "same-token");
		vi.stubEnv("POOL_TEST_TOKEN_RENAMED", "same-token");
		const open = async (env: string, path = join(directory, "r.sqlite")) =>
			JournalDurableBackend.open(
				await resolveRunJournal({
					agentDir,
					journal: { adapter, options: { path }, secrets: { token: { env } } },
				}),
			);
		const started = await open("POOL_TEST_TOKEN");
		const options: RunOpts = { runId: "root", cwd: directory, localWorkers: workers };
		try {
			await (await activatePublicPool(started, options))?.close();
			const saved = options.effectiveResources;
			assert.ok(saved?.coordinator);
			const original = coordinationPath(poolDurableJournal(started.journal));

			// The same token, read from another variable: the same database, so the saved queue is found.
			const renamed = await open("POOL_TEST_TOKEN_RENAMED");
			try {
				assert.equal(coordinationPath(poolDurableJournal(renamed.journal)), original);
				await (
					await activatePublicPool(renamed, {
						runId: "root",
						cwd: directory,
						localWorkers: workers,
						effectiveResources: saved,
					})
				)?.close();
			} finally {
				await renamed.close();
			}

			// Another database file: the saved queue is in a pool database this selection no longer reaches.
			const moved = await open("POOL_TEST_TOKEN", join(directory, "elsewhere.sqlite"));
			try {
				await assert.rejects(
					activatePublicPool(moved, {
						runId: "root",
						cwd: directory,
						localWorkers: workers,
						effectiveResources: saved,
					}),
					/pool database [0-9a-f]+ on this machine[\s\S]*selected as it was when the root started/,
				);
			} finally {
				await moved.close();
			}
		} finally {
			await started.close();
			await closeCoordinationJournals();
			removeTempDirectory(directory);
		}
	},
	60_000,
);
