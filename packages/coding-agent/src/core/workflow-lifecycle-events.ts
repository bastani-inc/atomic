/**
 * Neutral in-session workflow lifecycle events.
 *
 * The workflows extension publishes this small payload on the shared extension
 * event bus. Consumers decide what the event means for their own surface; the
 * publisher does not import or know about any consumer.
 */

import { canonicalEventBusFor } from "./event-bus.ts";

export const WORKFLOW_LIFECYCLE_EVENT = "atomic:workflow-lifecycle";

export type WorkflowLifecycleBridgeNoticeKind =
	| "started"
	| "completed"
	| "failed"
	| "blocked"
	| "awaiting_input"
	| "paused"
	| "quit"
	| "resumed";

export interface WorkflowLifecycleBridgeEvent {
	/** Stable internal key used to refcount one top-level workflow run. */
	readonly runKey: string;
	readonly kind: WorkflowLifecycleBridgeNoticeKind;
	/** Short display label. It is not a prompt body or an error detail. */
	readonly label: string;
}

/** Internal physical-to-logical lineage retained for successor reconstruction. */
export interface WorkflowLifecycleBridgeLineage {
	readonly runId: string;
	readonly runKey: string;
}

const defaultWorkflowLifecycleBridgeScope = {};
const workflowLifecycleEventsByScope = new WeakMap<object, Map<string, WorkflowLifecycleBridgeEvent>>();
const workflowLifecycleLineagesByScope = new WeakMap<object, Map<string, string>>();
const workflowLifecycleTerminalLineagesByScope = new WeakMap<object, Set<string>>();

/**
 * The scope callers hold is `pi.events`, and the loader hands every extension
 * — and every `/reload` generation of the same extension — a fresh facade
 * over one shared bus. Resolving the facade to that bus is what lets the
 * workflows extension write a snapshot that the Herdr extension can read, and
 * lets a successor session take the handoff its predecessor left behind.
 */
function workflowLifecycleScopeKey(scope: object | undefined): object {
	return scope === undefined ? defaultWorkflowLifecycleBridgeScope : canonicalEventBusFor(scope);
}

function workflowLifecycleEventsFor(scope: object | undefined): Map<string, WorkflowLifecycleBridgeEvent> {
	const key = workflowLifecycleScopeKey(scope);
	const existing = workflowLifecycleEventsByScope.get(key);
	if (existing !== undefined) return existing;
	const events = new Map<string, WorkflowLifecycleBridgeEvent>();
	workflowLifecycleEventsByScope.set(key, events);
	return events;
}

function workflowLifecycleLineagesFor(scope: object | undefined): Map<string, string> {
	const key = workflowLifecycleScopeKey(scope);
	const existing = workflowLifecycleLineagesByScope.get(key);
	if (existing !== undefined) return existing;
	const lineages = new Map<string, string>();
	workflowLifecycleLineagesByScope.set(key, lineages);
	return lineages;
}

/** Remember one physical run's stable logical key for successor reconstruction. */
export function rememberWorkflowLifecycleBridgeLineage(runId: string, runKey: string, scope?: object): void {
	workflowLifecycleLineagesFor(scope).set(runId, runKey);
}

function workflowLifecycleTerminalLineagesFor(scope: object | undefined): Set<string> {
	const key = workflowLifecycleScopeKey(scope);
	const existing = workflowLifecycleTerminalLineagesByScope.get(key);
	if (existing !== undefined) return existing;
	const lineages = new Set<string>();
	workflowLifecycleTerminalLineagesByScope.set(key, lineages);
	return lineages;
}

/**
 * Remember the latest lifecycle event for each run in one host event scope.
 *
 * The event bus is intentionally not replayable. A deferred or replacement
 * reporter can still seed from the latest neutral snapshot without asking the
 * workflows package to know about Herdr. Scoping by the shared bus prevents a
 * second in-process session from seeing this session's runs. Terminal lineage
 * tombstones stay out of the active snapshot but let a replacement bridge
 * remember that a completed continuation superseded an older failed run.
 */
