import type { AgentTool, AgentToolResult } from "@bastani/atomic-agent-core";

/** How long a tool call may run on after its turn is interrupted before the turn stops waiting for it (#5486). */
export const DEFAULT_TOOL_ABORT_GRACE_MS = 10_000;
/** The longest delay a timer takes; a larger value would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

const activeGraceTimers = new WeakMap<AbortSignal, Set<ReturnType<typeof setTimeout>>>();
const releasedGraceSignals = new WeakSet<AbortSignal>();

/**
 * Arm an abort-grace timer for `signal`. The timer stays ref'd while active so a caller awaiting the aborted turn or
 * tool call is not terminated early when no other handle is open, and is cleared on settlement or unref'd if session
 * disposal stops waiting at its shutdown deadline.
 */
export function armToolAbortGraceTimer(
	signal: AbortSignal | undefined,
	graceMs: number,
	onExpire: () => void,
): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => {
		if (signal !== undefined) activeGraceTimers.get(signal)?.delete(timer);
		onExpire();
	}, graceMs);
	if (signal !== undefined) {
		if (releasedGraceSignals.has(signal)) {
			timer.unref?.();
		} else {
			let timers = activeGraceTimers.get(signal);
			if (timers === undefined) {
				timers = new Set();
				activeGraceTimers.set(signal, timers);
			}
			timers.add(timer);
		}
	}
	return timer;
}

/** Clear an abort-grace timer armed through {@link armToolAbortGraceTimer}. */
export function clearToolAbortGraceTimer(
	signal: AbortSignal | undefined,
	timer: ReturnType<typeof setTimeout> | undefined,
): void {
	if (timer === undefined) return;
	clearTimeout(timer);
	if (signal !== undefined) activeGraceTimers.get(signal)?.delete(timer);
}

/** Unref any remaining abort-grace timers for `signal` once disposal has stopped waiting for its abort step. */
export function releaseToolAbortGraceTimers(signal: AbortSignal | undefined): void {
	if (signal === undefined) return;
	releasedGraceSignals.add(signal);
	const timers = activeGraceTimers.get(signal);
	if (timers === undefined) return;
	for (const timer of timers) timer.unref?.();
	timers.clear();
}

/** `ATOMIC_TOOL_ABORT_GRACE_MS` when it is a whole number of milliseconds, otherwise the default. */
export function toolAbortGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = env.ATOMIC_TOOL_ABORT_GRACE_MS?.trim();
	return value !== undefined && /^\d+$/.test(value)
		? Math.min(Number(value), MAX_TIMER_MS)
		: DEFAULT_TOOL_ABORT_GRACE_MS;
}

function seconds(ms: number): string {
	const value = Number((ms / 1000).toFixed(3));
	return `${value} second${value === 1 ? "" : "s"}`;
}

/** The result a call gets when its interrupted turn stops waiting for it. */
export function abandonedToolResult(toolName: string, graceMs: number): AgentToolResult<undefined> {
	return {
		content: [
			{
				type: "text",
				text: `Operation aborted: ${toolName} did not stop within ${seconds(graceMs)} after the turn was interrupted. It may still be running, but any later result is discarded.`,
			},
		],
		details: undefined,
		isError: true,
	};
}

/**
 * `tool`, whose calls answer at most a grace period after their turn is interrupted (#5486). A call still running then
 * gets {@link abandonedToolResult}, so the turn can end. A call that stops within the grace keeps its own result.
 */
export function withToolAbortGrace(tool: AgentTool): AgentTool {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate, ...rest) => {
			let running: ReturnType<AgentTool["execute"]>;
			try {
				running = tool.execute(toolCallId, params, signal, onUpdate, ...rest);
			} catch (error) {
				return Promise.reject(error);
			}
			if (signal === undefined) return running;
			return new Promise((resolve, reject) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const startGrace = () => {
					const graceMs = toolAbortGraceMs();
					timer = armToolAbortGraceTimer(signal, graceMs, () => resolve(abandonedToolResult(tool.name, graceMs)));
				};
				const settle = () => {
					clearToolAbortGraceTimer(signal, timer);
					timer = undefined;
					signal.removeEventListener("abort", startGrace);
				};
				if (signal.aborted) startGrace();
				else signal.addEventListener("abort", startGrace, { once: true });
				running.then(
					(result) => {
						settle();
						resolve(result);
					},
					(error: unknown) => {
						settle();
						reject(error);
					},
				);
			});
		},
	};
}
