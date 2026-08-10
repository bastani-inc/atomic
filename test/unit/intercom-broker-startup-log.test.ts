import assert from "node:assert/strict";
// `node:child_process` rather than test/helpers/runtime.ts's `spawnProcess`, and
// deliberately so. This suite spawns the broker exactly as spawn.ts ships it:
// `detached: true` with a raw file descriptor for stderr. `BunSpawnOptions`
// exposes neither -- it has no `detached`, and its `StdioOption` normalizes to
// "pipe" | "inherit" | "ignore", so a descriptor cannot survive it. Routing
// through the helper would test a process shape the product never launches,
// which is the one thing these tests exist to check. The helper's purpose is
// the Bun-to-Node porting traps in AGENTS.md (`Bun.spawnSync`'s `status` vs
// `exitCode`, `Bun.spawn`'s missing `.exited`); this file was written against
// Node from the start and ports nothing. Same reasoning for the synchronous
// `node:fs` calls below: `mkdtempSync`, `statSync` and `openSync` have no
// helper equivalents, and the async ones that do exist would not make the
// descriptor plumbing any safer.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	type BoundedStderrOptions,
	BROKER_LOG_MAX_BYTES,
	installBoundedStderr,
} from "../../packages/intercom/broker/bounded-stderr.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { bunExecutable } from "../helpers/runtime.js";

/** Resolves true once the broker socket accepts a connection. */
function connectable(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		const finish = (value: boolean) => {
			socket.destroy();
			resolve(value);
		};
		socket.on("connect", () => finish(true));
		socket.on("error", () => finish(false));
		setTimeout(() => finish(false), 500);
	});
}
/** Shapes the limiter patches; mirrored here so the fakes stay honest about the real contract. */
interface WritableLike {
	write(chunk: string | Uint8Array, encodingOrCallback?: unknown, maybeCallback?: () => void): boolean;
}
interface ConsoleLike {
	error(...args: unknown[]): void;
	warn(...args: unknown[]): void;
}

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
// Both agent-dir variables are restored in afterAll. Vitest's default `forks`
// pool already isolates each file in its own process, so today this cannot leak
// -- but AGENTS.md forbids pinning `pool`/`isolate`, so the isolation this
// relies on is a default rather than a guarantee, and a future default would
// silently hand every other suite a temp directory that is deleted at exit.
const previousAgentDirEnv = {
	atomic: process.env.ATOMIC_CODING_AGENT_DIR,
	pi: process.env.PI_CODING_AGENT_DIR,
} as const;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const restoreAgentDirEnv = (): void => {
	if (previousAgentDirEnv.atomic === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDirEnv.atomic;
	if (previousAgentDirEnv.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv.pi;
};

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
	// Restore first: an early return below must not leave the override installed.
	restoreAgentDirEnv();
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
		assert.equal(options.env.AI_AGENT, "atomic");
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
				// Which failure path reports this is platform-dependent, and the
				// contract being tested is the diagnostic, not the wording.
				//
				// On Windows the broker is launched through the hidden VBS
				// launcher, so the direct child is the launcher: it exits 0
				// immediately and getBrokerSpawnOptions' onExit deliberately
				// ignores that (`windows-launcher && code === 0 && signal === null`).
				// The real broker's failure therefore surfaces through the
				// waitForBroker() timeout instead of an exit code. Asserting the
				// exit-code wording there tested the launcher, not the fix.
				const reportsFailure =
					/Intercom broker exited before startup with code 3/u.test(error.message) ||
					/Broker failed to start within timeout/u.test(error.message);
				assert.ok(reportsFailure, error.message);
				assert.ok(error.message.includes(logPath), error.message);
				// Proof the descriptor really captured the child's stderr, not just that a path was named.
				// This must hold on BOTH paths -- it is the whole point of the change.
				assert.ok(error.message.includes(marker), error.message);
				return true;
			},
		);

		assert.ok(readFileSync(logPath, "utf8").includes(marker));
	});

	test("the exit-code path names the code where the platform reports one", {
		skip: process.platform === "win32",
	}, async () => {
		// Kept as a distinct assertion so the non-Windows exit path cannot
		// regress behind the platform-tolerant check above.
		const marker = `EXIT-CODE-MARKER-${Date.now()}`;
		await assert.rejects(
			() =>
				spawnModule.spawnBrokerIfNeeded(process.execPath, [
					"-e",
					`console.error(${JSON.stringify(marker)}); process.exit(3);`,
				]),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Intercom broker exited before startup with code 3/u);
				return true;
			},
		);
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

