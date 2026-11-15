import assert from "node:assert/strict";
// `lstatSync`, `chmodSync` and `symlinkSync` have no equivalent in test/helpers/runtime.ts: the socket directory's
// owner, mode and kind are what these tests pin.
import { chmodSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { getBrokerSocketPath, maxUnixSocketPathBytes } from "../../packages/intercom/broker/paths.js";
import { isSocketAnswering } from "../../packages/intercom/broker/socket-liveness.js";
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

test("a broker socket path past the platform limit moves to a private per-user directory (#5040)", () => {
	// 104 bytes: within Linux's limit, one byte past macOS's.
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("darwin") + 1);
	const otherAgentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("darwin") + 1, "b");

	const darwinPath = getBrokerSocketPath("darwin", agentDir);

	assert.equal(getBrokerSocketPath("linux", agentDir), join(agentDir, "intercom", "broker.sock"));
	assert.ok(darwinPath.startsWith(join(runtimeDir, "atomic-intercom-")), darwinPath);
	assert.ok(Buffer.byteLength(darwinPath) <= maxUnixSocketPathBytes("darwin"), darwinPath);
	assert.equal(getBrokerSocketPath("darwin", agentDir), darwinPath, "every caller must derive the same path");
	assert.notEqual(getBrokerSocketPath("darwin", otherAgentDir), darwinPath);
	if (process.platform !== "win32") {
		const directory = lstatSync(join(darwinPath, ".."));
		assert.deepEqual(
			{ directory: directory.isDirectory(), uid: directory.uid, mode: directory.mode & 0o777 },
			{ directory: true, uid: process.getuid?.(), mode: 0o700 },
		);
	}
});

test("the socket path limit counts bytes, not characters (#5040)", () => {
	// Two bytes per character: 108 bytes in fewer than 107 characters.
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1, "é");
	assert.ok(join(agentDir, "intercom", "broker.sock").length <= maxUnixSocketPathBytes("linux"));

	const socketPath = getBrokerSocketPath("linux", agentDir);

	assert.ok(socketPath.startsWith(join(runtimeDir, "atomic-intercom-")), socketPath);
});

unixOnly("a per-user socket directory another user could enter is refused, naming it (#5040)", () => {
	const agentDir = agentDirWithSocketPathBytes(maxUnixSocketPathBytes("linux") + 1);
	const directory = join(runtimeDir, `atomic-intercom-${process.getuid?.()}`);
	makeDirectorySync(directory, { recursive: true });
	chmodSync(directory, 0o755);

	assert.throws(
		() => getBrokerSocketPath("linux", agentDir),
		(error: Error) => error.message.includes(directory),
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
		(error: Error) => error.message.includes(directory),
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

unixOnly("a broker whose just-bound socket vanishes binds it again instead of exiting (#5040)", async () => {
	const agentDir = tempDir("ic5040-vanish-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const preload = join(agentDir, "unlink-bound-socket-once.mjs");
	// The first stat of the socket path, the broker's check of what it just bound, finds the path already unlinked.
	writeTextSync(
		preload,
		[
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const statSync = fs.statSync;",
			"let unlinked = false;",
			"fs.statSync = function (path, ...rest) {",
			`  if (!unlinked && path === ${JSON.stringify(socketPath)}) {`,
			"    unlinked = true;",
			"    fs.unlinkSync(path);",
			"  }",
			"  return statSync.call(this, path, ...rest);",
			"};",
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
	);
	const { broker, stderr } = spawnBroker(agentDir, preload);

	await waitUntilAnswering(broker, socketPath, stderr);
	const client = await connectSession(socketPath, agentDir);

	assert.equal(client.isConnected(), true);
	assert.equal(broker.exitCode, null, "the broker must stay up");
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
