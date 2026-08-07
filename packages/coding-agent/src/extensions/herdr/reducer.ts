/**
 * The pane-state reducer.
 *
 * Pure and total: every combination of inputs maps to exactly one state, with
 * no clock, no host object, and no I/O. Precedence is fixed —
 * user blocks > failure-blocked > active > idle — so a dialog opened during a
 * turn reports blocked, and a turn that ended in a provider error reports
 * blocked rather than silently idle.
 */

import type { DesiredPaneState, PaneStateInputs } from "./types.ts";

export function desiredPaneState(inputs: PaneStateInputs): DesiredPaneState {
	if (inputs.openBlockCount > 0) {
		return { state: "blocked", message: inputs.activeBlockLabel };
	}
	if (inputs.failureMessage !== undefined) {
		return { state: "blocked", message: inputs.failureMessage };
	}
	if (inputs.agentActive) {
		return { state: "working", message: undefined };
	}
	return { state: "idle", message: undefined };
}
