/**
 * The agent panel's listing and hint rules, as pure functions over a row's kind and state. The panel below the main
 * chat's prompt (`AgentPanelModel.rows` and the ranking the interactive engine and in-process host share) and its hint
 * line call these, so every path lists the same rows and counts them the same way.
 */

export type PanelRowKind = "agent" | "shell";
export type PanelRowState =
	| "running"
	| "queued"
	| "input"
	| "paused"
	| "stopping"
	| "waiting"
	| "done"
	| "failed"
	| "stopped";

/** Work the panel still waits on: running, queued, waiting on an answer, stopping, or waiting to wake. */
export function isActivePanelState(state: PanelRowState): boolean {
	return state === "running" || state === "queued" || state === "input" || state === "stopping" || state === "waiting";
}

/**
 * Work that stopped but can be resumed: a subagent stopped, paused, or with its turn interrupted. It is listed while something in the panel is active, and leaves for good once
 * nothing is, until it runs again.
 */
export function isRestingPanelRow(kind: PanelRowKind, state: PanelRowState): boolean {
	return kind === "agent" && (state === "stopped" || state === "paused");
}

/** What decides whether one row is listed, besides its own kind and state. */
export interface PanelRowContext {
	/** Something in the panel is active: a row in an active state, or a running background shell. */
	readonly active: boolean;
	/** The row is resting and already left the panel, because nothing was active, and has not run since. */
	readonly retired: boolean;
	/** Whether the panel marked the row to be kept. */
	readonly kept: boolean;
}

/**
 * Whether the panel lists a row. `finished` is true for a row that is done, failed or stopped, and not merely
 * interrupted. Shells are never rows; a resting row stays only while something is active and it has not left yet; a
 * finished subagent leaves at once; everything else is listed.
 */
export function panelRowListed(
	kind: PanelRowKind,
	state: PanelRowState,
	finished: boolean,
	context: PanelRowContext,
): boolean {
	if (kind === "shell") return false;
	if (isRestingPanelRow(kind, state)) return context.active && !context.retired;
	return !finished;
}

/** The counts the hint line shows for the rows the panel lists. */
export interface PanelRowCounts {
	/** Every listed row: ↓ focuses the panel while this is not 0. */
	readonly total: number;
	/** The listed subagent rows: `↓ N agents`. */
	readonly agents: number;
	/** The listed rows that wait for an answer: `N needs input`. */
	readonly needsInput: number;
}

export const NO_PANEL_ROWS: PanelRowCounts = { total: 0, agents: 0, needsInput: 0 };

/** The counts after one more listed row. */
export function countPanelRow(counts: PanelRowCounts, kind: PanelRowKind, state: PanelRowState): PanelRowCounts {
	return {
		total: counts.total + 1,
		agents: counts.agents + (kind === "agent" ? 1 : 0),
		needsInput: counts.needsInput + (state === "input" ? 1 : 0),
	};
}

/** What the counts read of a listed row. */
export interface PanelCountedRow {
	readonly kind: PanelRowKind;
	readonly state: PanelRowState;
}

/** The counts of a list of listed rows. */
export function panelCounts(rows: readonly PanelCountedRow[]): PanelRowCounts {
	let counts = NO_PANEL_ROWS;
	for (const row of rows) {
		counts = countPanelRow(counts, row.kind, row.state);
	}
	return counts;
}

/** Where the hint line points for background work the panel does not list. */
export type PanelTasksHint = "hidden" | "manage" | "subagents";

/** The parts of the hint line about background work, before they are worded. */
export interface PanelHintParts {
	/** `↓ N agents`; 0 means no such segment. */
	readonly agents: number;
	/** `N needs input`; 0 means no such segment. */
	readonly needsInput: number;
	/** `N shells`; 0 means no such segment. */
	readonly shells: number;
	/** `/tasks to manage` for running shells, or `/tasks to see subagents`, when the panel has nothing to focus. */
	readonly tasks: PanelTasksHint;
}

/**
 * The hint line's background-work parts. `focusBound`: a key focuses the panel. `subagents`: the chat's subagents in
 * /tasks, listed or not. Only subagent rows count as agents; with none there is no ↓ segment. A question waiting anywhere in the panel is counted. Without rows to focus, running shells point to
 * /tasks, and otherwise subagents the panel no longer lists do.
 */
export function panelHintParts(
	counts: PanelRowCounts,
	shells: number,
	subagents: number,
	focusBound: boolean,
): PanelHintParts {
	const focusable = focusBound && counts.total > 0;
	const tasks: PanelTasksHint = focusable
		? "hidden"
		: shells > 0
			? "manage"
			: counts.total === 0 && subagents > 0
				? "subagents"
				: "hidden";
	return {
		agents: focusBound ? counts.agents : 0,
		needsInput: counts.needsInput,
		shells: shells > 0 ? shells : 0,
		tasks,
	};
}

/** One worded hint segment: `agents` follows the focus key, and `tasks` names the /tasks command. */
export interface PanelHintSegment {
	readonly kind: "agents" | "needsInput" | "shells" | "tasks";
	readonly text: string;
}

/** The worded hint segments for `parts`, in order, by kind. `focusKey` names the key that focuses the panel. */
export function panelHintSegments(parts: PanelHintParts, focusKey: string): PanelHintSegment[] {
	const segments: PanelHintSegment[] = [];
	if (parts.agents > 0)
		segments.push({ kind: "agents", text: `${focusKey} ${parts.agents} ${parts.agents === 1 ? "agent" : "agents"}` });
	if (parts.needsInput > 0) segments.push({ kind: "needsInput", text: `${parts.needsInput} needs input` });
	if (parts.shells > 0)
		segments.push({ kind: "shells", text: `${parts.shells} ${parts.shells === 1 ? "shell" : "shells"}` });
	if (parts.tasks === "manage") segments.push({ kind: "tasks", text: "/tasks to manage" });
	else if (parts.tasks === "subagents") segments.push({ kind: "tasks", text: "/tasks to see subagents" });
	return segments;
}
