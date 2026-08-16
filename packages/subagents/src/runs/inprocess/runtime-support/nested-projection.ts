import type { NestedRunSummary, SubagentState } from "../../../shared/types.js";
import { MAX_NESTED_CHILDREN } from "./nested-core.js";
import { projectNestedEvents } from "./nested-registry.js";
import { terminal } from "./nested-sanitize.js";

export function attachRootChildrenToSteps<T extends { children?: NestedRunSummary[]; index?: number }>(
	rootRunId: string,
	steps: T[] | undefined,
	children: NestedRunSummary[] | undefined,
): void {
	if (!steps?.length) return;
	for (const step of steps) step.children = undefined;
	if (!children?.length) return;
	for (const child of children) {
		if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) continue;
		const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
		if (!step) continue;
		step.children ??= [];
		step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(
			0,
			MAX_NESTED_CHILDREN,
		);
	}
}

export function updateForegroundNestedProjection(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): void {
	if (!control.nestedRoute) return;
	const registry = projectNestedEvents(control.nestedRoute);
	control.nestedChildren = registry.children;
}

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
	if (!children?.length) return false;
	for (const child of children) {
		if (!terminal(child.state)) return true;
		if (hasLiveNestedDescendants(child.children)) return true;
		if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) return true;
	}
	return false;
}