describe("physical broker log cap", () => {
	function fakeStream(accepted: Buffer[]): WritableLike {
		return {
			// Node accepts both `write(chunk, cb)` and `write(chunk, encoding, cb)`; the limiter
			// forwards the two-argument shape, so the fake resolves the callback the way Node does.
			write(chunk: string | Uint8Array, encodingOrCallback?: unknown, maybeCallback?: () => void): boolean {
				accepted.push(Buffer.from(chunk as Uint8Array));
				const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
				(callback as (() => void) | undefined)?.();
				return true;
			},
		} as WritableLike;
	}

	function fakeConsole(): ConsoleLike {
		return { error: () => {}, warn: () => {} };
	}

	test("the limiter counts bytes, not characters, and forwards only what fits", () => {
		const accepted: Buffer[] = [];
		const stream = fakeStream(accepted);

		const handle = installBoundedStderr({ maxBytes: 10, stream, console: fakeConsole(), process: null });
		// "é" is two bytes in UTF-8: five of them fill the ten-byte budget exactly.
		assert.equal(stream.write("ééééé"), true);
		assert.equal(handle.writtenBytes(), 10);
		assert.equal(stream.write("more"), true);
		assert.equal(handle.writtenBytes(), 10);
		assert.equal(Buffer.concat(accepted).length, 10);

		handle.restore();
		stream.write("after restore");
		assert.equal(Buffer.concat(accepted).length, 23);
	});

	test("a partial chunk is truncated at the cap rather than dropped whole", () => {
		const accepted: Buffer[] = [];
		const stream = fakeStream(accepted);

		const handle = installBoundedStderr({ maxBytes: 4, stream, console: fakeConsole(), process: null });
		stream.write("abcdefgh");

		assert.deepEqual(
			accepted.map((entry) => entry.toString("utf8")),
			["abcd"],
		);
		assert.equal(handle.writtenBytes(), 4);
		handle.restore();
	});

	test("callbacks still run and writes still report success past the cap", () => {
		let calls = 0;
		const accepted: Buffer[] = [];
		const stream = fakeStream(accepted);

		const handle = installBoundedStderr({ maxBytes: 2, stream, console: fakeConsole(), process: null });
		stream.write("xx", "utf8", () => {
			calls += 1;
		});
		// Past the cap the limiter never reaches the underlying stream, so it owns the callback.
		assert.equal(
			stream.write("yy", "utf8", () => {
				calls += 1;
			}),
			true,
		);
		assert.equal(calls, 2);
		handle.restore();
	});

	test("console.error and console.warn share the same budget as the stream", () => {
		const accepted: Buffer[] = [];
		const stream = fakeStream(accepted);
		const consoleObject = fakeConsole();

		const handle = installBoundedStderr({ maxBytes: 12, stream, console: consoleObject, process: null });
		consoleObject.error("abc", 42);
		assert.equal(Buffer.concat(accepted).toString("utf8"), "abc 42\n");
		consoleObject.warn("defgh");
		// Only the five bytes still available are taken from the second message.
		assert.equal(handle.writtenBytes(), 12);
		assert.equal(Buffer.concat(accepted).toString("utf8"), "abc 42\ndefgh");

		handle.restore();
		consoleObject.error("restored");
		assert.equal(handle.writtenBytes(), 12);
	});

	test("fatal handlers are registered on both channels and write through the budget", () => {
		const accepted: Buffer[] = [];
		const stream = fakeStream(accepted);
		const listeners = new Map<string, (value: unknown) => void>();
		let exitCode: number | undefined;
		const host = {
			on(event: string, listener: (value: unknown) => void) {
				listeners.set(event, listener);
				return host;
			},
			off(event: string) {
				listeners.delete(event);
				return host;
			},
			exit(code?: number) {
				exitCode = code;
				return undefined as never;
			},
		};

		const handle = installBoundedStderr({
			maxBytes: 16,
			stream,
			console: fakeConsole(),
			process: host as unknown as NonNullable<BoundedStderrOptions["process"]>,
		});

		assert.deepEqual([...listeners.keys()].sort(), ["uncaughtException", "unhandledRejection"]);
		listeners.get("uncaughtException")?.(new Error("x".repeat(500)));
		assert.equal(handle.writtenBytes(), 16);
		assert.equal(exitCode, 1);

		handle.restore();
		assert.deepEqual([...listeners.keys()], []);
	});

	test("the read bound never exceeds the physical cap", () => {
		assert.ok(spawnModule.BROKER_LOG_TAIL_BYTES <= BROKER_LOG_MAX_BYTES);
	});

	test("the installer is the broker's very first import", () => {
		const source = readFileSync(join(process.cwd(), "packages/intercom/broker/broker.ts"), "utf8");
		const firstImport = source.match(/^import[^\n]*$/mu)?.[0];

		// ESM evaluates static dependencies before the importer's body, so any import placed above
		// this one could write unbounded stderr while it initializes.
		assert.equal(firstImport, 'import "./bounded-stderr-install.js";');
		assert.equal(source.includes("installBoundedStderr("), false, "the entrypoint must not call it directly");

		const installer = readFileSync(join(process.cwd(), "packages/intercom/broker/bounded-stderr-install.ts"), "utf8");
		assert.ok(installer.includes('from "./bounded-stderr.js"'));
		assert.ok(installer.includes("installBoundedStderr();"));
		// Installing at the utility's module scope would patch process globals for every importer.
		const utility = readFileSync(join(process.cwd(), "packages/intercom/broker/bounded-stderr.ts"), "utf8");
		assert.equal(/^installBoundedStderr\(/mu.test(utility), false);
	});

	interface CapProbe {
		readonly name: string;
		readonly body: string;
		readonly expectedExitCode: number;
	}

	const capProbes: readonly CapProbe[] = [
		{ name: "stream", body: `process.stderr.write("A".repeat(BYTES));`, expectedExitCode: 0 },
		// Bun's console is native and does not go through process.stderr.write.
		{ name: "console.error", body: `console.error("B".repeat(BYTES));`, expectedExitCode: 0 },
		// Node and Bun both print an uncaught error themselves, bypassing the stream.
		{ name: "uncaught exception", body: `throw new Error("C".repeat(BYTES));`, expectedExitCode: 1 },
		{
			name: "unhandled rejection",
			body: `Promise.reject(new Error("D".repeat(BYTES))); setTimeout(() => {}, 1000);`,
			expectedExitCode: 1,
		},
	];

	/** Node plus, when it is installed, the runtime the standalone broker actually runs on. */
	function capRuntimes(): { name: string; command: () => string; needsLoader: boolean }[] {
		const runtimes = [{ name: "node", command: () => process.execPath, needsLoader: true }];
		try {
			const bun = bunExecutable();
			runtimes.push({ name: "bun", command: () => bun, needsLoader: false });
		} catch {
			// Bun is not installed on this machine; the Node rows still run.
		}
		return runtimes;
	}

	for (const runtime of capRuntimes()) {
		for (const probe of capProbes) {
			test(
				`a real detached ${runtime.name} child capped on the ${probe.name} path`,
				async () => {
					const slug = `${runtime.name}-${probe.name}`.replace(/[^a-z0-9]+/giu, "-");
					const capLogPath = join(agentDir, "intercom", `cap-${slug}.log`);
					const fixturePath = join(agentDir, `cap-${slug}.ts`);
					const limiterUrl = pathToFileURL(
						join(process.cwd(), "packages/intercom/broker/bounded-stderr.ts"),
					).href.replace(/\.ts$/u, ".js");
					const attemptedBytes = BROKER_LOG_MAX_BYTES * 4;
					writeFileSync(
						fixturePath,
						[
							`import { installBoundedStderr } from ${JSON.stringify(limiterUrl)};`,
							"installBoundedStderr();",
							probe.body.replaceAll("BYTES", String(attemptedBytes)),
							"",
						].join("\n"),
						"utf8",
					);

					const logFd = openSync(capLogPath, "w");
					// The loader path comes from the production resolver, so the probe runs the way
					// the Node broker does. Resolved here because spawn.js is imported in beforeAll.
					const leadingArgs = runtime.needsLoader
						? [spawnModule.getJitiCliPath(join(process.cwd(), "packages/intercom"))]
						: [];
					const child = spawn(runtime.command(), [...leadingArgs, fixturePath], {
						detached: true,
						stdio: ["ignore", "ignore", logFd],
						env: { ...process.env, NODE_NO_WARNINGS: "1" },
					});
					closeSync(logFd);

					const exitCode = await new Promise<number | null>((resolve, reject) => {
						child.once("error", reject);
						child.once("exit", resolve);
					});
					assert.equal(exitCode, probe.expectedExitCode);

					const size = statSync(capLogPath).size;
					// The child really attempted four times the cap; the file must not have grown.
					assert.ok(size > 0, "the probe wrote nothing, so the cap was not exercised");
					assert.ok(
						size <= BROKER_LOG_MAX_BYTES,
						`log grew to ${size} bytes after ${attemptedBytes} were attempted, cap is ${BROKER_LOG_MAX_BYTES}`,
					);
				},
				REAL_BROKER_STARTUP_TIMEOUT_MS,
			);
		}
	}

	interface ImportTimeProbe {
		readonly name: string;
		/** Kept very short: the agent directory holds a Unix socket, and macOS caps that path near 104 bytes. */
		readonly slug: string;
		readonly prelude: string;
		/** The broker only reaches its socket when the poisoned module does not throw. */
		readonly expectReachable: boolean;
	}

	const importTimeProbes: readonly ImportTimeProbe[] = [
		{
			name: "oversized write while a dependency initializes",
			slug: "w",
			prelude: `process.stderr.write("P".repeat(BYTES));`,
			expectReachable: true,
		},
		{
			name: "throw while a dependency initializes",
			slug: "t",
			prelude: `throw new Error("Q".repeat(BYTES));`,
			expectReachable: false,
		},
	];

	for (const probe of importTimeProbes) {
		test(
			`the cap already applies to an ${probe.name}`,
			async () => {
				// A real copy of the broker's own module graph, so the poisoned module is genuinely
				// imported by the entrypoint and evaluated before its body runs. Only the files the
				// graph reaches are copied: `skills/` and `ui/` would add cost for no coverage.
				const packageRoot = join(agentDir, `pkg-${probe.slug}`);
				const packageSource = join(process.cwd(), "packages/intercom");
				mkdirSync(packageRoot, { recursive: true });
				cpSync(join(packageSource, "broker"), join(packageRoot, "broker"), { recursive: true });
				cpSync(join(packageSource, "package.json"), join(packageRoot, "package.json"));
				for (const entry of readdirSync(packageSource, { withFileTypes: true })) {
					if (entry.isFile() && entry.name.endsWith(".ts")) {
						cpSync(join(packageSource, entry.name), join(packageRoot, entry.name));
					}
				}
				const poisoned = join(packageRoot, "group.ts");
				const attemptedBytes = BROKER_LOG_MAX_BYTES * 4;
				writeFileSync(
					poisoned,
					`${probe.prelude.replaceAll("BYTES", String(attemptedBytes))}\n${readFileSync(poisoned, "utf8")}`,
					"utf8",
				);

				const probeAgentDir = join(agentDir, `a-${probe.slug}`);
				mkdirSync(join(probeAgentDir, "intercom"), { recursive: true });
				const capLogPath = join(probeAgentDir, "intercom", "broker.log");
				const logFd = openSync(capLogPath, "w");
				const child = spawn(
					process.execPath,
					[
						spawnModule.getJitiCliPath(join(process.cwd(), "packages/intercom")),
						join(packageRoot, "broker", "broker.ts"),
					],
					{
						detached: true,
						stdio: ["ignore", "ignore", logFd],
						env: { ...process.env, ATOMIC_CODING_AGENT_DIR: probeAgentDir, NODE_NO_WARNINGS: "1" },
					},
				);
				closeSync(logFd);

				// Must come from the platform-aware helper, not a hand-built path:
				// on Windows the broker binds a named pipe (\\.\pipe\pi-intercom-*),
				// so probing "<agentDir>/intercom/broker.sock" can never connect and
				// the probe reports unreachable no matter how healthy the broker is.
				const socketPath = getBrokerSocketPath(process.platform, probeAgentDir);
				const deadline = Date.now() + 10_000;
				let reachable = false;
				while (Date.now() < deadline && !reachable) {
					reachable = await connectable(socketPath);
					if (!reachable) await new Promise((resolve) => setTimeout(resolve, 20));
					if (!reachable && child.exitCode !== null) break;
				}
				assert.equal(reachable, probe.expectReachable);

				const size = statSync(capLogPath).size;
				assert.ok(size > 0, "the probe wrote nothing, so the cap was not exercised");
				assert.ok(
					size <= BROKER_LOG_MAX_BYTES,
					`log grew to ${size} bytes after ${attemptedBytes} were attempted, cap is ${BROKER_LOG_MAX_BYTES}`,
				);

				try {
					if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
				} catch {
					// Already gone.
				}
			},
			REAL_BROKER_STARTUP_TIMEOUT_MS,
		);
	}
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
