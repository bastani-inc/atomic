/**
 * Wire and state types for the builtin Herdr pane reporter.
 *
 * Herdr's protocol also carries an `unknown` pane state; Atomic never sends it,
 * so it is deliberately absent from {@link HerdrPaneState}.
 */

/** The pane states Atomic reports. */
export type HerdrPaneState = "working" | "idle" | "blocked";

/** Identity Atomic reports under. Never any other value. */
export const HERDR_SOURCE = "herdr:atomic";

/** Agent name Atomic reports under. Never any other value. */
export const HERDR_AGENT = "atomic";

/** The pane state the reducer wants, given the current inputs. */
export interface DesiredPaneState {
	state: HerdrPaneState;
	/** Short human-readable detail. Absent unless the state carries one. */
	message: string | undefined;
}

/** Everything the reducer needs. Pure data; no host objects. */
export interface PaneStateInputs {
	/** Label of the oldest open user block, or undefined when nothing is blocked. */
	readonly activeBlockLabel: string | undefined;
	/** Number of open user blocks. */
	readonly openBlockCount: number;
	/** Short error text when the last settled turn ended in a provider error. */
	readonly failureMessage: string | undefined;
	/** Whether an agent turn is currently running. */
	readonly agentActive: boolean;
}

/** How this reporter refers to its Atomic session on the wire. */
export interface HerdrSessionRef {
	/** Absolute session file path. Preferred over the id when available. */
	agent_session_path?: string;
	/** Session id, used only when no absolute path is available. */
	agent_session_id?: string;
}

/** Activation environment captured once per session factory invocation. */
export interface HerdrEnv {
	/** Value passed to `net.createConnection`; a named pipe path on Windows. */
	readonly socketEndpoint: string;
	readonly paneId: string;
}

/** A single newline-delimited JSON request on the Herdr socket. */
export interface HerdrRequest {
	id: string;
	method: "pane.report_agent" | "pane.report_agent_session" | "pane.release_agent";
	params: Record<string, string | number | undefined>;
}
