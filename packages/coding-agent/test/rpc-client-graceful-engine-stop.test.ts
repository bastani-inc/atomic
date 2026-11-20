import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { ENGINE_SHUTDOWN_GRACE_MS } from "../src/modes/rpc/rpc-client-process.js";

/**
 * Engine children for these tests run their shutdown only when their stdin ends, and install no SIGTERM handler.
 * A signal therefore ends them at once, which is what every signal does to a process on Windows: on Linux and macOS
 * these tests reproduce the Windows behaviour under a Windows `process.platform`.
 */
type EngineBehavior = "shuts-down" | "hangs-in-shutdown" | "never-ready" | "reports-then-lingers";

const tempDirs: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const realTmpdir = tmpdir();
const TEMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;
const savedTempEnv = TEMP_ENV_KEYS.map((key) => [key, process.env[key]] as const);

/** After the grace period: the guardian's window and the wait for a killed engine's exit, after which stop throws. */
const ESCALATION_BOUND_MS = 500 + 5_000;
/** How often the test polls for a file to change. */
const POLL_MS = 10;
/** Longer than any test here; a child left behind by a failed test exits by then. */
const CHILD_LIFETIME_MS = 120_000;

function startEngine(behavior: EngineBehavior): { client: RpcClient; record: string; started: string } {
	const dir = mkdtempSync(join(realTmpdir, "atomic-graceful-engine-stop-"));
	tempDirs.push(dir);
	const record = join(dir, "shutdown");
	const started = join(dir, "started");
	const script = join(dir, "engine.mjs");
	writeFileSync(
		script,
		`import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
// Tell the test where the host writes the guardian's stop file.
const bootstrap = process.argv[process.argv.indexOf("--internal-engine-bootstrap") + 1];
writeFileSync(${JSON.stringify(started)}, JSON.parse(readFileSync(bootstrap, "utf8")).guardFile);
if (${JSON.stringify(behavior)} !== "never-ready") {
	process.stdout.write(JSON.stringify({ type: "engine_ready", protocolVersion: 4, pid: process.pid }) + "\\n");
}
process.stdin.on("end", () => {
	appendFileSync(${JSON.stringify(record)}, "shutdown started\\n");
	if (${JSON.stringify(behavior)} === "hangs-in-shutdown") return;
	appendFileSync(${JSON.stringify(record)}, "shutdown finished\\n");
	if (${JSON.stringify(behavior)} === "reports-then-lingers") {
		// As an engine whose runtime still writes its compile cache after its last exit handler.
		process.stdout.write(JSON.stringify({ type: "engine_shutdown_complete" }) + "\\n");
		return;
	}
	process.exit(0);
});
process.stdin.resume();
// Bounds the life of a child a failed test leaves behind.
setTimeout(() => process.exit(0), ${CHILD_LIFETIME_MS});
`,
	);
	const client = new RpcClient({
		cliPath: script,
		runtimeExecutable: process.execPath,
		interactiveEngine: { onDiagnostic: () => {} },
	});
	return { client, record, started };
}

