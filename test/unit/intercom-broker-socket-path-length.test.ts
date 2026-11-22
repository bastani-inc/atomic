import assert from "node:assert/strict";
// `lstatSync`, `chmodSync` and `symlinkSync` have no equivalent in test/helpers/runtime.ts: the socket directory's
// owner, mode and kind are what these tests pin.
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import net from "node:net";
import { basename, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import {
	chooseBrokerSocketPath,
	getBrokerPidPath,
	getBrokerSocketPath,
	getBrokerSocketPathRecordPath,
	getBrokerSocketReplacementLockPath,
	getIntercomDirPath,
	maxUnixSocketPathBytes,
	recordBrokerSocketPath,
} from "../../packages/intercom/broker/paths.js";
import { isSocketAnswering } from "../../packages/intercom/broker/socket-liveness.js";
import { acquireSocketReplacementLock } from "../../packages/intercom/broker/socket-replacement-lock.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	readTextSync,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

/**
 * Issue #5040: a broker whose agent directory put `intercom/broker.sock` past the Unix socket path limit could not
 * start. Node 22 bound a silently truncated path, so the broker's own stat of the path it bound failed with ENOENT;
 * Node 24 refuses the path outright. Such a path now moves to a short per-user directory every caller agrees on.
 */

const extensionDir = join(moduleDir(import.meta.url), "../../packages/intercom");

/** One real broker start (node, jiti and module loading) is far below this even under load. */
const BROKER_BUDGET_MS = 10_000;

const POLL_INTERVAL_MS = 20;
/** How long one health request waits for the broker's reply before the wait asks again. */
const HEALTH_REPLY_TIMEOUT_MS = 2_000;

const unixOnly = process.platform === "win32" ? test.skip : test;

const tempDirs: string[] = [];
const brokers: SpawnedProcess[] = [];
const clients: IntercomClient[] = [];
let previousRuntimeDir: string | undefined;
/** The base the per-user socket directory is created in, standing in for `$XDG_RUNTIME_DIR`. */
let runtimeDir: string;

/**
 * A directory of this test's. On macOS the system temp directory lies so deep under /var/folders that a per-user socket
 * directory made in it is past the socket path limit already: there these directories go under /tmp, so the only paths
 * past a limit are the ones a test makes long on purpose.
 */
function tempDir(prefix: string): string {
	const dir =
		process.platform === "darwin" ? realpathSync(mkdtempSync(join("/tmp", prefix))) : makeTempDirectory(prefix);
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	runtimeDir = tempDir("5040-");
	process.env.XDG_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
	for (const client of clients.splice(0)) await client.disconnect().catch(() => {});
	for (const broker of brokers.splice(0)) {
		if (broker.exitCode === null) broker.kill("SIGKILL");
		await broker.exited;
	}
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	for (const dir of tempDirs.splice(0)) removeTempDirectory(dir);
});

/** An agent directory whose `intercom/broker.sock` is exactly `socketPathBytes` bytes long. */
function agentDirWithSocketPathBytes(socketPathBytes: number, filler = "a", base = tempDir("ic5040-")): string {
	const fixed = Buffer.byteLength(join(base, "agent-", "intercom", "broker.sock"));
	const fillerBytes = Buffer.byteLength(filler);
	const remaining = socketPathBytes - fixed;
	assert.ok(remaining >= 0, "the temp directory leaves no room for this length");
	const agentDir = join(
		base,
		`agent-${filler.repeat(Math.floor(remaining / fillerBytes))}${"a".repeat(remaining % fillerBytes)}`,
	);
	assert.equal(Buffer.byteLength(join(agentDir, "intercom", "broker.sock")), socketPathBytes);
	return agentDir;
}

test("a broker socket path within the platform limit stays in the agent directory (#5040)", () => {
	// Only the path's length matters here, so a short made-up directory keeps it independent of the real temp directory.
	const synthetic = join(sep, "s");
	const linuxLimit = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux"), "a", synthetic);
	const darwinLimit = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("darwin"), "a", synthetic);

	assert.equal(getBrokerSocketPath("linux", linuxLimit), join(linuxLimit, "intercom", "broker.sock"));
	assert.equal(getBrokerSocketPath("darwin", darwinLimit), join(darwinLimit, "intercom", "broker.sock"));
});

