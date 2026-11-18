import type { AgentTool, AgentToolResult } from "@bastani/atomic-agent-core";

/** How long a tool call may run on after its turn is interrupted before the turn stops waiting for it (#5486). */
export const DEFAULT_TOOL_ABORT_GRACE_MS = 10_000;
/** The longest delay a timer takes; a larger value would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** `ATOMIC_TOOL_ABORT_GRACE_MS` when it is a whole number of milliseconds, otherwise the default. */
export function toolAbortGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = env.ATOMIC_TOOL_ABORT_GRACE_MS?.trim();
	return value !== undefined && /^\d+$/.test(value)
		? Math.min(Number(value), MAX_TIMER_MS)
		: DEFAULT_TOOL_ABORT_GRACE_MS;
}

/** What a call its interrupted turn stopped waiting for returned later: its result, or what it threw. */
export type LateToolOutcome =
	| { readonly kind: "result"; readonly result: AgentToolResult<unknown> }
	| { readonly kind: "error"; readonly error: unknown };

/** Receives the late outcome of a call its turn stopped waiting for. */
export type LateToolOutcomeSink = (toolCallId: string, toolName: string, outcome: LateToolOutcome) => void;

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
				text: `Operation aborted: ${toolName} did not stop within ${seconds(graceMs)} after the turn was interrupted. It may still be running; if it finishes, its result is added to the conversation.`,
			},
		],
		details: undefined,
		isError: true,
	};
}

/**
 * `tool`, whose calls answer at most a grace period after their turn is interrupted (#5486). A call still running then
 * gets {@link abandonedToolResult}, so the turn can end; the call goes on, and `onLate` receives what it returns. A call
 * that stops within the grace answers as it always does.
 */
export function withToolAbortGrace(tool: AgentTool, onLate: LateToolOutcomeSink): AgentTool {
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
				let abandoned = false;
				const startGrace = () => {
					const graceMs = toolAbortGraceMs();
					timer = setTimeout(() => {
						abandoned = true;
						resolve(abandonedToolResult(tool.name, graceMs));
					}, graceMs);
					timer.unref?.();
				};
				const settle = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", startGrace);
				};
				if (signal.aborted) startGrace();
				else signal.addEventListener("abort", startGrace, { once: true });
				running.then(
					(result) => {
						settle();
						if (abandoned) onLate(toolCallId, tool.name, { kind: "result", result });
						else resolve(result);
					},
					(error: unknown) => {
						settle();
						if (abandoned) onLate(toolCallId, tool.name, { kind: "error", error });
						else reject(error);
					},
				);
			});
		},
	};
}
