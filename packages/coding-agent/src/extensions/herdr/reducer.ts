/**
 * The pane-state reducer.
 *
 * Pure and total: every combination of inputs maps to exactly one state, with
 * no clock, no host object, and no I/O. Precedence is fixed — user blocks >
 * workflow blocks > failure-blocked > active > idle.
 */

import type { DesiredPaneState, PaneStateInputs, WorkflowRunContribution } from "./types.js";

function workflowBlockedContribution(
	contributions: readonly WorkflowRunContribution[],
): WorkflowRunContribution | undefined {
	return contributions.find((contribution) => contribution.state === "blocked");
}

function hasWorkingWorkflow(contributions: readonly WorkflowRunContribution[]): boolean {
	return contributions.some((contribution) => contribution.state === "working");
}

export function desiredPaneState(inputs: PaneStateInputs): DesiredPaneState {
	if (inputs.openBlockCount > 0) {
		return { state: "blocked", message: inputs.activeBlockLabel };
	}
	const contributions = inputs.workflowContributions ?? [];
	const blockedContribution = workflowBlockedContribution(contributions);
	if (blockedContribution !== undefined) {
		return { state: "blocked", message: blockedContribution.label };
	}
	if (inputs.failureMessage !== undefined) {
		return { state: "blocked", message: inputs.failureMessage };
	}
	if (inputs.agentActive || hasWorkingWorkflow(contributions)) {
		return { state: "working", message: undefined };
	}
	return { state: "idle", message: undefined };
}
