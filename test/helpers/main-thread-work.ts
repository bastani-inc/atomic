import { createHook } from "node:async_hooks";
import { constants, getPriority, setPriority } from "node:os";
import { clearInterval, setInterval } from "node:timers";

const SAMPLE_INTERVAL_MS = 5;
const INITIAL_CALLBACK_ID = -1;
const isWindows = process.platform === "win32";

let measurementsInProgress = 0;
let restorePriority: (() => void) | undefined;

function runAheadOfOtherProcesses(): () => void {
	if (!isWindows) return () => {};
	measurementsInProgress += 1;
	if (measurementsInProgress === 1) {
		try {
			const previous = getPriority();
			if (previous > constants.priority.PRIORITY_HIGH) {
				setPriority(constants.priority.PRIORITY_HIGH);
				restorePriority = () => setPriority(previous);
			}
		} catch {}
	}
	return () => {
		measurementsInProgress -= 1;
		if (measurementsInProgress > 0) return;
		const restore = restorePriority;
		restorePriority = undefined;
		restore?.();
	};
}

export async function longestMainThreadBlockMs(work: () => Promise<void>): Promise<number> {
	const callbacks: number[] = [];
	let startedAt = 0;
	let occupiedMs = 0;
	let longestMs = 0;
	const before = (id: number) => {
		if (callbacks.length === 0) startedAt = performance.now();
		callbacks.push(id);
	};
	const after = (id: number) => {
		if (callbacks.at(-1) !== id) return;
		callbacks.pop();
		if (callbacks.length === 0) occupiedMs += performance.now() - startedAt;
	};
	const hook = createHook({ before, after });
	const sampler = setInterval(() => {
		longestMs = Math.max(longestMs, occupiedMs);
		occupiedMs = 0;
	}, SAMPLE_INTERVAL_MS);
	sampler.unref();
	const finishMeasurement = runAheadOfOtherProcesses();
	try {
		hook.enable();
		let pending: Promise<void>;
		before(INITIAL_CALLBACK_ID);
		try {
			pending = work();
		} finally {
			after(INITIAL_CALLBACK_ID);
		}
		await pending;
		const currentCallbackMs = callbacks.length > 0 ? performance.now() - startedAt : 0;
		return Math.max(longestMs, occupiedMs + currentCallbackMs);
	} finally {
		hook.disable();
		clearInterval(sampler);
		finishMeasurement();
	}
}
