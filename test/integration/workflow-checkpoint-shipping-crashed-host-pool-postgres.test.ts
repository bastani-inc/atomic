import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import type { SharedJournalSelection } from "../../packages/workflows/src/workers/worker-host-types.js";
import {
	crashHostThenRestart,
	restartAsRoot,
	restartAsWorkerHost,
	shardRemovals,
} from "../helpers/crashed-ship-shards.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async rm(path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) {
			const hook = shardRemovals.before;
			if (hook !== undefined && String(path).startsWith(hook.prefix)) {
				shardRemovals.before = undefined;
				await hook.run();
			}
			return actual.rm(path, options);
		},
	};
});

const postgresAdapter = fileURLToPath(new URL("../../packages/storage-postgres/postgres.js", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/shared-pool-stub-worker.mjs", import.meta.url));
const CRASHED_HOST_PROCESSES_TIMEOUT_MS = 180_000;

async function onPostgres(body: (selection: SharedJournalSelection, agentDir: string) => Promise<void>): Promise<void> {
	await withPostgresDatabase(async (database) => {
		const directory = makeTempDirectory("ship-crashed-postgres-");
		try {
			const passwordFile = join(directory, "password");
			writeFileSync(passwordFile, postgresTestPassword ?? "", { mode: 0o600 });
			const selection: SharedJournalSelection = {
				adapter: postgresAdapter,
				options: { url: database.url },
				prefix: "acme_",
				...(postgresTestPassword === undefined ? {} : { secrets: { password: { file: passwordFile } } }),
			};
			await body(selection, join(directory, "host", "agent"));
		} finally {
			removeTempDirectory(directory);
		}
	});
}

test.skipIf(postgresSkipReason !== undefined)(
	"a root host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on PostgreSQL (#5317)",
	() =>
		onPostgres((selection, agentDir) =>
			crashHostThenRestart({ selection, agentDir, restart: restartAsRoot(agentDir) }),
		),
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test.skipIf(postgresSkipReason !== undefined || process.platform === "win32")(
	"a worker host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on PostgreSQL (#5317)",
	() =>
		onPostgres((selection, agentDir) =>
			crashHostThenRestart({ selection, agentDir, restart: restartAsWorkerHost(selection, agentDir, stubWorker) }),
		),
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);
