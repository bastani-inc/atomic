import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
const COUNTING_PRELOAD = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.ATOMIC_TEST_PRELOAD_LOG, "ran\\n");`;
const dataUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const WATCHDOG_MODULE = JSON.stringify(
	pathToFileURL(join(moduleDir(import.meta.url), "../../packages/intercom/broker/watchdog.ts")).href,
);

/** Runs a broker stand-in with the watchdog in a Node child started with `flags` and `env`; returns the preload's runs. */
function probeWatchdog(flags: readonly string[], env: Record<string, string> = {}): string {
	const dir = makeTempDirectory("ic-watchdog-flags-");
	const preloadLog = join(dir, "preload.log");
	const socketPath =
		process.platform === "win32"
			? `\\\\.\\pipe\\atomic-watchdog-flags-${process.pid}-${Date.now()}`
			: join(dir, "b.sock");
	try {
		// The child ends itself 15 s after starting if no probe comes. The bound ends one that would never end (its
		// script never reached), so that the test fails instead of stalling the run, and leaves room for a loaded machine.
		// A child ended for running past it throws ETIMEDOUT here.
		const CHILD_TIMEOUT_MS = 60_000;
		// A broker stand-in: the watchdog's first health request (a 4-byte length, then JSON) shows its thread is running.
		const result = spawnSyncCollect(
			[
				process.execPath,
				"--import",
				dataUrl(COUNTING_PRELOAD),
				"--import",
				dataUrl(RESOLVE_TS_SOURCES),
				...flags,
				"--eval",
				`import { startBrokerWatchdog } from ${WATCHDOG_MODULE};
				import { createServer } from "node:net";
				const server = createServer((socket) => {
					let buffer = Buffer.alloc(0);
					socket.on("data", (data) => {
						buffer = Buffer.concat([buffer, data]);
						if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0) + 4) return;
						process.stdout.write(JSON.stringify(JSON.parse(buffer.subarray(4).toString("utf8")).type));
						process.exit(0);
					});
				});
				server.listen(process.env.WATCHDOG_SOCKET, () =>
					startBrokerWatchdog(process.env.WATCHDOG_SOCKET, "instance", process.env.WATCHDOG_LOG),
				);
				// The first probe comes after the watchdog's 2 s interval; one that never comes means its thread never ran.
				setTimeout(() => process.exit(3), 15_000);`,
			],
			{
				cwd: dir,
				env: {
					...process.env,
					ATOMIC_TEST_PRELOAD_LOG: preloadLog,
					WATCHDOG_SOCKET: socketPath,
					WATCHDOG_LOG: join(dir, "watchdog.log"),
					...env,
				},
				timeout: CHILD_TIMEOUT_MS,
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString(), '"health"');
		assert.ok(fileExistsSync(preloadLog));
		return readTextSync(preloadLog, "utf8");
	} finally {
		removeTempDirectory(dir);
	}
}

test("the broker watchdog probes from a process started with --input-type=module and runs its preload once (#6079)", () => {
	assert.equal(probeWatchdog(["--input-type=module"]), "ran\n", "the preload ran again for the watchdog thread");
});

test("the broker watchdog probes in a process whose NODE_OPTIONS holds --input-type=module (#6110)", () => {
	assert.equal(
		probeWatchdog([], { NODE_OPTIONS: "--input-type=module" }),
		"ran\n",
		"the preload ran again for the watchdog thread",
	);
});
