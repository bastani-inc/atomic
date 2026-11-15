import assert from "node:assert/strict";
// `lstatSync`, `chmodSync` and `symlinkSync` have no equivalent in test/helpers/runtime.ts: the socket directory's
// owner, mode and kind are what these tests pin.
import { chmodSync, chownSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import {
	getBrokerPidPath,
	getBrokerSocketPath,
	getBrokerSocketReplacementLockPath,
	maxUnixSocketPathBytes,
} from "../../packages/intercom/broker/paths.js";
import { isSocketAnswering } from "../../packages/intercom/broker/socket-liveness.js";
import { acquireSocketReplacementLock } from "../../packages/intercom/broker/socket-replacement-lock.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	readStreamText,
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

const unixOnly = process.platform === "win32" ? test.skip : test;

const tempDirs: string[] = [];
const brokers: SpawnedProcess[] = [];
const clients: IntercomClient[] = [];
let previousRuntimeDir: string | undefined;
/** The base the per-user socket directory is created in, standing in for `$XDG_RUNTIME_DIR`. */
let runtimeDir: string;

function tempDir(prefix: string): string {
	const dir = makeTempDirectory(prefix);
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
function agentDirWithSocketPathBytes(socketPathBytes: number, filler = "a"): string {
	const base = tempDir("ic5040-");
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
	const linuxLimit = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux"));
	const darwinLimit = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("darwin"));

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
function spawnBroker(agentDir: string, preload?: string) {
	const imports = preload === undefined ? [] : ["--import", pathToFileURL(preload).href];
	const broker = spawnProcess(
		[process.execPath, ...imports, getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	brokers.push(broker);
	return { broker, stderr: readStreamText(broker.stderr) };
}

async function waitUntilAnswering(broker: SpawnedProcess, socketPath: string, stderr: Promise<string>): Promise<void> {
	const deadline = performance.now() + BROKER_BUDGET_MS;
	while (broker.exitCode === null && !(await isSocketAnswering(socketPath)) && performance.now() < deadline) {
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

/** A preload that unlinks the socket path just before the broker's stat of it, `times` times. */
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
			"  }",
			"  return statSync.call(this, path, ...rest);",
			"};",
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
	);
	return preload;
}

unixOnly("a broker whose just-bound socket vanishes binds it again instead of exiting (#5040)", async () => {
	const agentDir = tempDir("ic5040-vanish-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const { broker, stderr } = spawnBroker(agentDir, unlinkBoundSocketPreload(agentDir, socketPath, 1));

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

	assert.deepEqual({ exitCode, socketLeft: existsSync(socketPath) }, { exitCode: 0, socketLeft: false });
});