unixOnly("a broker socket path past the platform limit moves to a private per-user directory (#5040)", () => {
	// 104 bytes: within Linux's limit, one byte past macOS's.
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("darwin") + 1);
	const otherAgentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("darwin") + 1, "b");

	const darwinPath = getBrokerSocketPath("darwin", agentDir);

	assert.equal(getBrokerSocketPath("linux", agentDir), join(agentDir, "intercom", "broker.sock"));
	assert.equal(dirname(darwinPath), join(runtimeDir, `atomic-intercom-${process.getuid?.()}`));
	assert.match(basename(darwinPath), /^[0-9a-f]{16}\.sock$/u);
	assert.ok(Buffer.byteLength(darwinPath) <= maxUnixSocketPathBytes("darwin"), darwinPath);
	assert.equal(getBrokerSocketPath("darwin", agentDir), darwinPath, "every caller must derive the same path");
	assert.notEqual(getBrokerSocketPath("darwin", otherAgentDir), darwinPath);
	const directory = lstatSync(dirname(darwinPath));
	assert.deepEqual(
		{ directory: directory.isDirectory(), uid: directory.uid, mode: directory.mode & 0o777 },
		{ directory: true, uid: process.getuid?.(), mode: 0o700 },
	);
});

unixOnly("the socket path limit counts bytes, not characters (#5040)", () => {
	// Two bytes per character: 108 bytes in fewer than 107 characters.
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1, "é");
	assert.ok(join(agentDir, "intercom", "broker.sock").length <= maxUnixSocketPathBytes("linux"));

	const socketPath = getBrokerSocketPath("linux", agentDir);

	assert.equal(dirname(socketPath), join(runtimeDir, `atomic-intercom-${process.getuid?.()}`));
});

/** A runtime directory whose per-user socket path, for any agent directory, is exactly `socketPathBytes` long. */
function runtimeDirWithSocketPathBytes(socketPathBytes: number): string {
	const base = tempDir("5040-rt-");
	const fixed = Buffer.byteLength(join(base, "r", `atomic-intercom-${process.getuid?.()}`, `${"0".repeat(16)}.sock`));
	const remaining = socketPathBytes - fixed;
	assert.ok(remaining >= 0, "the temp directory leaves no room for this length");
	const dir = join(base, `r${"r".repeat(remaining)}`);
	makeDirectorySync(dir, { recursive: true });
	return dir;
}

unixOnly("a per-user socket path at the limit is used, and one past it is refused, naming both paths (#5040)", () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);
	process.env.XDG_RUNTIME_DIR = runtimeDirWithSocketPathBytes(maxUnixSocketPathBytes("linux"));
	const atLimit = getBrokerSocketPath("linux", agentDir);
	process.env.XDG_RUNTIME_DIR = runtimeDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);

	assert.equal(Buffer.byteLength(atLimit), maxUnixSocketPathBytes("linux"));
	assert.throws(
		() => getBrokerSocketPath("linux", agentDir),
		(error: Error) =>
			error.message.includes(join(agentDir, "intercom", "broker.sock")) &&
			error.message.includes(process.env.XDG_RUNTIME_DIR ?? "") &&
			error.message.includes("107 bytes"),
	);
});

test("a Windows pipe name keeps the agent directory unless it is longer than 256 characters (#5040)", () => {
	const fits = `C:\\${"a".repeat(256 - "\\\\.\\pipe\\pi-intercom-c-".length)}`;
	const tooLong = `${fits}a`;

	const fitting = getBrokerSocketPath("win32", fits);
	const digested = getBrokerSocketPath("win32", tooLong);

	assert.equal(fitting, `\\\\.\\pipe\\pi-intercom-c-${"a".repeat(256 - "\\\\.\\pipe\\pi-intercom-c-".length)}`);
	assert.equal(fitting.length, 256);
	assert.match(digested, /^\\\\\.\\pipe\\pi-intercom-[0-9a-f]{16}$/u);
	assert.notEqual(getBrokerSocketPath("win32", `${tooLong}b`), digested);
});

unixOnly("a per-user socket directory another user could enter is refused, naming it (#5040)", () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);
	const directory = join(runtimeDir, `atomic-intercom-${process.getuid?.()}`);
	makeDirectorySync(directory, { recursive: true });
	chmodSync(directory, 0o755);

	assert.throws(
		() => getBrokerSocketPath("linux", agentDir),
		(error: Error) => error.message.includes(directory) && error.message.includes("mode 755"),
	);
});

