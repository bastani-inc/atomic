import type { ChildIdentity } from "@bastani/atomic-natives";
import { createSubagentControl, type ParentContext, type SubagentControlRuntime } from "./runner.ts";

/**
 * Host-local registry for the Rust control planes owned by the current Atomic
 * session. The native registry remains authoritative for child identity and
 * status; this map only lets management actions find the corresponding
 * in-process runtime without a file-backed run directory.
 */
const controls = new Map<string, SubagentControlRuntime>();

export function registerSubagentControl(control: SubagentControlRuntime): void {
	controls.set(control.parent.path, control);
}

export function getOrCreateSubagentControl(parent: ParentContext, sessionRoot: string): SubagentControlRuntime {
	const existing = controls.get(parent.path);
	// The control plane is parent-scoped. Parallel callers pass their per-child
	// session directories here, but those storage paths must not split identity
	// allocation across fresh native registries.
	if (existing) return existing;
	const control = createSubagentControl(parent, sessionRoot);
	controls.set(parent.path, control);
	return control;
}

export function unregisterSubagentControl(control: SubagentControlRuntime): void {
	if (controls.get(control.parent.path) === control) controls.delete(control.parent.path);
}

export function findSubagentControl(id: string): SubagentControlRuntime | undefined {
	const direct = controls.get(id);
	if (direct) return direct;
	for (const control of controls.values()) {
		if (control.native.listChildren().some((child) => child.path === id)) return control;
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
	const identity = control.native.listChildren().find((child) => child.path === id);
	return identity ? { control, identity } : undefined;
}

export function clearSubagentControls(): void {
	controls.clear();
}
