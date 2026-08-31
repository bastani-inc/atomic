/**
 * Stop a detached Intercom broker that outlived a disposable test agent dir.
 *
 * Ordinary Intercom is mandatory, so `enabled: false` no longer keeps the broker
 * out of fixture agent directories. The broker holds `broker.log` open, which
 * makes Windows `rmSync` fail with EBUSY.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Terminate the broker recorded at `{agentDir}/intercom/broker.pid`, if any. */
export function stopDetachedBroker(agentDir: string): void {
	const pidPath = join(agentDir, "intercom", "broker.pid");
	if (!existsSync(pidPath)) return;
	const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already exited.
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// SIGTERM was enough, or the process was already gone.
	}
}

/**
 * Stop the broker under `{root}/agent` (or `agentDir`) and delete `root`.
 *
 * `maxRetries` absorbs the brief Windows handle delay after the process dies.
 */
export function removeTempRootReleasingBroker(root: string, agentDir = join(root, "agent")): void {
	stopDetachedBroker(agentDir);
	if (!existsSync(root)) return;
	rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
