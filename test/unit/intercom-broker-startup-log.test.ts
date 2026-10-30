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
import { spawn, spawnSync } from "node:child_process";
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
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
	type BoundedStderrOptions,
	BROKER_LOG_MAX_BYTES,
	installBoundedStderr,
} from "../../packages/intercom/broker/bounded-stderr.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	announceBrokerStart,
	BROKER_ANNOUNCE_PATH_ENV,
	BROKER_ANNOUNCE_TOKEN_ENV,
	readBrokerStartAnnouncement,
	retractBrokerStartAnnouncement,
} from "../../packages/intercom/broker/start-announcement.js";
import { bunExecutable, removePathSync } from "../helpers/runtime.js";

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

/**
 * How long a broker that crashes at start-up may take to be reported, on every platform: half the default start-up
 * budget. Reporting a crash is not waiting out the budget, which is for a broker that is alive and not yet listening
 * (behind the Windows launcher, a crash used to be found only when the whole budget ran out). The bound is also the
 * budget these tests give the spawn, so only noticing the exit can produce the exit wording they require.
 */
const PROMPT_EXIT_BOUND_MS = 15_000;

/**
 * What a real broker does first, for the stand-in brokers below that crash: announce its pid where the parent asked, as
 * the protocol in `start-announcement.ts` says. It does nothing where the parent asked for nothing (every platform but
 * Windows, whose launcher hides the child). No `<`, `>`, `&`, `|` or `%` in it, so cmd.exe passes it on as it is.
 */
const BROKER_FIRST_ACT = `if (process.env.${BROKER_ANNOUNCE_PATH_ENV}) require('node:fs').writeFileSync(process.env.${BROKER_ANNOUNCE_PATH_ENV}, process.env.${BROKER_ANNOUNCE_TOKEN_ENV} + ' ' + process.pid + String.fromCharCode(10));`;

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

