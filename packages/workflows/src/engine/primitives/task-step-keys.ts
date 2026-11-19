import { isProxy } from "node:util/types";
import type { WorkflowTaskStep } from "../../shared/types.js";

export type TaskStepKey = (index: number, admittedName: string) => string;

/** A launch claims its names before the execution gate. Never invoke author code to inspect a queued step. */
export function reserveTaskSteps(
	steps: readonly WorkflowTaskStep[],
	group: number,
	reserve: (name: string) => string,
): TaskStepKey {
	const keys: { name: string; key: string }[] = [];
	if (!isProxy(steps) && Array.isArray(steps)) {
		for (let index = 0; index < steps.length; index++) {
			const step = Object.getOwnPropertyDescriptor(steps, index)?.value;
			if (typeof step !== "object" || step === null || isProxy(step)) break;
			const name = Object.getOwnPropertyDescriptor(step, "name")?.value;
			if (typeof name !== "string") break;
			keys.push({ name, key: reserve(name) });
		}
	}
	// Computed, inherited and renamed steps still have a stable identity by launch and slot. The separate prefix
	// cannot collide with an ordinary stage or task, whose keys start with `stage:`.
	return (index, name) => {
		const reserved = keys[index];
		return reserved !== undefined && reserved.name === name ? reserved.key : `group-task:${group}:${index}:${name}`;
	};
}
