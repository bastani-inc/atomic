/**
 * Stop a detached Intercom broker that outlived a disposable test agent dir.
 *
 * Ordinary Intercom is mandatory, so fixture CLI processes can start a broker.
 * It holds log and SQLite handles, so signaling it is not sufficient: Windows
 * cleanup must wait for exit before removing its agent directory.
 *
 * #6125: a broker that crashed leaves `broker.pid` behind, and Windows gives its pid to another process within seconds.
 * So the pid is signalled only while it names the broker that answers on the agent dir's socket: its start is read
 * first, the broker is then asked for its pid, and each signal and wait checks that the pid still names a process that
 * started then (`recorded-process.ts`). A pid no broker answers for is never signalled.
 */
import { join } from "node:path";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "../../packages/intercom/broker/control-request.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { type RecordedProcess, recordProcess, stillRuns } from "./recorded-process.js";
import { fileExistsSync, readTextSync, removePath, sleep } from "./runtime.js";

const BROKER_EXIT_TIMEOUT_MS = 5_000;

/** How the helper tells the agent dir's broker apart from another process; tests of this helper replace it. */
export interface DetachedBrokerProbe {
	/** `pid`, recorded with when it started. */
	record(pid: number): Promise<RecordedProcess>;
	/** Whether `recorded` still runs. */
	stillRuns(recorded: RecordedProcess): Promise<boolean>;
	/** The pid of the broker that answers on `agentDir`'s socket now, if one does. */
	answeringPid(agentDir: string): Promise<number | undefined>;
}

function readRecordedPid(agentDir: string): number | undefined {
	const pidPath = join(agentDir, "intercom", "broker.pid");
	if (!fileExistsSync(pidPath)) return undefined;
	const pid = Number.parseInt(readTextSync(pidPath, "utf8").trim(), 10);
	return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

async function answeringBrokerPid(agentDir: string): Promise<number | undefined> {
	let socketPath: string;
	try {
		socketPath = getBrokerSocketPath(process.platform, agentDir);
	} catch {
		return undefined;
	}
	const answer = await controlRequest(socketPath, "broker_status", "broker_status", BROKER_CONTROL_TIMEOUT_MS);
	if (!answer.connected || answer.reply === undefined) return undefined;
	const reply = answer.reply;
	const report = typeof reply === "object" && reply !== null && !Array.isArray(reply) ? reply.report : undefined;
	// Only the pid the broker states: a reply without one is no proof of which process listens there. A broker of an
	// older version states it too, in a report of an older shape.
	const pid = typeof report === "object" && report !== null && !Array.isArray(report) ? report.pid : undefined;
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

const systemProbe: DetachedBrokerProbe = { record: recordProcess, stillRuns, answeringPid: answeringBrokerPid };

/** Terminate and await the broker recorded at `{agentDir}/intercom/broker.pid`, if it is the broker that answers there. */
export async function stopDetachedBroker(agentDir: string, probe: DetachedBrokerProbe = systemProbe): Promise<void> {
	const pid = readRecordedPid(agentDir);
	if (pid === undefined) return;
	// Read before the broker answers: a process that started after its answer cannot be taken for it.
	const recorded = await probe.record(pid);
	if (!(await probe.stillRuns(recorded))) return;
	if ((await probe.answeringPid(agentDir)) !== pid) return;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!(await probe.stillRuns(recorded))) break;
		try {
			process.kill(pid, signal);
		} catch {
			// Already exited.
		}
	}
	const deadline = Date.now() + BROKER_EXIT_TIMEOUT_MS;
	while (await probe.stillRuns(recorded)) {
		if (Date.now() >= deadline) throw new Error(`Broker ${pid} did not exit; keeping ${agentDir}`);
		await sleep(20);
	}
}

/**
 * Stop the broker under `{root}/agent` (or `agentDir`) and delete `root`.
 *
 * Async removal re-enumerates on ENOTEMPTY while inherited Windows handles close;
 * Node 22's sync removal retries only rmdir after its first directory listing.
 */
export async function removeTempRootReleasingBroker(
	root: string,
	agentDir = join(root, "agent"),
	probe: DetachedBrokerProbe = systemProbe,
): Promise<void> {
	await stopDetachedBroker(agentDir, probe);
	await removePath(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
