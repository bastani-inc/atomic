import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Integration tests run the shipped local worker, not the source one.
 *
 * `LocalWorkerPool` forks `packages/workflows/src/workers/local-worker-entry.mjs` for its coordinator process and for
 * every worker, and that entry loads `local-worker.ts` and its ~250-module source graph through jiti. The graph costs
 * about 6 CPU-seconds per process with jiti's transform cache warm (module resolution is most of it, not
 * transpiling) and about 12 with it cold, against about 1.4 for the bundle that published builds ship in its place.
 * Jiti keeps its cache under the temp directory, which a CI job starts empty, and processes that start together each
 * transpile the graph themselves. A pool test starts two such processes per pool, several pool test files run side
 * by side on an 8-core runner, and a start there outlasted the pool's 30 s startup timeout (the Windows
 * `integration-tests` shard that failed with "Local worker startup timed out after 30000 ms").
 *
 * The bundle is also what users run, so the pool tests exercise it rather than a development loader. The redirect
 * sits at `fork` because the coordinator launch is the only place the test process names the entry, and the bundled
 * coordinator forks its workers from `process.argv[1]`, which is the bundle. A stub worker a test passes as
 * `workerEntry`, and every other `fork`, pass through untouched.
 *
 * `fork` is replaced on the real module rather than through `vi.mock("node:child_process")`: a mock factory's named
 * exports are copies, so it would hide the `vi.spyOn(childProcess, "execFile")` plus `syncBuiltinESMExports()` that
 * the Herdr fixtures use to reach the transport's own `execFile` import (that suite failed under a global mock).
 */
const SOURCE_ENTRY_SUFFIX = "/packages/workflows/src/workers/local-worker-entry.mjs";
const packagedEntry = fileURLToPath(
	new URL("../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
);
const PACKAGED_FORK = Symbol.for("atomic.test.packagedLocalWorkerFork");

const realFork = childProcess.fork;
if (!(realFork as unknown as Record<symbol, unknown>)[PACKAGED_FORK]) {
	const redirectedFork = (modulePath: string | URL, ...rest: unknown[]) => {
		// A suffix on forward slashes, so a Windows path (backslashes, drive-letter case) names the entry the same way.
		const names = String(modulePath).replaceAll("\\", "/").endsWith(SOURCE_ENTRY_SUFFIX);
		if (names && !existsSync(packagedEntry)) {
			throw new Error(
				`Packaged local worker missing at ${packagedEntry}: run \`npm run build\` in packages/coding-agent first. Integration tests run the shipped worker, not the source loader.`,
			);
		}
		return (realFork as (...args: unknown[]) => ReturnType<typeof realFork>)(
			names ? packagedEntry : modulePath,
			...rest,
		);
	};
	Object.defineProperty(redirectedFork, PACKAGED_FORK, { value: true });
	// Not `vi.spyOn`: a test's `vi.restoreAllMocks()` would silently put the jiti loader back.
	Object.defineProperty(childProcess, "fork", { value: redirectedFork, configurable: true, writable: true });
	syncBuiltinESMExports();
}
