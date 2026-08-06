import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

/**
 * Issue #2208: the broker is spawned detached with `stdio: "ignore"`, so a broker that dies
 * during startup reported only an exit code. These tests pin the replacement: stderr goes to a
 * bounded log file through an already-open descriptor (a pipe would keep the parent attached to
 * a process that is meant to outlive it), and both startup failures name the log and quote it.
 */

/** Real child process plus a real TypeScript runner; far above the observed ~100 ms startup. */
const REAL_BROKER_STARTUP_TIMEOUT_MS = 30_000;

/** Generous ceiling for one real broker startup. Measured at ~100 ms on an idle dev machine. */
const BROKER_STARTUP_BUDGET_MS = 8_000;

const agentDir = mkdtempSync(join(tmpdir(), "intercom-broker-log-"));
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

type SpawnModule = typeof import("../../packages/intercom/broker/spawn.js");
type PathsModule = typeof import("../../packages/intercom/broker/paths.js");

let spawnModule: SpawnModule;
let pathsModule: PathsModule;
let logPath: string;

beforeAll(async () => {
	// Imported after ATOMIC_CODING_AGENT_DIR is set: both modules resolve their paths on load.
	pathsModule = await import("../../packages/intercom/broker/paths.js");
	spawnModule = await import("../../packages/intercom/broker/spawn.js");
	logPath = pathsModule.getBrokerLogPath();
	mkdirSync(pathsModule.getIntercomDirPath(), { recursive: true });
});

afterAll(() => {
	const pidPath = pathsModule.getBrokerPidPath();
	if (!existsSync(pidPath)) return;
	const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	if (!Number.isFinite(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// The broker already exited.
	}
});

describe("broker startup log path", () => {
	test("lives beside the other broker runtime files under the active agent directory", () => {
		assert.equal(logPath, join(agentDir, "intercom", "broker.log"));
		assert.equal(pathsModule.getBrokerLogPath("/custom/agent"), join("/custom/agent", "intercom", "broker.log"));
	});
});

describe("broker stderr capture shape", () => {
	test("stderr is an already-open file descriptor, never a pipe", () => {
		const options = spawnModule.getBrokerSpawnOptions("/extension", 17);

		assert.equal(options.detached, true);
		assert.deepEqual(options.stdio, ["ignore", "ignore", 17]);
		assert.equal(typeof options.stdio[2], "number");
		// Widened deliberately: the declared type already forbids "pipe", and this keeps the
		// runtime shape asserted rather than resting on the type alone.
		const stdio: readonly (string | number)[] = options.stdio;
		assert.equal(stdio.includes("pipe"), false);
		assert.equal(stdio.includes("overlapped"), false);
	});

	test("defaults to a discarded stderr when no descriptor is supplied", () => {
		assert.deepEqual(spawnModule.getBrokerSpawnOptions("/extension").stdio, ["ignore", "ignore", "ignore"]);
	});

	test("the Windows launcher redirects the broker's own stderr to the same log", () => {
		const inner = String.raw`"C:\Program Files\Atomic\node.exe" "C:\ext\cli.mjs" "C:\ext\broker.ts"`;
		const commandLine = spawnModule.getWindowsStderrRedirectCommandLine(
			inner,
			String.raw`C:\agent\intercom\broker.log`,
		);

		// WshShell.Run gives the launched process no inherited handles, so the redirect has to be
		// part of the command line itself rather than a descriptor passed to wscript.exe.
		assert.equal(commandLine, String.raw`cmd.exe /s /c "${inner} 2>>"C:\agent\intercom\broker.log""`);

		const script = spawnModule.getWindowsHiddenLauncherScript(commandLine);
		assert.ok(script.includes(`2>>""C:\\agent\\intercom\\broker.log"""`));
		assert.ok(script.includes(", 0, False"));
	});

	test("the Windows launch spec carries the redirect", () => {
		const spec = spawnModule.getBrokerLaunchSpec(
			String.raw`C:\ext\broker\broker.ts`,
			"npx",
			["--no-install", "tsx"],
			String.raw`C:\ext`,
			"win32",
			String.raw`C:\agent\intercom`,
			String.raw`C:\node.exe`,
			"node",
			String.raw`C:\agent\intercom\broker.log`,
		);

		assert.equal(spec.kind, "windows-launcher");
		assert.ok(spec.kind === "windows-launcher" && spec.launcherCommandLine.startsWith("cmd.exe /s /c "));
		assert.ok(
			spec.kind === "windows-launcher" &&
				spec.launcherCommandLine.includes(String.raw`2>>"C:\agent\intercom\broker.log"`),
		);
	});
});

describe("bounded broker log tail", () => {
	test("reads only the trailing bytes of an oversized log", () => {
		const noisy = join(agentDir, "intercom", "noisy.log");
		writeFileSync(noisy, `${"a".repeat(spawnModule.BROKER_LOG_TAIL_BYTES * 2)}TAIL-MARKER`, "utf8");

		const tail = spawnModule.readBrokerLogTail(noisy);

		assert.ok(Buffer.byteLength(tail) <= spawnModule.BROKER_LOG_TAIL_BYTES);
		assert.ok(tail.endsWith("TAIL-MARKER"));
		assert.equal(spawnModule.readBrokerLogTail(noisy, 11), "TAIL-MARKER");
	});

	test("missing and empty logs degrade to a path-only description", () => {
		const absent = join(agentDir, "intercom", "absent.log");
		assert.equal(spawnModule.readBrokerLogTail(absent), "");
		assert.equal(spawnModule.describeBrokerLog(absent), `Broker log: ${absent} (empty)`);
	});

	test("describes the log with its path and quoted tail", () => {
		const described = join(agentDir, "intercom", "described.log");
		writeFileSync(described, "boom: something failed\n", "utf8");

		const description = spawnModule.describeBrokerLog(described);

		assert.ok(description.includes(described));
		assert.ok(description.includes("boom: something failed"));
		assert.match(description, /--- broker stderr \(last \d+ bytes\) ---/u);
	});
});

describe("broker startup failures name the log", () => {
	test("a broker that exits during startup reports its captured stderr", async () => {
		const marker = `EXIT-MARKER-${Date.now()}`;
		await assert.rejects(
			() =>
				spawnModule.spawnBrokerIfNeeded(process.execPath, [
					"-e",
					`console.error(${JSON.stringify(marker)}); process.exit(3);`,
				]),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Intercom broker exited before startup with code 3/u);
				assert.ok(error.message.includes(logPath), error.message);
				// Proof the descriptor really captured the child's stderr, not just that a path was named.
				assert.ok(error.message.includes(marker), error.message);
				return true;
			},
		);

		assert.ok(readFileSync(logPath, "utf8").includes(marker));
	});

	test("each spawn truncates the log so it stays bounded across restarts", async () => {
		appendFileSync(logPath, `${"z".repeat(4096)}\n`, "utf8");
		const marker = `SECOND-MARKER-${Date.now()}`;

		await assert.rejects(() =>
			spawnModule.spawnBrokerIfNeeded(process.execPath, [
				"-e",
				`console.error(${JSON.stringify(marker)}); process.exit(4);`,
			]),
		);

		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes(marker));
		assert.equal(contents.includes("zzzz"), false);
	});

	test("the readiness timeout error carries the log path and tail", async () => {
		const marker = `TIMEOUT-MARKER-${Date.now()}`;
		writeFileSync(logPath, `${marker}\n`, "utf8");

		await assert.rejects(
			() => spawnModule.waitForBroker(50),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Broker failed to start within timeout/u);
				assert.ok(error.message.includes(logPath), error.message);
				assert.ok(error.message.includes(marker), error.message);
				return true;
			},
		);
	});
});