export function rememberWorkflowLifecycleBridgeEvent(event: WorkflowLifecycleBridgeEvent, scope?: object): void {
	const events = workflowLifecycleEventsFor(scope);
	const terminalLineages = workflowLifecycleTerminalLineagesFor(scope);
	if (event.kind === "completed" || event.kind === "quit") {
		events.delete(event.runKey);
		terminalLineages.add(event.runKey);
		return;
	}
	terminalLineages.delete(event.runKey);
	events.set(event.runKey, event);
}

/** Return the current neutral lifecycle contributions for a replacement reporter. */
export function getWorkflowLifecycleBridgeSnapshot(scope?: object): readonly WorkflowLifecycleBridgeEvent[] {
	return [...workflowLifecycleEventsFor(scope).values()];
}

/** Return terminal lineage keys that must not resurrect superseded predecessors. */
export function getWorkflowLifecycleBridgeTerminalLineages(scope?: object): readonly string[] {
	return [...workflowLifecycleTerminalLineagesFor(scope)];
}

/** Return physical-to-logical lineage retained for a replacement bridge. */
export function getWorkflowLifecycleBridgeLineages(scope?: object): readonly WorkflowLifecycleBridgeLineage[] {
	return [...workflowLifecycleLineagesFor(scope)].map(([runId, runKey]) => ({ runId, runKey }));
}

/** Everything a replacement bridge needs from the bridge it replaces. */
export interface WorkflowLifecycleBridgeHandoff {
	readonly contributions: readonly WorkflowLifecycleBridgeEvent[];
	readonly lineages: readonly WorkflowLifecycleBridgeLineage[];
	readonly terminalLineages: readonly string[];
}

/**
 * Take the handoff for a replacement bridge, clearing what it consumes.
 *
 * Active contributions stay behind, because a reporter that activates before
 * the successor reconciles still has to seed from them. Lineage and terminal
 * tombstones are handoff metadata with no reader once the successor holds a
 * copy, and they had no eviction path at all while the bus stayed alive:
 * leaving them is what let a later run reusing a retired id be mistaken for
 * the continuation of a lineage that ended long ago. The successor re-records
 * both for every run it can still observe.
 */
export function takeWorkflowLifecycleBridgeHandoff(scope?: object): WorkflowLifecycleBridgeHandoff {
	const handoff: WorkflowLifecycleBridgeHandoff = {
		contributions: getWorkflowLifecycleBridgeSnapshot(scope),
		lineages: getWorkflowLifecycleBridgeLineages(scope),
		terminalLineages: getWorkflowLifecycleBridgeTerminalLineages(scope),
	};
	workflowLifecycleLineagesFor(scope).clear();
	workflowLifecycleTerminalLineagesFor(scope).clear();
	return handoff;
}

/**
 * Drop active contributions while retaining lineage and terminal history for a
 * replacement bridge in the same session.
 */
export function clearWorkflowLifecycleBridgeEvents(scope?: object): void {
	workflowLifecycleEventsFor(scope).clear();
}

/** Clear the neutral lifecycle snapshot for one host event scope. */
export function resetWorkflowLifecycleBridgeSnapshot(scope?: object): void {
	workflowLifecycleEventsFor(scope).clear();
	workflowLifecycleLineagesFor(scope).clear();
	workflowLifecycleTerminalLineagesFor(scope).clear();
}

const WORKFLOW_LIFECYCLE_BRIDGE_NOTICE_KINDS: ReadonlySet<WorkflowLifecycleBridgeNoticeKind> = new Set([
	"started",
	"completed",
	"failed",
	"blocked",
	"awaiting_input",
	"paused",
	"quit",
	"resumed",
]);

export function isWorkflowLifecycleBridgeEvent(value: object): value is WorkflowLifecycleBridgeEvent {
	const event = value as Partial<WorkflowLifecycleBridgeEvent>;
	return (
		typeof event.runKey === "string" &&
		typeof event.label === "string" &&
		typeof event.kind === "string" &&
		WORKFLOW_LIFECYCLE_BRIDGE_NOTICE_KINDS.has(event.kind as WorkflowLifecycleBridgeNoticeKind)
	);
}