unixOnly("a per-user socket directory that is a symbolic link is refused, naming it (#5040)", () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);
	const directory = join(runtimeDir, `atomic-intercom-${process.getuid?.()}`);
	const elsewhere = tempDir("5040-elsewhere-");
	chmodSync(elsewhere, 0o700);
	symlinkSync(elsewhere, directory);

	assert.throws(
		() => getBrokerSocketPath("linux", agentDir),
		(error: Error) => error.message.includes(directory) && error.message.includes("symbolic link"),
	);
});

// Only root can give a directory to another user.
const rootOnly = process.getuid?.() === 0 ? test : test.skip;

rootOnly("a per-user socket directory another user owns is refused, naming it (#5040)", () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);
	const directory = join(runtimeDir, "atomic-intercom-0");
	makeDirectorySync(directory, { recursive: true });
	chmodSync(directory, 0o700);
	chownSync(directory, 65534, 65534);

	assert.throws(
		() => getBrokerSocketPath("linux", agentDir),
		(error: Error) => error.message.includes(directory) && error.message.includes("owned by uid 65534"),
	);
});

/** Starts a real broker for `agentDir`, optionally with a preload that runs before any broker code. */
function spawnBroker(agentDir: string, preload?: string, env: Record<string, string | undefined> = {}) {
	const imports = preload === undefined ? [] : ["--import", pathToFileURL(preload).href];
	const broker = spawnProcess(
		[process.execPath, ...imports, getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined, ...env },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	brokers.push(broker);
	return { broker, stderr: readStreamText(broker.stderr) };
}

/**
 * Whether the broker answers a health request on `socketPath`. A socket that accepts a connection may belong to a broker
 * still starting, before it handles signals; one that answers a request has started.
 */
async function answersHealth(socketPath: string): Promise<boolean> {
	if (!(await isSocketAnswering(socketPath))) return false;
	return new Promise((resolve) => {
		const requestId = randomUUID();
		const socket = net.connect(socketPath);
		let received = Buffer.alloc(0);
		const finish = (answered: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(answered);
		};
		const timer = setTimeout(() => finish(false), HEALTH_REPLY_TIMEOUT_MS);
		socket.on("error", () => finish(false));
		socket.on("connect", () => {
			const payload = Buffer.from(JSON.stringify({ type: "health", requestId }));
			const header = Buffer.alloc(4);
			header.writeUInt32BE(payload.length);
			socket.write(Buffer.concat([header, payload]));
		});
		socket.on("data", (data) => {
			received = Buffer.concat([received, data]);
			if (received.length < 4 || received.length < received.readUInt32BE(0) + 4) return;
			const reply = JSON.parse(received.subarray(4, received.readUInt32BE(0) + 4).toString("utf8"));
			finish(reply.type === "health" && reply.requestId === requestId);
		});
	});
}

async function waitUntilAnswering(broker: SpawnedProcess, socketPath: string, stderr: Promise<string>): Promise<void> {
	const deadline = performance.now() + BROKER_BUDGET_MS;
	while (broker.exitCode === null && !(await answersHealth(socketPath)) && performance.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
	}
	if (broker.exitCode !== null) assert.fail(`the broker exited with ${broker.exitCode}:\n${await stderr}`);
}

async function connectSession(socketPath: string, cwd: string): Promise<IntercomClient> {
	const client = new IntercomClient(undefined, { brokerSocketPath: socketPath });
	client.on("error", () => {});
	clients.push(client);
	await client.connect({ cwd, model: "test-model", pid: process.pid, startedAt: 1, lastActivity: 1, name: "session" });
	return client;
}

unixOnly(
	"a broker starts and a session connects when its agent directory's socket path is too long (#5040)",
	async () => {
		const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes(process.platform) + 20);
		const { broker, stderr } = spawnBroker(agentDir);
		const socketPath = getBrokerSocketPath(process.platform, agentDir);

		await waitUntilAnswering(broker, socketPath, stderr);
		const client = await connectSession(socketPath, agentDir);

		assert.equal(client.isConnected(), true);
		assert.equal(broker.exitCode, null, "the broker must stay up");
	},
);

/**
 * A preload that unlinks the socket path just before the broker's stat of it, `times` times. The broker's next stat,
 * of the socket it bound again, writes {@link reboundMarker}: the vanished socket is back and checked.
 */
