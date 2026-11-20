import type { ExtensionContext } from "@bastani/atomic";

/** Asks the loaded Intercom runtime to join the broker for a session that has not used Intercom yet. */
export const INTERCOM_STARTUP_JOIN_EVENT = "intercom:startup-join";

export interface IntercomStartupJoinRequest {
	completion?: Promise<void>;
}

/**
 * Retries after a startup join that could not reach the broker, on the reconnect backoff. After the last one the
 * session joins on its next Intercom use, as a session that has never joined does.
 */
export const STARTUP_JOIN_RETRIES = 5;

/**
 * An interactive top-level session joins Intercom at startup, so other sessions can list and message it before it
 * uses Intercom itself. The presentation-only host of an isolated terminal never runs the model and never joins;
 * print, JSON, RPC and SDK sessions, subagents, and sessions without the `intercom` tool keep joining on first use.
 */
export function joinsIntercomAtStartup(ctx: ExtensionContext, activeTools: () => readonly string[]): boolean {
	return (
		ctx.mode === "tui" &&
		ctx.hasUI &&
		ctx.isPresentationOnly !== true &&
		ctx.subagentPolicy === undefined &&
		activeTools().includes("intercom")
	);
}
