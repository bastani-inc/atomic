import type { ExtensionContext } from "@bastani/atomic";

/**
 * An active subagent admits an arriving message through its own FIFO, with native steering, never through the
 * headless idle/refusal path. `false` for any other session, which admits through the ordinary idle queue.
 */
export function admitActiveSessionInbound(
	ctx: Pick<ExtensionContext, "subagentPolicy">,
	deliver: () => void | Promise<void>,
): false | Promise<void> {
	const executionEnded = ctx.subagentPolicy?.executionEnded;
	if (executionEnded === undefined) return false;
	if (executionEnded.aborted || ctx.subagentPolicy?.messageAdmission?.isOpen() === false) {
		return Promise.reject(new Error("Subagent execution is terminal and cannot accept messages"));
	}
	try {
		return ctx.subagentPolicy?.messageAdmission?.run(deliver) ?? Promise.resolve(deliver());
	} catch (error) {
		return Promise.reject(error);
	}
}