function unlinkBoundSocketPreload(agentDir: string, socketPath: string, times: number): string {
	const preload = join(agentDir, "unlink-bound-socket.mjs");
	writeTextSync(
		preload,
		[
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const statSync = fs.statSync;",
			"let unlinked = 0;",
			"fs.statSync = function (path, ...rest) {",
			`  if (unlinked < ${times} && path === ${JSON.stringify(socketPath)}) {`,
			"    unlinked += 1;",
			"    fs.unlinkSync(path);",
			`  } else if (unlinked === ${times} && path === ${JSON.stringify(socketPath)}) {`,
			"    unlinked += 1;",
			`    fs.writeFileSync(${JSON.stringify(reboundMarker(agentDir))}, "");`,
			"  }",
			"  return statSync.call(this, path, ...rest);",
			"};",
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
	);
	return preload;
}

function reboundMarker(agentDir: string): string {
	return join(agentDir, "socket-bound-again");
}

unixOnly("a broker whose just-bound socket vanishes binds it again instead of exiting (#5040)", async () => {
	const agentDir = tempDir("ic5040-vanish-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const { broker, stderr } = spawnBroker(agentDir, unlinkBoundSocketPreload(agentDir, socketPath, 1));

	// The first bind answers too, until the preload unlinks it: a session connects only to the socket bound again.
	const deadline = performance.now() + BROKER_BUDGET_MS;
	while (broker.exitCode === null && !existsSync(reboundMarker(agentDir)) && performance.now() < deadline)
		await sleep(POLL_INTERVAL_MS);
	assert.ok(
		existsSync(reboundMarker(agentDir)),
		`the broker never bound its socket again:\n${broker.exitCode === null ? "" : await stderr}`,
	);
	await waitUntilAnswering(broker, socketPath, stderr);
	const client = await connectSession(socketPath, agentDir);
	const connected = client.isConnected();
	const runningAfterConnect = broker.exitCode === null;
	broker.kill("SIGTERM");
	await broker.exited;

	assert.deepEqual({ connected, runningAfterConnect }, { connected: true, runningAfterConnect: true });
	assert.match(await stderr, /vanished after it was bound; binding it again/u);
});

unixOnly("a broker whose bound socket keeps vanishing gives up after its listen attempts (#5040)", async () => {
	const agentDir = tempDir("ic5040-vanish-always-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const { broker, stderr } = spawnBroker(agentDir, unlinkBoundSocketPreload(agentDir, socketPath, 1_000));

	const exitCode = await Promise.race([broker.exited, sleep(BROKER_BUDGET_MS).then(() => "still running")]);
	const output = await stderr;

	assert.equal(exitCode, 1, output);
	assert.equal(output.match(/binding it again/gu)?.length, 4, output);
	assert.match(output, /could not listen on .*: the socket vanished after it was bound/u);
	assert.deepEqual(
		{
			pidFile: existsSync(getBrokerPidPath(agentDir)),
			lock: existsSync(getBrokerSocketReplacementLockPath(agentDir)),
		},
		{ pidFile: false, lock: false },
	);
});

unixOnly("a retiring broker that cannot take the socket lock exits without unlinking the socket (#5040)", async () => {
	const agentDir = tempDir("ic5040-locked-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const { broker, stderr } = spawnBroker(agentDir);
	await waitUntilAnswering(broker, socketPath, stderr);
	const release = await acquireSocketReplacementLock(getBrokerSocketReplacementLockPath(agentDir));

	try {
		broker.kill("SIGTERM");
		const exitCode = await Promise.race([broker.exited, sleep(BROKER_BUDGET_MS).then(() => "still running")]);

		assert.deepEqual({ exitCode, socketLeft: existsSync(socketPath) }, { exitCode: 0, socketLeft: true });
	} finally {
		release();
	}
});

unixOnly("a retiring broker whose pid file names another broker leaves the socket (#5040)", async () => {
	const agentDir = tempDir("ic5040-not-owner-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const { broker, stderr } = spawnBroker(agentDir);
	await waitUntilAnswering(broker, socketPath, stderr);
	writeTextSync(getBrokerPidPath(agentDir), String(process.pid));

	broker.kill("SIGTERM");
	const exitCode = await broker.exited;

	assert.deepEqual({ exitCode, socketLeft: existsSync(socketPath) }, { exitCode: 0, socketLeft: true });
});

unixOnly("a retiring broker still removes the socket it owns (#5040)", async () => {
	const agentDir = tempDir("ic5040-retire-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const { broker, stderr } = spawnBroker(agentDir);
	await waitUntilAnswering(broker, socketPath, stderr);

	broker.kill("SIGTERM");
	const exitCode = await broker.exited;

	assert.deepEqual(
		{ exitCode, socketLeft: existsSync(socketPath), record: existsSync(getBrokerSocketPathRecordPath(agentDir)) },
		{ exitCode: 0, socketLeft: false, record: false },
	);
});

unixOnly("every spelling of one long agent directory gets the same broker socket (#5040)", () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);
	const socketPath = getBrokerSocketPath("linux", agentDir);

	assert.deepEqual(
		[`${agentDir}${sep}`, `${agentDir}${sep}x${sep}..`].map((spelling) => getBrokerSocketPath("linux", spelling)),
		[socketPath, socketPath],
	);
});

/** A process's runtime and temp directories, as a terminal and a service of one user can have different ones. */
interface ProcessDirectories {
	readonly XDG_RUNTIME_DIR: string | undefined;
	readonly TMPDIR: string;
}

function processDirectories(xdg: boolean): ProcessDirectories {
	const dir = tempDir(xdg ? "5040-xdg-" : "5040-tmp-");
	return { XDG_RUNTIME_DIR: xdg ? dir : undefined, TMPDIR: dir };
}

/** Runs `fn` with this process's environment set as a process with `directories` would have it. */
function withDirectories<T>(directories: ProcessDirectories, fn: () => T): T {
	const previous = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: process.env.TMPDIR };
	const set = (name: keyof ProcessDirectories, value: string | undefined) => {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	set("XDG_RUNTIME_DIR", directories.XDG_RUNTIME_DIR);
	set("TMPDIR", directories.TMPDIR);
	try {
		return fn();
	} finally {
		set("XDG_RUNTIME_DIR", previous.XDG_RUNTIME_DIR);
		set("TMPDIR", previous.TMPDIR);
	}
}

function listen(socketPath: string): Promise<net.Server> {
	const server = net.createServer((socket) => socket.on("error", () => {}));
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve(server));
	});
}

unixOnly(
	"a recorded broker socket is found from another runtime directory; a record that is not one is ignored (#5040)",
	async () => {
		const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes(process.platform) + 1);
		makeDirectorySync(getIntercomDirPath(agentDir), { recursive: true });
		const terminal = processDirectories(true);
		const service = processDirectories(false);
		const terminalSocket = withDirectories(terminal, () => chooseBrokerSocketPath(process.platform, agentDir));
		const serviceSocket = withDirectories(service, () => chooseBrokerSocketPath(process.platform, agentDir));
		const terminalDirectory = dirname(terminalSocket);
		const otherAgentSocket = join(terminalDirectory, `${"0".repeat(16)}.sock`);
		const terminalServer = await listen(terminalSocket);
		const otherAgentServer = await listen(otherAgentSocket);
		const resolvedFromService = () => withDirectories(service, () => getBrokerSocketPath(process.platform, agentDir));
		const recordPath = getBrokerSocketPathRecordPath(agentDir);

		try {
			const withoutRecord = resolvedFromService();
			withDirectories(terminal, () => recordBrokerSocketPath(terminalSocket, agentDir));
			const recordMode = lstatSync(recordPath).mode & 0o777;
			const recorded = resolvedFromService();
			// Each record below fails one check that every other check would let through.
			const strangers = {
				unnormalized: [terminalDirectory, "..", basename(terminalDirectory), basename(terminalSocket)].join(sep),
				otherAgentDir: otherAgentSocket,
				missingDirectory: join(
					tempDir("5040-gone-"),
					"gone",
					basename(terminalDirectory),
					basename(terminalSocket),
				),
			};
			const ignored: Record<string, string> = {};
			for (const [name, content] of Object.entries(strangers)) {
				writeTextSync(recordPath, content);
				ignored[name] = resolvedFromService();
			}
			writeTextSync(recordPath, terminalSocket);
			chmodSync(terminalDirectory, 0o755);
			ignored.openDirectory = resolvedFromService();
			chmodSync(terminalDirectory, 0o700);
			await new Promise<void>((resolve) => terminalServer.close(() => resolve()));
			writeTextSync(terminalSocket, "");
			ignored.notASocket = resolvedFromService();

			assert.notEqual(terminalSocket, serviceSocket);
			assert.deepEqual(
				{ withoutRecord, recorded, recordMode },
				{ withoutRecord: serviceSocket, recorded: terminalSocket, recordMode: 0o600 },
			);
			assert.deepEqual(ignored, {
				unnormalized: serviceSocket,
				otherAgentDir: serviceSocket,
				missingDirectory: serviceSocket,
				openDirectory: serviceSocket,
				notASocket: serviceSocket,
			});
		} finally {
			terminalServer.close();
			otherAgentServer.close();
		}
	},
);