describe("the Windows launcher chain does nothing after the broker ends", () => {
	const spec = () =>
		spawnModule.getBrokerLaunchSpec(
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

	test("its only file I/O is the broker's own stderr log", () => {
		const launch = spec();
		assert.ok(launch.kind === "windows-launcher");
		const line = launch.launcherCommandLine;

		// A resident cmd.exe that writes a file when the broker's command returns (an earlier version appended
		// `&& echo ... >file || echo ... >file`) creates that file in the intercom directory just as tests, `atomic
		// intercom restart` and users remove it, which made every Windows test that killed a broker and removed its
		// directory fail with ENOTEMPTY. The redirect is `2>>`, two `>`, and nothing may follow the broker.
		assert.equal((line.match(/>/gu) ?? []).length, 2, line);
		assert.match(line, /2>>"C:\\agent\\intercom\\broker\.log"/u);
		assert.doesNotMatch(line, /&|\||\becho\b/u, line);
		assert.ok(line.startsWith("cmd.exe /s /c "), line);

		const script = spawnModule.getWindowsHiddenLauncherScript(line);
		assert.equal((script.match(/WshShell\.Run/gu) ?? []).length, 1, script);
	});

	test("carries nothing of the broker's announcement, which is the broker's own business", () => {
		const launch = spec();
		assert.ok(launch.kind === "windows-launcher");
		assert.doesNotMatch(launch.launcherCommandLine, /ANNOUNCE|broker\.starting/u);
	});
});

describe("a broker announces its own pid", () => {
	const token = "aa11-bb22-cc33";
	const env = (file: string): NodeJS.ProcessEnv => ({
		[BROKER_ANNOUNCE_PATH_ENV]: file,
		[BROKER_ANNOUNCE_TOKEN_ENV]: token,
	});
	let file: string;

	beforeAll(() => {
		file = join(pathsModule.getIntercomDirPath(), "announce-unit.starting");
	});
	afterEach(() => removePathSync(file, { force: true }));

	test("lives beside the other broker runtime files", () => {
		assert.equal(pathsModule.getBrokerStartAnnouncementPath(), join(agentDir, "intercom", "broker.starting"));
	});

	test("is written as `<token> <pid>` where the parent asked, and read back as the pid", () => {
		announceBrokerStart(env(file), 4242);

		assert.equal(readFileSync(file, "utf8"), `${token} 4242\n`);
		assert.equal(readBrokerStartAnnouncement({ path: file, token }), 4242);
	});

	test("is not written where the parent asked for nothing, or asked in a form that is not plain", () => {
		announceBrokerStart({}, 4242);
		announceBrokerStart({ [BROKER_ANNOUNCE_PATH_ENV]: file }, 4242);
		announceBrokerStart({ ...env(file), [BROKER_ANNOUNCE_TOKEN_ENV]: "a b & del *" }, 4242);
		assert.equal(existsSync(file), false);
	});

	test("never keeps a broker from starting when the file cannot be written", () => {
		assert.doesNotThrow(() => announceBrokerStart(env(join(agentDir, "no-such-directory", "x.starting")), 4242));
	});

	test("reads nothing from a write in progress, from another spawn's file, or from one that is not a pid", () => {
		writeFileSync(file, `${token} 42`);
		assert.equal(readBrokerStartAnnouncement({ path: file, token }), undefined);

		writeFileSync(file, `other-token 4242\n`);
		assert.equal(readBrokerStartAnnouncement({ path: file, token }), undefined);

		writeFileSync(file, `${token} not-a-pid\n`);
		assert.equal(readBrokerStartAnnouncement({ path: file, token }), undefined);

		writeFileSync(file, `${token} 4242 extra\n`);
		assert.equal(readBrokerStartAnnouncement({ path: file, token }), undefined);

		removePathSync(file, { force: true });
		assert.equal(readBrokerStartAnnouncement({ path: file, token }), undefined);
	});

	test("is taken back by its own broker, and only by it", () => {
		announceBrokerStart(env(file), 4242);
		retractBrokerStartAnnouncement(env(file), 9999);
		assert.equal(existsSync(file), true, "another process's retraction must not remove a broker's announcement");

		retractBrokerStartAnnouncement(env(file), 4242);
		assert.equal(existsSync(file), false);
		assert.doesNotThrow(() => retractBrokerStartAnnouncement(env(file), 4242));
	});

	test("is not taken back by an old broker that answers late, from the spawn that replaced it", () => {
		const oldToken = "old-spawn-aa11";
		const oldBroker = { [BROKER_ANNOUNCE_PATH_ENV]: file, [BROKER_ANNOUNCE_TOKEN_ENV]: oldToken };
		announceBrokerStart(oldBroker, 4242);

		// The parent gave up on that broker and spawned the next one: it clears the file, and the new broker announces.
		removePathSync(file, { force: true });
		announceBrokerStart(env(file), 5151);

		// The old broker finally answers and takes back its own announcement, which is no longer the file's content.
		retractBrokerStartAnnouncement(oldBroker, 4242);

		assert.equal(readBrokerStartAnnouncement({ path: file, token }), 5151);
		assert.equal(readBrokerStartAnnouncement({ path: file, token: oldToken }), undefined);
	});

	test("is the broker's second import, straight after the stderr cap, so a crash while loading is announced", () => {
		const source = readFileSync(join(process.cwd(), "packages/intercom/broker/broker.ts"), "utf8");
		const sideEffectImports = [...source.matchAll(/^import "([^"]+)";$/gmu)].map((match) => match[1]);
		assert.deepEqual(sideEffectImports.slice(0, 2), ["./bounded-stderr-install.js", "./announce-on-import.js"]);
		const firstNamedImport = source.search(/^import [^"\n]+ from /mu);
		assert.ok(source.indexOf('import "./announce-on-import.js"') < firstNamedImport);

		const importer = readFileSync(join(process.cwd(), "packages/intercom/broker/announce-on-import.ts"), "utf8");
		assert.match(importer, /^announceBrokerStart\(\);$/mu);
	});

	/** A real broker, spawned as the parent spawns it, asked to announce itself in `announced`, in the agent directory `dir`. */
	function spawnRealBroker(dir: string, announced: { path: string; token: string }) {
		const options = spawnModule.getBrokerSpawnOptions(join(process.cwd(), "packages/intercom"), "ignore", announced);
		return spawn(
			process.execPath,
			[
				spawnModule.getJitiCliPath(join(process.cwd(), "packages/intercom")),
				join(process.cwd(), "packages/intercom/broker/broker.ts"),
			],
			{ env: { ...options.env, ATOMIC_CODING_AGENT_DIR: dir }, stdio: "ignore" },
		);
	}

	/** The broker's exit code, whether it exits after this is called or already has. */
	function exitCodeOf(broker: ReturnType<typeof spawnRealBroker>): Promise<number | null> {
		if (broker.exitCode !== null || broker.signalCode !== null) return Promise.resolve(broker.exitCode);
		return new Promise((resolve) => broker.once("exit", (code) => resolve(code)));
	}

	async function stopRealBroker(broker: ReturnType<typeof spawnRealBroker>): Promise<void> {
		broker.kill("SIGKILL");
		await exitCodeOf(broker);
	}

	test(
		"a real broker writes its pid at start-up, and the file stays when it never answers",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "icann-"));
			const announced = { path: join(dir, "announced.starting"), token };
			mkdirSync(pathsModule.getIntercomDirPath(dir), { recursive: true });
			// A live broker already owns the socket, so this one announces itself, finds it and yields without ever
			// answering. Its announcement is taken back only once it answers, so it is there to read however late the
			// parent looks: nothing here depends on how long the parent pauses.
			const incumbent = net.createServer((socket) => socket.on("error", () => {}));
			await new Promise<void>((resolve) =>
				incumbent.listen(pathsModule.getBrokerSocketPath(process.platform, dir), resolve),
			);
			const broker = spawnRealBroker(dir, announced);
			try {
				const code = await exitCodeOf(broker);

				assert.equal(code, 0, "the broker did not yield to the live one");
				assert.equal(readBrokerStartAnnouncement(announced), broker.pid);
				assert.equal(
					existsSync(pathsModule.getBrokerPidPath(dir)),
					false,
					"the broker that yielded wrote a pid file",
				);
			} finally {
				await stopRealBroker(broker);
				await new Promise<void>((resolve) => incumbent.close(() => resolve()));
				removePathSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			}
		},
		REAL_BROKER_STARTUP_TIMEOUT_MS * 2,
	);

	test(
		"a real broker takes its announcement back once it answers, and its pid file takes over",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "icann-"));
			const announced = { path: join(dir, "announced.starting"), token };
			const broker = spawnRealBroker(dir, announced);
			try {
				// Answering implies the announcement was written (it is the broker's second import), and once taken back
				// it stays gone, so this holds however late the parent looks.
				await eventually(
					() => connectable(pathsModule.getBrokerSocketPath(process.platform, dir)),
					REAL_BROKER_STARTUP_TIMEOUT_MS,
				);
				await eventually(() => !existsSync(announced.path), REAL_BROKER_STARTUP_TIMEOUT_MS);
				assert.equal(Number.parseInt(readFileSync(pathsModule.getBrokerPidPath(dir), "utf8"), 10), broker.pid);
			} finally {
				await stopRealBroker(broker);
				removePathSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			}
		},
		REAL_BROKER_STARTUP_TIMEOUT_MS * 2,
	);
});

