export type RunTerminalEvent =
	| { readonly kind: "failure"; readonly error: unknown; readonly nodeId?: string }
	| { readonly kind: "cancellation"; readonly reason: unknown };

export interface RunTerminalEventArbiter {
	selectFailure(error: unknown, nodeId?: string): RunTerminalEvent;
	selectCancellation(reason: unknown): RunTerminalEvent;
	winner(): RunTerminalEvent | undefined;
	register(): void;
	dispose(): void;
}

const activeArbiters = new Map<string, RunTerminalEventArbiter>();

/** Latches the first executor failure or real run cancellation for one live run. */
export function createRunTerminalEventArbiter(runId: string): RunTerminalEventArbiter {
	let selected: RunTerminalEvent | undefined;
	const select = (event: RunTerminalEvent): RunTerminalEvent => {
		selected ??= event;
		return selected;
	};
	const arbiter: RunTerminalEventArbiter = {
		selectFailure: (error, nodeId) => select({ kind: "failure", error, ...(nodeId === undefined ? {} : { nodeId }) }),
		selectCancellation: (reason) => select({ kind: "cancellation", reason }),
		winner: () => selected,
		register() {
			activeArbiters.set(runId, arbiter);
		},
		dispose() {
			if (activeArbiters.get(runId) === arbiter) activeArbiters.delete(runId);
		},
	};
	return arbiter;
}

/** Read the selected event so an external kill cannot overwrite an earlier failure. */
export function selectedRunTerminalEvent(runId: string): RunTerminalEvent | undefined {
	return activeArbiters.get(runId)?.winner();
}