/** A session client for `agentDir` that finds its broker as a process with `directories` would. */
async function connectFrom(agentDir: string, directories: ProcessDirectories, name: string): Promise<IntercomClient> {
	const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	const client = new IntercomClient();
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	client.on("error", () => {});
	clients.push(client);
	await withDirectories(directories, () =>
		client.connect({ cwd: agentDir, model: "test-model", pid: process.pid, startedAt: 1, lastActivity: 1, name }),
	);
	return client;
}

unixOnly(
	"a terminal and a service with different runtime directories share one broker for a long agent directory (#5040)",
	async () => {
		const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes(process.platform) + 20);
		const terminal = processDirectories(true);
		const service = processDirectories(false);
		const first = spawnBroker(agentDir, undefined, { ...terminal });
		const socketPath = withDirectories(terminal, () => chooseBrokerSocketPath(process.platform, agentDir));
		await waitUntilAnswering(first.broker, socketPath, first.stderr);

		const second = spawnBroker(agentDir, undefined, { ...service });
		const secondExit = await Promise.race([
			second.broker.exited,
			sleep(BROKER_BUDGET_MS).then(() => "still running"),
		]);
		const terminalSession = await connectFrom(agentDir, terminal, "terminal-session");
		const serviceSession = await connectFrom(agentDir, service, "service-session");
		const seenByService = (await serviceSession.listSessions()).map((session) => session.name);

		assert.equal(secondExit, 0, await second.stderr);
		assert.match(await second.stderr, /a live broker already answers/u);
		assert.equal(readTextSync(getBrokerPidPath(agentDir), "utf8").trim(), String(first.broker.pid));
		assert.equal(terminalSession.isConnected(), true);
		assert.ok(seenByService.includes("terminal-session"), JSON.stringify(seenByService));
	},
);

