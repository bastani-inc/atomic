import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import {
	crashHostThenRestart,
	restartAsRoot,
	restartAsWorkerHost,
	shardRemovals,
} from "../helpers/crashed-ship-shards.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";

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

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/shared-pool-stub-worker.mjs", import.meta.url));
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL || undefined;
const CRASHED_HOST_PROCESSES_TIMEOUT_MS = 180_000;

async function onLibsqlServer(
	body: (selection: { adapter: string; options: { url: string }; prefix: string }, agentDir: string) => Promise<void>,
): Promise<void> {
	const url = serverUrl!;
	const prefix = `c${randomBytes(4).toString("hex")}_`;
	const directory = makeTempDirectory("ship-crashed-sqld-");
	try {
		await body({ adapter: libsql, options: { url }, prefix }, join(directory, "host", "agent"));
	} finally {
		const database = await openLibsqlDatabase({ url });
		try {
			await dropLibsqlScope(database, prefix);
		} finally {
			await database.close();
		}
		removeTempDirectory(directory);
	}
}

test.skipIf(serverUrl === undefined)(
	"a root host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on a libSQL server (#5317)",
	() =>
		onLibsqlServer((selection, agentDir) =>
			crashHostThenRestart({ selection, agentDir, restart: restartAsRoot(agentDir) }),
		),
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test.skipIf(serverUrl === undefined || process.platform === "win32")(
	"a worker host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on a libSQL server (#5317)",
	() =>
		onLibsqlServer((selection, agentDir) =>
			crashHostThenRestart({ selection, agentDir, restart: restartAsWorkerHost(selection, agentDir, stubWorker) }),
		),
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);
