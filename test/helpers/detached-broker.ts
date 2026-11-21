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
 * started then (`recorded-process.ts`). A process that does not answer yet is asked again until it answers or exits,
 * for a bounded time; a pid no broker answers for is never signalled.
 */
import { join } from "node:path";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "../../packages/intercom/broker/control-request.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { isGone, type RecordedProcess, recordProcess, stillRuns } from "./recorded-process.js";
import { fileExistsSync, readTextSync, removePath, sleep } from "./runtime.js";

const BROKER_EXIT_TIMEOUT_MS = 5_000;
/**
 * How long a process `broker.pid` names is given to answer as that broker, or to exit: a broker records its pid before
 * it listens, and stops answering while it shuts down.
 */
const BROKER_ANSWER_TIMEOUT_MS = 5_000;
const BROKER_ANSWER_POLL_MS = 50;

/** How the helper tells the agent dir's broker apart from another process; tests of this helper replace it. */
export interface DetachedBrokerProbe {
	/** `pid`, recorded with when it started. */
	record(pid: number): Promise<RecordedProcess>;
	/** Whether `recorded` still runs, so that it may be signalled. */
	stillRuns(recorded: RecordedProcess): Promise<boolean>;
	/** Whether `recorded` is known to have exited. */
	isGone(recorded: RecordedProcess): Promise<boolean>;
	/** The pid of the broker that answers on `agentDir`'s socket within `timeoutMs`, if one does. */
	answeringPid(agentDir: string, timeoutMs: number): Promise<number | undefined>;
}

function readRecordedPid(agentDir: string): number | undefined {
	const pidPath = join(agentDir, "intercom", "broker.pid");
	if (!fileExistsSync(pidPath)) return undefined;
	const pid = Number.parseInt(readTextSync(pidPath, "utf8").trim(), 10);
	return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

async function answeringBrokerPid(agentDir: string, timeoutMs: number): Promise<number | undefined> {
	let socketPath: string;
	try {
		socketPath = getBrokerSocketPath(process.platform, agentDir);
	} catch {
		return undefined;
	}
	const answer = await controlRequest(
		socketPath,
		"broker_status",
		"broker_status",
		Math.min(timeoutMs, BROKER_CONTROL_TIMEOUT_MS),
	);
	if (!answer.connected || answer.reply === undefined) return undefined;
	const reply = answer.reply;
	const report = typeof reply === "object" && reply !== null && !Array.isArray(reply) ? reply.report : undefined;
	// Only the pid the broker states: a reply without one is no proof of which process listens there. A broker of an
	// older version states it too, in a report of an older shape.
	const pid = typeof report === "object" && report !== null && !Array.isArray(report) ? report.pid : undefined;
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** What `read` resolves to, or undefined when `leftMs` runs out first; a later result is dropped. */
async function withinWindow<T>(read: Promise<T>, leftMs: number): Promise<T | undefined> {
	if (leftMs <= 0) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const spent = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), leftMs);
	});
	try {
		return await Promise.race([read, spent]);
	} finally {
		clearTimeout(timer);
	}
}

const systemProbe: DetachedBrokerProbe = { record: recordProcess, stillRuns, isGone, answeringPid: answeringBrokerPid };

export interface StopDetachedBrokerOptions {
	/** Sent in turn while the broker still runs; a crash is simulated with `["SIGKILL"]` alone. */
	readonly signals?: readonly NodeJS.Signals[];
	/** How long the process `broker.pid` names is followed until it answers as the broker; {@link BROKER_ANSWER_TIMEOUT_MS}. */
	readonly answerWindowMs?: number;
	readonly probe?: DetachedBrokerProbe;
}

/**
 * Terminate and await the broker recorded at `{agentDir}/intercom/broker.pid`, if it is the broker that answers there.
 * Returns whether it was signalled.
 *
 * Bounds: until the broker answers, every read of the process's start and every status request shares one answer window
 * (`answerWindowMs`, on a monotonic clock); nothing that comes after it is waited for or taken, and the broker is then
 * not signalled. Once it has answered, the start is read again before each signal, each read bounded by its own timeout,
 * and its exit is waited for up to {@link BROKER_EXIT_TIMEOUT_MS}.
 */
export async function stopDetachedBroker(
	agentDir: string,
	{
		signals = ["SIGTERM", "SIGKILL"],
		answerWindowMs = BROKER_ANSWER_TIMEOUT_MS,
		probe = systemProbe,
	}: StopDetachedBrokerOptions = {},
): Promise<boolean> {
	// One window on a monotonic clock, for every read and request until the broker answers: nothing that comes after it
	// is waited for or taken.
	const answerBy = performance.now() + answerWindowMs;
	const left = () => answerBy - performance.now();
	const pid = readRecordedPid(agentDir);
	if (pid === undefined) return false;
	// Read before the broker answers: a process that started after its answer cannot be taken for it.
	const recorded = await withinWindow(probe.record(pid), left());
	if (recorded === undefined) return false;
	for (;;) {
		if ((await withinWindow(probe.stillRuns(recorded), left())) !== true || left() <= 0) return false;
		const answered = await probe.answeringPid(agentDir, Math.ceil(left()));
		if (left() < 0) return false;
		if (answered === pid) break;
		await sleep(Math.min(BROKER_ANSWER_POLL_MS, left()));
	}
	let signalled = false;
	for (const signal of signals) {
		if (!(await probe.stillRuns(recorded))) break;
		try {
			process.kill(pid, signal);
			signalled = true;
		} catch {
			// Already exited.
		}
	}
	const deadline = performance.now() + BROKER_EXIT_TIMEOUT_MS;
	while (!(await probe.isGone(recorded))) {
		if (performance.now() >= deadline) throw new Error(`Broker ${pid} did not exit; keeping ${agentDir}`);
		await sleep(20);
	}
	return signalled;
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
	options: StopDetachedBrokerOptions = {},
): Promise<void> {
	await stopDetachedBroker(agentDir, options);
	await removePath(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