describe("readiness polling", () => {
	test("starts far below the old flat interval and backs off to it", () => {
		assert.equal(spawnModule.BROKER_POLL_INITIAL_INTERVAL_MS, 10);
		assert.equal(spawnModule.BROKER_POLL_MAX_INTERVAL_MS, 100);
		assert.ok(spawnModule.BROKER_POLL_INITIAL_INTERVAL_MS < spawnModule.BROKER_POLL_MAX_INTERVAL_MS);
	});
});

describe("real broker startup", () => {
	test(
		"the broker starts and its socket is reachable",
		async () => {
			const started = process.hrtime.bigint();
			await spawnModule.spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
			const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

			// Reconnecting proves the socket is genuinely accepting, not merely that spawn resolved.
			await spawnModule.waitForBroker(BROKER_STARTUP_BUDGET_MS);
			assert.ok(existsSync(pathsModule.getBrokerPidPath()));
			assert.ok(
				elapsedMs < BROKER_STARTUP_BUDGET_MS,
				`broker startup took ${elapsedMs.toFixed(1)} ms, budget ${BROKER_STARTUP_BUDGET_MS} ms`,
			);
			// eslint-disable-next-line no-console -- the measurement is the point of this test.
			console.log(`[broker startup] ${elapsedMs.toFixed(1)} ms (budget ${BROKER_STARTUP_BUDGET_MS} ms)`);
		},
		REAL_BROKER_STARTUP_TIMEOUT_MS,
	);
});
