/** Whether a view that hid the agent panel is closing now, as the panel opens again. */
let returning = false;

/**
 * Run `close`, the close of the view that hid the agent panel, which opens again in the same step: the close it
 * announces says so (`engine_custom_done.panel`).
 */
export function withAgentPanelReturn(close: () => void): void {
	const was = returning;
	returning = true;
	try {
		close();
	} finally {
		returning = was;
	}
}

/** Whether the view closing now is the one that hid the agent panel, which opens again as it closes. */
export function agentPanelReturning(): boolean {
	return returning;
}
