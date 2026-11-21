import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	type DetachedBrokerProbe,
	removeTempRootReleasingBroker,
	stopDetachedBroker,
} from "../helpers/detached-broker.js";
import {
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removePathSync,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A stand-in broker: it listens on the agent dir's broker socket, answers `broker_status` with its own pid as a broker
 * does, records its pid in `broker.pid` once it listens, and with `holdLog` keeps `broker.log` open.
 */
const STAND_IN_BROKER = `const fs = require("node:fs");
const net = require("node:net");
const [socketPath, pidPath, logPath] = process.argv.slice(1);
if (logPath) fs.openSync(logPath, "a");
const frame = (message) => {
	const payload = Buffer.from(JSON.stringify(message));
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
};
net.createServer((socket) => {
	socket.on("error", () => {});
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
			const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString("utf8"));
			buffer = buffer.subarray(4 + buffer.readUInt32BE(0));
			if (message.type !== "broker_status") continue;
			const report = { pid: process.pid, sessions: 0, multiNode: { status: "off" } };
			socket.write(frame({ type: "broker_status", requestId: message.requestId, report }));
		}
	});
}).listen(socketPath, () => fs.writeFileSync(pidPath, String(process.pid)));
setInterval(() => {}, 1000);`;

/** A started process whose pid is known. */
function started(child: ReturnType<typeof spawnProcess>) {
	const pid = child.pid;
	assert.ok(pid !== undefined, "the process did not start");
	return { pid, kill: (signal: NodeJS.Signals) => child.kill(signal), exited: child.exited };
}

function startStandInBroker(agentDir: string, { holdLog = false }: { readonly holdLog?: boolean } = {}) {
	const intercomDir = join(agentDir, "intercom");
	const args = [getBrokerSocketPath(process.platform, agentDir), join(intercomDir, "broker.pid")];
	return started(
		spawnProcess({
			cmd: [
				process.execPath,
				"-e",
				STAND_IN_BROKER,
				...(holdLog ? [...args, join(intercomDir, "broker.log")] : args),
			],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}),
	);
}

/** A process that is no broker, as a later process given a crashed broker's pid is. */
function startUnrelatedProcess() {
	return started(
		spawnProcess({
			cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}),
	);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!fileExistsSync(path) && Date.now() < deadline) await sleep(20);
	assert.ok(fileExistsSync(path), `${path} was never written`);
}

/** Models the OS boundary through a mocked `process.kill`: the recorded pid is the broker while the mock says it runs. */
function mockedBroker(pid: number): DetachedBrokerProbe {
	return {
		record: async (recorded) => ({ pid: recorded, started: undefined }),
		stillRuns: async (recorded) => processExists(recorded.pid),
		answeringPid: async () => pid,
	};
}

test("stopDetachedBroker is a no-op when no broker pid is recorded", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-missing-");
	makeDirectorySync(join(root, "agent"), { recursive: true });
	await stopDetachedBroker(join(root, "agent"));
	await removeTempRootReleasingBroker(root);
	assert.equal(fileExistsSync(root), false);
});

test("removeTempRootReleasingBroker deletes a disposable agent tree", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-tree-");
	makeDirectorySync(join(root, "agent", "intercom"), { recursive: true });
	writeTextSync(join(root, "agent", "intercom", "broker.log"), "held\n");
	await removeTempRootReleasingBroker(root);
	assert.equal(fileExistsSync(root), false);
});

test("stopDetachedBroker terminates the broker that answers on the agent dir's socket with the recorded pid", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-pid-");
	const agentDir = join(root, "agent");
	makeDirectorySync(join(agentDir, "intercom"), { recursive: true });
	const broker = startStandInBroker(agentDir);
	try {
		await waitForFile(join(agentDir, "intercom", "broker.pid"));
		assert.equal(readTextSync(join(agentDir, "intercom", "broker.pid"), "utf8"), String(broker.pid));
		await stopDetachedBroker(agentDir);
		assert.equal(processExists(broker.pid), false);
	} finally {
		broker.kill("SIGKILL");
		await broker.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
});

test("stopDetachedBroker never signals a process a leftover broker.pid names when no broker answers there (#6125)", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-reused-");
	const agentDir = join(root, "agent");
	makeDirectorySync(join(agentDir, "intercom"), { recursive: true });
	// A broker that crashed left its pid file; its pid now names another process.
	const unrelated = startUnrelatedProcess();
	try {
		writeTextSync(join(agentDir, "intercom", "broker.pid"), String(unrelated.pid));
		await stopDetachedBroker(agentDir);
		assert.equal(processExists(unrelated.pid), true, "the cleanup killed a process that is not the broker");
	} finally {
		unrelated.kill("SIGKILL");
		await unrelated.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
});