async function stopOnWindows(client: RpcClient, options?: { graceful?: boolean }): Promise<number> {
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	const startedAt = performance.now();
	try {
		await client.stop(options);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
	return performance.now() - startedAt;
}

function readRecord(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	for (const [key, value] of savedTempEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient graceful engine stop on Windows", () => {
	test("a quit lets a ready engine run its shutdown before it exits (#6075)", async () => {
		const { client, record } = startEngine("shuts-down");
		await client.start();

		const elapsedMs = await stopOnWindows(client, { graceful: true });

		assert.equal(readRecord(record), "shutdown started\nshutdown finished\n");
		assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS, `stop took ${elapsedMs} ms`);
	});

	test("a quit ends an engine that says its shutdown is complete without waiting for its exit (#6075)", async () => {
		const { client, record } = startEngine("reports-then-lingers");
		await client.start();

		const elapsedMs = await stopOnWindows(client, { graceful: true });

		assert.equal(readRecord(record), "shutdown started\nshutdown finished\n");
		assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS, `stop took ${elapsedMs} ms`);
	});

	test("a stop that is not a quit still ends the engine at once (#6075)", async () => {
		const { client, record } = startEngine("shuts-down");
		await client.start();

		const elapsedMs = await stopOnWindows(client);

		assert.equal(readRecord(record), "", "the engine was ended without running its shutdown");
		assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS, `stop took ${elapsedMs} ms`);
	});

	test("a quit before the engine is ready ends it at once (#6075)", async () => {
		const { client, record, started } = startEngine("never-ready");
		const starting = client.start();
		starting.catch(() => {});
		while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));

		const elapsedMs = await stopOnWindows(client, { graceful: true });

		await assert.rejects(starting);
		assert.equal(readRecord(record), "", "the engine was ended without being asked to shut down");
		assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS, `stop took ${elapsedMs} ms`);
	});

	test("a quit ends an engine whose shutdown hangs within the bound (#6075)", async () => {
		const { client, record } = startEngine("hangs-in-shutdown");
		await client.start();

		const elapsedMs = await stopOnWindows(client, { graceful: true });

		assert.equal(readRecord(record), "shutdown started\n");
		assert.ok(elapsedMs >= ENGINE_SHUTDOWN_GRACE_MS, `stop took ${elapsedMs} ms`);
		assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS + ESCALATION_BOUND_MS, `stop took ${elapsedMs} ms`);
	});

	test("a quit ends an engine whose shutdown hangs when its guardian cannot be told to stop (#6075)", async () => {
		// The guardian's stop file lives in the temporary directory the client saw at start; remove that directory.
		const temporary = mkdtempSync(join(realTmpdir, "atomic-graceful-engine-stop-tmp-"));
		tempDirs.push(temporary);
		for (const key of TEMP_ENV_KEYS) process.env[key] = temporary;
		const { client, record } = startEngine("hangs-in-shutdown");
		await client.start();
		rmSync(temporary, { recursive: true, force: true });

		const elapsedMs = await stopOnWindows(client, { graceful: true });

		assert.equal(readRecord(record), "shutdown started\n");
		assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS + ESCALATION_BOUND_MS, `stop took ${elapsedMs} ms`);
	});

	// A FIFO with no reader holds the write that creates the guardian's stop file, as a stalled disk would.
	test.skipIf(process.platform === "win32")(
		"a quit returns once the engine is ended while the guardian's stop file is still being written (#6075)",
		async () => {
			const temporary = mkdtempSync(join(realTmpdir, "atomic-graceful-engine-stop-tmp-"));
			tempDirs.push(temporary);
			for (const key of TEMP_ENV_KEYS) process.env[key] = temporary;
			const { client, record, started } = startEngine("hangs-in-shutdown");
			await client.start();
			const stopFile = readFileSync(started, "utf8");
			assert.equal(spawnSync("mkfifo", [stopFile]).status, 0);
			let reader: number | undefined;
			try {
				const elapsedMs = await stopOnWindows(client, { graceful: true });

				assert.equal(readRecord(record), "shutdown started\n");
				assert.ok(elapsedMs < ENGINE_SHUTDOWN_GRACE_MS + ESCALATION_BOUND_MS, `stop took ${elapsedMs} ms`);
				// Let the write finish: the stop file is then removed.
				reader = openSync(stopFile, constants.O_RDONLY | constants.O_NONBLOCK);
				const deadline = performance.now() + ESCALATION_BOUND_MS;
				while (existsSync(stopFile) && performance.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, POLL_MS));
				}
				assert.equal(existsSync(stopFile), false, "the stop file is removed once its write settles");
			} finally {
				reader ??= existsSync(stopFile) ? openSync(stopFile, constants.O_RDONLY | constants.O_NONBLOCK) : undefined;
				if (reader !== undefined) closeSync(reader);
			}
		},
	);
});
