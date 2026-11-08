import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";

/** Two real detached brokers started through jiti, one per agent directory. */
const TWO_BROKER_STARTUP_TIMEOUT_MS = 60_000;

// Short root: a Unix socket path must fit in about 104 bytes.
const root = mkdtempSync(join(tmpdir(), "icdir-"));
const firstAgentDir = join(root, "a");
const secondAgentDir = join(root, "b");

const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = firstAgentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { spawnBrokerIfNeeded } = await import("../../packages/intercom/broker/spawn.js");
const { getBrokerPidPath } = await import("../../packages/intercom/broker/paths.js");
const { queryBrokerRouting } = await import("../../packages/intercom/broker/broker-routing.js");

function stopBroker(agentDir: string): void {
	const pidPath = getBrokerPidPath(agentDir);
	if (!existsSync(pidPath)) return;
	const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	if (!Number.isFinite(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// The broker already exited.
	}
}

afterAll(() => {
	stopBroker(firstAgentDir);
	stopBroker(secondAgentDir);
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	if (originalPiAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("agent directory changed inside one process", () => {
	test(
		"a later session starts and reaches the broker of its own agent directory (#4561)",
		async () => {
			await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
			await queryBrokerRouting(firstAgentDir);

			process.env.ATOMIC_CODING_AGENT_DIR = secondAgentDir;
			await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);

			assert.ok(existsSync(getBrokerPidPath(secondAgentDir)), "no broker was started for the new agent directory");
			const routing = await queryBrokerRouting(secondAgentDir);
			assert.equal(routing.acrossMachines, false);
		},
		TWO_BROKER_STARTUP_TIMEOUT_MS,
	);
});