/** Polls `condition` every 20 ms until it holds, failing at `timeoutMs`. */
async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		assert.ok(Date.now() < deadline, `condition did not hold within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("a broker behind a launcher that hides it", () => {
	const startedAt = () => Date.now();

	const ANNOUNCE = BROKER_FIRST_ACT;

	/**
	 * Stands in for `wscript -> cmd -> node` on every platform: a launcher that returns at once and leaves the broker
	 * running detached with its stderr in `log`, so the parent holds a child that exited 0 and cannot see the broker.
	 */
	function launchThroughStandIn(brokerScript: string, log: string, announced: { path: string; token: string }): void {
		const options = spawnModule.getBrokerSpawnOptions(join(process.cwd(), "packages/intercom"), "ignore", announced);
		const chain = [
			'const { spawn } = require("node:child_process"); const fs = require("node:fs");',
			'const fd = fs.openSync(process.argv[1], "a");',
			'spawn(process.execPath, ["-e", process.argv[2]], { detached: true, stdio: ["ignore", "ignore", fd], env: process.env }).unref();',
			"fs.closeSync(fd);",
		].join("\n");
		spawn(process.execPath, ["-e", chain, log, brokerScript], {
			detached: true,
			stdio: "ignore",
			env: options.env,
		}).unref();
	}

	function kill(pid: number | undefined): void {
		if (pid === undefined) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}

	const probe = (announced: { path: string; token: string }) => () => readBrokerStartAnnouncement(announced);

	test("a crash after announcing is reported with the broker's log long before the start-up budget", async () => {
		writeFileSync(logPath, "");
		const announced = {
			path: pathsModule.getBrokerStartAnnouncementPath(),
			token: `crash-${process.pid}-${Date.now()}`,
		};
		removePathSync(announced.path, { force: true });
		const marker = `STAND-IN-CRASH-${Date.now()}`;
		const started = startedAt();
		launchThroughStandIn(
			`${ANNOUNCE} console.error(${JSON.stringify(marker)}); process.exit(3);`,
			logPath,
			announced,
		);

		await assert.rejects(
			// The budget is the bound, so only noticing the exit can have ended the wait with the exit wording.
			() => spawnModule.waitForBroker(PROMPT_EXIT_BOUND_MS, probe(announced)),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Intercom broker exited before startup \(pid \d+\)/u, error.message);
				assert.ok(error.message.includes(marker), error.message);
				return true;
			},
		);
		assert.ok(startedAt() - started < PROMPT_EXIT_BOUND_MS);
		removePathSync(announced.path, { force: true });
	});

	test("a broker that is alive and still loading is waited for, not mistaken for a crash", async () => {
		const announced = {
			path: pathsModule.getBrokerStartAnnouncementPath(),
			token: `slow-${process.pid}-${Date.now()}`,
		};
		removePathSync(announced.path, { force: true });
		const socketPath = pathsModule.getBrokerSocketPath();
		const listenAfterMs = 1_500;
		const started = startedAt();
		launchThroughStandIn(
			[
				ANNOUNCE,
				"setTimeout(function () {",
				"  require('node:net').createServer(function (socket) { socket.on('error', function () {}); })",
				`    .listen(${JSON.stringify(socketPath)});`,
				`}, ${listenAfterMs});`,
				"setTimeout(function () { process.exit(0); }, 8000);",
			].join(" "),
			logPath,
			announced,
		);
		try {
			await spawnModule.waitForBroker(PROMPT_EXIT_BOUND_MS, probe(announced));

			assert.ok(startedAt() - started >= listenAfterMs - 100, "answered before the broker could have listened");
		} finally {
			kill(readBrokerStartAnnouncement(announced));
			await eventually(async () => !(await connectable(socketPath)), 10_000);
			// A killed listener leaves its Unix socket file behind, which would refuse the next listener.
			removePathSync(socketPath, { force: true });
			removePathSync(announced.path, { force: true });
		}
	});

	test("an announcement that is another spawn's is ignored, so the wait is the ordinary start-up budget", async () => {
		const announced = {
			path: pathsModule.getBrokerStartAnnouncementPath(),
			token: `mine-${process.pid}-${Date.now()}`,
		};
		const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		writeFileSync(announced.path, `someone-elses ${dead.stdout}\n`);

		await assert.rejects(
			() => spawnModule.waitForBroker(400, probe(announced)),
			/Broker failed to start within timeout \(400 ms\)/u,
		);
		removePathSync(announced.path, { force: true });
	});

	test("a broker that yielded to a live one, which answers, is a success", async () => {
		const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		let live: net.Server | undefined;
		try {
			await spawnModule.waitForBroker(PROMPT_EXIT_BOUND_MS, () => {
				// The incumbent starts answering between the wait's socket check and the exit it then finds: the
				// listen is synchronous, so the check after the exit sees it.
				live ??= net
					.createServer((socket) => socket.on("error", () => {}))
					.listen(pathsModule.getBrokerSocketPath());
				return Number.parseInt(dead.stdout, 10);
			});
			assert.ok(live);
		} finally {
			await new Promise<void>((resolve) => (live ? live.close(() => resolve()) : resolve()));
		}
	});

	test("once the broker is killed nothing writes into its directory, so the directory can be removed at once", async () => {
		for (let round = 0; round < 5; round++) {
			const dir = mkdtempSync(join(tmpdir(), "icgone-"));
			const announced = { path: join(dir, "broker.starting"), token: `gone-${round}-${process.pid}-${Date.now()}` };
			launchThroughStandIn(`${ANNOUNCE} setInterval(function () {}, 1000);`, join(dir, "broker.log"), announced);
			await eventually(() => readBrokerStartAnnouncement(announced) !== undefined, 15_000);
			const pid = readBrokerStartAnnouncement(announced);
			assert.ok(pid !== undefined);

			kill(pid);
			await eventually(() => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			}, 15_000);
			// The moment the broker is gone: this is the removal the Windows tests do.
			removePathSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			// Nothing of the launcher chain brings the directory back.
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(existsSync(dir), false, `round ${round}: something wrote into the removed directory`);
		}
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
	/** Spawns a broker that writes `marker` to stderr and exits with `code`, and checks how the failure is reported. */
	async function assertCrashReportedPromptly(marker: string, code: number): Promise<Error> {
		const started = Date.now();
		let reported: Error | undefined;
		await assert.rejects(
			() =>
				spawnModule.spawnBrokerIfNeeded(
					process.execPath,
					["-e", `${BROKER_FIRST_ACT} console.error(${JSON.stringify(marker)}); process.exit(${code});`],
					PROMPT_EXIT_BOUND_MS,
				),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				reported = error;
				return true;
			},
		);
		assert.ok(reported);
		// The same wording on every platform: the broker exited, and it is not "still starting". Behind the Windows
		// launcher the exit reaches the parent through the pid the broker announced rather than a child exit event.
		assert.match(reported.message, /Intercom broker exited before startup/u, reported.message);
		assert.doesNotMatch(reported.message, /failed to start within timeout/u, reported.message);
		assert.ok(Date.now() - started < PROMPT_EXIT_BOUND_MS, `reported after ${Date.now() - started} ms`);
		assert.ok(reported.message.includes(logPath), reported.message);
		// Proof the descriptor really captured the child's stderr, not just that a path was named.
		assert.ok(reported.message.includes(marker), reported.message);
		return reported;
	}

	test("a broker that exits during startup is reported at once with its captured stderr", async () => {
		const marker = `EXIT-MARKER-${Date.now()}`;

		await assertCrashReportedPromptly(marker, 3);

		assert.ok(readFileSync(logPath, "utf8").includes(marker));
	});

	test("the exit-code path names the code where the platform reports one", {
		skip: process.platform === "win32",
	}, async () => {
		// Behind the Windows launcher the marker file says whether the broker's status was 0, not what it was.
		const marker = `EXIT-CODE-MARKER-${Date.now()}`;

		const reported = await assertCrashReportedPromptly(marker, 3);

		assert.match(reported.message, /Intercom broker exited before startup with code 3/u);
	});

	test("each spawn keeps one bounded previous log instead of erasing it (#3862)", async () => {
		appendFileSync(logPath, `${"z".repeat(4096)}\n`, "utf8");
		const marker = `SECOND-MARKER-${Date.now()}`;

		await assertCrashReportedPromptly(marker, 4);

		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes(marker));
		assert.equal(contents.includes("zzzz"), false);
		const previous = readFileSync(`${logPath}.previous`, "utf8");
		assert.ok(previous.includes("zzzz"));
		assert.ok(Buffer.byteLength(previous) <= spawnModule.BROKER_LOG_TAIL_BYTES);
	});

	test("an unavailable previous-log path does not prevent broker startup (#3862)", async () => {
		const previous = `${logPath}.previous`;
		removePathSync(previous, { recursive: true, force: true });
		mkdirSync(previous);
		writeFileSync(logPath, "previous broker diagnosis\n");
		const marker = "BROKER-STARTED-WITHOUT-BACKUP";
		try {
			await assertCrashReportedPromptly(marker, 4);
		} finally {
			removePathSync(previous, { recursive: true, force: true });
		}
	});

	test("the readiness timeout error carries the log path and tail", async () => {
		const marker = `TIMEOUT-MARKER-${Date.now()}`;
		writeFileSync(logPath, `${marker}\n`, "utf8");

		await assert.rejects(
			() => spawnModule.waitForBroker(50),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Broker failed to start within timeout \(50 ms\)/u);
				// It says what to do about it.
				assert.match(error.message, /brokerStartupTimeoutMs/u);
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

describe("a broker that is slow to start", () => {
	/** The wait a spawn attempt gave a new broker before the budget was sized from measurements. */
	const FORMER_BROKER_READY_TIMEOUT_MS = 5_000;
	/** Past the former budget by more than any scheduling jitter, as a cold jiti cache on a busy host is. */
	const SLOW_LISTEN_DELAY_MS = FORMER_BROKER_READY_TIMEOUT_MS + 600;

	test(
		"is waited for past the former five-second budget by default",
		async () => {
			const socketPath = pathsModule.getBrokerSocketPath();
			const pidPath = join(pathsModule.getIntercomDirPath(), "slow-broker.pid");
			// A stand-in that listens late, as the real broker does after transpiling its modules, and keeps no state
			// the spawn logic could mistake for a crash. Written without `<`, `>`, `&` or `|` so every launcher passes it on.
			const script = [
				'const net = require("node:net"); const fs = require("node:fs");',
				`fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
				"setTimeout(function () {",
				"  const server = net.createServer(function (socket) { socket.on('error', function () {}); });",
				`  server.listen(${JSON.stringify(socketPath)});`,
				"  process.on('SIGTERM', function () { server.close(); process.exit(0); });",
				`}, ${SLOW_LISTEN_DELAY_MS});`,
				"setInterval(function () {}, 1000);",
			].join(" ");
			const started = Date.now();
			try {
				await spawnModule.spawnBrokerIfNeeded(process.execPath, ["-e", script]);

				assert.ok(
					Date.now() - started >= FORMER_BROKER_READY_TIMEOUT_MS,
					"the broker answered before the former budget ran out, so this proved nothing",
				);
				assert.equal(await connectable(socketPath), true);
			} finally {
				try {
					process.kill(Number.parseInt(readFileSync(pidPath, "utf8"), 10), "SIGTERM");
				} catch {
					// The stand-in never started or already exited.
				}
				for (let attempt = 0; attempt < 100 && (await connectable(socketPath)); attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
		},
		SLOW_LISTEN_DELAY_MS + REAL_BROKER_STARTUP_TIMEOUT_MS,
	);
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
