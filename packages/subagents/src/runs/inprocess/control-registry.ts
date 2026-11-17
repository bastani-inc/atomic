import type { ChildIdentity } from "@bastani/atomic-natives";
import { createSubagentControl, type ParentContext, type SubagentControlRuntime } from "./runner.js";

/**
 * Host-local registry for the Rust control planes owned by the current Atomic
 * session. The native registry remains authoritative for child identity and
 * status; this map only lets management actions find the corresponding
 * in-process runtime without a file-backed run directory.
 */
const controls = new Map<string, SubagentControlRuntime>();

/**
 * Finished runs whose controls the process keeps, so `status` and run control can still name their children: the
 * latest ones, as a task owner keeps its latest 256 finished tasks. A run with a child still pending, running or
 * continued is never dropped. A dropped run's children keep their records and session files, so they still resume.
 */
export const FINISHED_RUN_CONTROL_RETENTION = 256;

function dropOldestFinishedControls(): void {
	let finished = 0;
	for (const control of controls.values()) if (control.isFinished()) finished += 1;
	for (const [path, control] of controls) {
		if (finished <= FINISHED_RUN_CONTROL_RETENTION) return;
		if (!control.isFinished()) continue;
		controls.delete(path);
		finished -= 1;
	}
}

export function registerSubagentControl(control: SubagentControlRuntime): void {
	controls.set(control.parent.path, control);
	dropOldestFinishedControls();
}

export function getOrCreateSubagentControl(
	parent: ParentContext,
	sessionRoot: string,
	runningCapacity?: number,
): SubagentControlRuntime {
	const existing = controls.get(parent.path);
	// The control plane is parent-scoped. Parallel callers pass their per-child
	// session directories here, but those storage paths must not split identity
	// allocation across fresh native registries.
	if (existing) return existing;
	const control = createSubagentControl(parent, sessionRoot, runningCapacity);
	registerSubagentControl(control);
	return control;
}

export function unregisterSubagentControl(control: SubagentControlRuntime): void {
	if (controls.get(control.parent.path) === control) controls.delete(control.parent.path);
}

/** A run's control by its run id, or the control of a child named by its path or child id (`<runId>:<index>`). */
export function findSubagentControl(id: string): SubagentControlRuntime | undefined {
	const direct = controls.get(id);
	if (direct) return direct;
	// Every run a session launched keeps its control: name a child by the ids each control holds first, and list a
	// run's native children only for a path no control knows by id (#5186).
	for (const control of controls.values()) {
		if (control.pathOfChildId(id) !== undefined || control.childIdOf(id) !== undefined) return control;
	}
	for (const control of controls.values()) {
		if (control.native.listChildren().some((child) => child.path === id)) return control;
	}
	return undefined;
}

/** The admitted path of a child named by its path or its child id (`<runId>:<index>`). */
export function subagentChildPath(control: SubagentControlRuntime, id: string): string {
	return control.pathOfChildId(id) ?? id;
}

/** The child id (`<runId>:<index>`) of a child named by its admitted path, while this process has it. */
export function subagentChildIdOfPath(id: string): string | undefined {
	for (const control of controls.values()) {
		const childId = control.childIdOf(id);
		if (childId !== undefined) return childId;
	}
	return undefined;
}

export function listSubagentControls(): readonly SubagentControlRuntime[] {
	return [...controls.values()];
}

export function findChildIdentity(
	id: string,
): { control: SubagentControlRuntime; identity: ChildIdentity } | undefined {
	const control = findSubagentControl(id);
	if (!control) return undefined;
	const path = subagentChildPath(control, id);
	const identity = control.native.listChildren().find((child) => child.path === path);
	return identity ? { control, identity } : undefined;
}

export function clearSubagentControls(): void {
	controls.clear();
}

/** Runs whose controls are registered; counted by tests and the benchmark. */
export function subagentControlCount(): number {
	return controls.size;
}