test("stopDetachedBroker never signals the process broker.pid names when the broker answering there is another (#6125)", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-other-");
	const agentDir = join(root, "agent");
	const pidPath = join(agentDir, "intercom", "broker.pid");
	makeDirectorySync(join(agentDir, "intercom"), { recursive: true });
	const broker = startStandInBroker(agentDir);
	const unrelated = startUnrelatedProcess();
	try {
		await waitForFile(pidPath);
		writeTextSync(pidPath, String(unrelated.pid));
		await stopDetachedBroker(agentDir);
		assert.equal(processExists(unrelated.pid), true, "the cleanup killed a process that is not the broker");
	} finally {
		unrelated.kill("SIGKILL");
		broker.kill("SIGKILL");
		await Promise.all([unrelated.exited, broker.exited]);
		await removeTempRootReleasingBroker(root, agentDir);
	}
});

// Windows job 102616795865 (#2962): cleanup must wait for the detached file owner.
test("agent-tree cleanup waits for the broker process to exit", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-exit-");
	const agentDir = join(root, "custom agent dir");
	const intercomDir = join(agentDir, "intercom");
	makeDirectorySync(intercomDir, { recursive: true });
	const child = startStandInBroker(agentDir, { holdLog: true });
	try {
		await waitForFile(join(intercomDir, "broker.pid"));
		await removeTempRootReleasingBroker(root, agentDir);
		assert.equal(processExists(child.pid), false, "cleanup returned before the broker exited");
		assert.equal(fileExistsSync(root), false);
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
});

test("agent-tree cleanup retains files until a pending termination is observed", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-pending-");
	const intercomDir = join(root, "agent", "intercom");
	makeDirectorySync(intercomDir, { recursive: true });
	const pid = 123456;
	writeTextSync(join(intercomDir, "broker.pid"), String(pid));
	const logPath = join(intercomDir, "broker.log");
	writeTextSync(logPath, "held by the terminating broker");
	let exited = false;
	// Model the Windows OS boundary: successful signaling precedes handle release.
	const kill = vi.spyOn(process, "kill").mockImplementation((target) => {
		assert.equal(target, pid);
		if (exited) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
		return true;
	});
	const cleanup = removeTempRootReleasingBroker(root, join(root, "agent"), mockedBroker(pid));
	try {
		await sleep(0);
		assert.ok(fileExistsSync(logPath), "do not delete files while the broker still exists");
		exited = true;
		await cleanup;
		assert.equal(fileExistsSync(root), false);
	} finally {
		try {
			exited = true;
			await cleanup;
		} finally {
			kill.mockRestore();
			removePathSync(root, { recursive: true, force: true });
		}
	}
});

// #2963 / Greptile 3972841199: a broker that never exits must retain diagnostics.
test("agent-tree cleanup rejects at the broker deadline and preserves diagnostics", async () => {
	const root = makeTempDirectory("atomic-broker-teardown-timeout-");
	const agentDir = join(root, "custom agent dir");
	const intercomDir = join(agentDir, "intercom");
	makeDirectorySync(intercomDir, { recursive: true });
	const pid = 123456;
	const pidPath = join(intercomDir, "broker.pid");
	const logPath = join(intercomDir, "broker.log");
	const pidContents = `${pid}\n`;
	const logContents = "broker still holds its files\n";
	writeTextSync(pidPath, pidContents);
	writeTextSync(logPath, logContents);
	// Keep the OS liveness boundary successful through the real five-second deadline.
	const kill = vi.spyOn(process, "kill").mockImplementation((target) => {
		assert.equal(target, pid);
		return true;
	});
	try {
		const started = Date.now();
		await assert.rejects(removeTempRootReleasingBroker(root, agentDir, mockedBroker(pid)), {
			message: `Broker ${pid} did not exit; keeping ${agentDir}`,
		});
		assert.ok(Date.now() - started >= 5_000, "the live broker must get the full exit grace period");
		assert.equal(readTextSync(pidPath, "utf8"), pidContents);
		assert.equal(readTextSync(logPath, "utf8"), logContents);
	} finally {
		kill.mockRestore();
		removePathSync(root, { recursive: true, force: true });
	}
});
