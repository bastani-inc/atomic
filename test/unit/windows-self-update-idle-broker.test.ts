import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import * as windowsSelfUpdate from "../../packages/coding-agent/src/utils/windows-self-update.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import * as brokerControl from "../../packages/intercom/broker/control.js";
import { getBrokerPidPath, getBrokerSocketPath, getIntercomDirPath } from "../../packages/intercom/broker/paths.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { moduleDir, removePathSync } from "../helpers/runtime.js";

const REPO = resolve(moduleDir(import.meta.url), "../..");
const BUILT_INTERCOM_DIR = join(REPO, "packages", "coding-agent", "dist", "builtin", "intercom");

const tempRoots: string[] = [];
const agentDirs: string[] = [];
const activeClients: IntercomClient[] = [];
const activeServers: net.Server[] = [];
const savedEnv = {
	atomicAgentDir: process.env.ATOMIC_CODING_AGENT_DIR,
	piAgentDir: process.env.PI_CODING_AGENT_DIR,
};

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	while (activeClients.length > 0) {
		try {
			activeClients.pop()!.disconnect();
		} catch {}
	}
	while (activeServers.length > 0) {
		const server = activeServers.pop()!;
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
	while (agentDirs.length > 0) {
		await stopDetachedBroker(agentDirs.pop()!);
	}
	if (savedEnv.atomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = savedEnv.atomicAgentDir;
	if (savedEnv.piAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv.piAgentDir;
	while (tempRoots.length > 0) {
		removePathSync(tempRoots.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
});

describe("stopIdleIntercomBroker (idle-only, never interrupts connected sessions)", () => {
	test("returns not-running when no broker is running", async () => {
		const agentDir = makeTempDir("ic-idle-none-");
		const stopIdle = (brokerControl as Record<string, unknown>).stopIdleIntercomBroker as
			| ((dir: string, opts?: { stopTimeoutMs?: number }) => Promise<{ status: string }>)
			| undefined;
		assert.equal(typeof stopIdle, "function", "stopIdleIntercomBroker must be exported");
		const outcome = await stopIdle!(agentDir);
		assert.deepEqual(outcome, { status: "not-running" });
	});

	test("stops a running broker with 0 connected sessions and leaves a broker with connected sessions untouched", async () => {
		const stopIdle = (brokerControl as Record<string, unknown>).stopIdleIntercomBroker as
			| ((dir: string, opts?: { stopTimeoutMs?: number }) => Promise<Record<string, unknown>>)
			| undefined;
		assert.equal(typeof stopIdle, "function", "stopIdleIntercomBroker must be exported");

		const agentDir = makeTempDir("ic-idle-live-");
		agentDirs.push(agentDir);
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CODING_AGENT_DIR;

		await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 20_000, BUILT_INTERCOM_DIR);
		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);

		// Connect a live session: idle stop MUST refuse and keep the broker + session intact.
		const client = new IntercomClient("session-connected-1");
		activeClients.push(client);
		const now = Date.now();
		await client.connect({
			name: "connected-worker",
			cwd: agentDir,
			model: "test-model",
			pid: process.pid,
			group: "default",
			startedAt: now,
			lastActivity: now,
		});

		const busyOutcome = await stopIdle!(agentDir);
		assert.equal(busyOutcome.status, "busy");
		assert.equal(busyOutcome.pid, pid);
		assert.equal(busyOutcome.sessions, 1);

		// Session still communicates with the exact same broker.
		const statusWhileConnected = await brokerControl.queryIntercomBroker(agentDir);
		assert.equal(statusWhileConnected.state, "running");
		if (statusWhileConnected.state === "running") {
			assert.equal(statusWhileConnected.report.pid, pid);
			assert.equal(statusWhileConnected.report.sessions, 1);
		}

		// Disconnect the session so sessions === 0, then idle stop MUST shut down the broker cleanly.
		client.disconnect();
		activeClients.pop();

		// Wait briefly for disconnect to register on broker (0 sessions) before the 5s idle timeout.
		for (let i = 0; i < 40; i++) {
			const q = await brokerControl.queryIntercomBroker(agentDir);
			if (q.state === "running" && q.report.sessions === 0) break;
			await new Promise((r) => setTimeout(r, 25));
		}

		const stoppedOutcome = await stopIdle!(agentDir);
		assert.equal(stoppedOutcome.status, "stopped");
		assert.equal(stoppedOutcome.pid, pid);

		const afterStop = await brokerControl.queryIntercomBroker(agentDir);
		assert.equal(afterStop.state, "stopped");
	});

	test("never stops a legacy broker whose session count is unreported", async () => {
		const stopIdle = (brokerControl as Record<string, unknown>).stopIdleIntercomBroker as
			| ((dir: string, opts?: { stopTimeoutMs?: number }) => Promise<Record<string, unknown>>)
			| undefined;
		assert.equal(typeof stopIdle, "function", "stopIdleIntercomBroker must be exported");

		const agentDir = makeTempDir("ic-idle-legacy-");
		mkdirSync(getIntercomDirPath(agentDir), { recursive: true });
		// A fake legacy listener drops `broker_status` connections without answering.
		const socketPath = getBrokerSocketPath(process.platform, agentDir);
		const server = net.createServer((socket) => {
			socket.once("data", () => socket.destroy());
		});
		activeServers.push(server);
		await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
		// Record current process pid as an alive legacy pid only on POSIX (no kill will happen).
		writeFileSync(getBrokerPidPath(agentDir), `${process.pid}\n`, "utf8");

		const outcome = await stopIdle!(agentDir);
		assert.equal(outcome.status, "unreported");
	});
});

describe("Windows npm install-directory lock error classifier", () => {
	test("recognizes Windows npm 10 and npm 11 EBUSY/EPERM rename and unlink lock failures", () => {
		const classify = (windowsSelfUpdate as Record<string, unknown>).isWindowsInstallDirectoryLockError as
			| ((output: string) => boolean)
			| undefined;
		assert.equal(typeof classify, "function", "isWindowsInstallDirectoryLockError must be exported");

		const npm10Ebusy = [
			"npm error code EBUSY",
			"npm error syscall rename",
			"npm error path C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani\\atomic\\dist\\builtin\\intercom",
			"npm error dest C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani\\.atomic-Mmp7s2RH\\dist\\builtin\\intercom",
			"npm error errno -4082",
			"npm error EBUSY: resource busy or locked, rename 'C:\\...\\dist\\builtin\\intercom' -> 'C:\\...\\.atomic-Mmp7s2RH\\dist\\builtin\\intercom'",
		].join("\n");
		assert.equal(classify!(npm10Ebusy), true);

		const npm11Eperm = [
			"npm error code EPERM",
			"npm error syscall unlink",
			"npm error errno -4048",
			"npm error EPERM: operation not permitted, unlink 'C:\\prefix\\node_modules\\@bastani\\atomic\\dist\\cli.js'",
		].join("\n");
		assert.equal(classify!(npm11Eperm), true);

		const legacyErrFormat = "npm ERR! code EBUSY\nnpm ERR! syscall rmdir\nnpm ERR! errno -4082";
		assert.equal(classify!(legacyErrFormat), true);
	});

	test("returns false for unrelated npm failures (E404, network, EPERM mkdir, empty output)", () => {
		const classify = (windowsSelfUpdate as Record<string, unknown>).isWindowsInstallDirectoryLockError as
			| ((output: string) => boolean)
			| undefined;
		assert.equal(typeof classify, "function", "isWindowsInstallDirectoryLockError must be exported");

		assert.equal(classify!(""), false);
		assert.equal(
			classify!("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@bastani/atomic"),
			false,
		);
		assert.equal(classify!("npm error code ENOTFOUND\nnpm error syscall getaddrinfo"), false);
		assert.equal(
			classify!("npm error code EPERM\nnpm error syscall mkdir\nnpm error path C:\\Program Files\\nodejs"),
			false,
		);
		assert.equal(classify!("npm error code EACCES\nnpm error syscall open"), false);
	});
});
