import { sleep } from "./runtime.js";

export interface EndedRun {
	readonly status: string;
	readonly error?: string;
}

const POLL_INTERVAL_MS = 25;

function rejectWhenRunEnds(execution: Promise<EndedRun>): Promise<never> {
	const ended = execution.then((run): never => {
		throw new Error(`The run ended with status ${run.status} before the condition held: ${run.error ?? "no error"}`);
	});
	ended.catch(() => {});
	return ended;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
	const aborted = new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	aborted.catch(() => {});
	return aborted;
}

export async function untilOrRunEnds(
	condition: () => Promise<boolean>,
	execution: Promise<EndedRun>,
	timeoutMs: number,
): Promise<void> {
	const runEnded = rejectWhenRunEnds(execution);
	const timedOut = rejectWhenAborted(AbortSignal.timeout(timeoutMs));
	while (!(await Promise.race([condition(), runEnded, timedOut]))) {
		await Promise.race([sleep(POLL_INTERVAL_MS), runEnded, timedOut]);
	}
}
