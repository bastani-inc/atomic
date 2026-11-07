import type { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";

const WAKE_COMPLETION_TIMEOUT_MS = 20_000;

/** Bound a wake's own completion signal, rather than counting event-loop turns. */
export async function waitForWakeCompletion<T>(completion: Promise<T>, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			completion,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out after ${WAKE_COMPLETION_TIMEOUT_MS}ms waiting for ${description}`)),
					WAKE_COMPLETION_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function drained(dispatcher: AgentWakeDispatcher): Promise<number> {
	await waitForWakeCompletion(dispatcher.whenIdle(), "the wake dispatcher to become idle (a wake is still pending)");
	return dispatcher.stats().keys;
}
