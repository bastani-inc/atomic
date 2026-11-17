import { createHook } from "node:async_hooks";
import { clearInterval, setInterval } from "node:timers";

const SAMPLE_INTERVAL_MS = 5;
const INITIAL_CALLBACK_ID = -1;

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
	hook.enable();
	try {
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
	}
}