unixOnly(
	"when the recorded broker is gone, a broker from another runtime directory takes over and sessions follow it (#5040)",
	async () => {
		const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes(process.platform) + 20);
		const terminal = processDirectories(true);
		const service = processDirectories(false);
		const first = spawnBroker(agentDir, undefined, { ...terminal });
		const terminalSocket = withDirectories(terminal, () => chooseBrokerSocketPath(process.platform, agentDir));
		await waitUntilAnswering(first.broker, terminalSocket, first.stderr);
		const session = await connectFrom(agentDir, terminal, "terminal-session");
		await session.disconnect();
		first.broker.kill("SIGTERM");
		await first.broker.exited;

		const second = spawnBroker(agentDir, undefined, { ...service });
		const serviceSocket = withDirectories(service, () => chooseBrokerSocketPath(process.platform, agentDir));
		await waitUntilAnswering(second.broker, serviceSocket, second.stderr);
		await withDirectories(terminal, () =>
			session.connect({
				cwd: agentDir,
				model: "test-model",
				pid: process.pid,
				startedAt: 1,
				lastActivity: 1,
				name: "terminal-session",
			}),
		);

		assert.equal(readTextSync(getBrokerSocketPathRecordPath(agentDir), "utf8").trim(), serviceSocket);
		assert.equal(session.isConnected(), true);
		assert.equal(second.broker.exitCode, null);
	},
);

unixOnly("a broker that cannot record its socket path still starts, and says why (#5040)", async () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes(process.platform) + 20);
	// A directory where the record goes makes writing it fail.
	makeDirectorySync(getBrokerSocketPathRecordPath(agentDir), { recursive: true });
	const { broker, stderr } = spawnBroker(agentDir);
	const socketPath = chooseBrokerSocketPath(process.platform, agentDir);

	await waitUntilAnswering(broker, socketPath, stderr);
	const client = await connectSession(socketPath, agentDir);
	const connected = client.isConnected();
	broker.kill("SIGTERM");
	await broker.exited;

	assert.equal(connected, true);
	assert.match(await stderr, new RegExp(`could not record its socket path ${socketPath}`, "u"));
});
