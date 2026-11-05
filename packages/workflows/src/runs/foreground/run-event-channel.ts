import type { AgentSessionEvent } from "@bastani/atomic";
import type { RunSnapshot, RunStatus, StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowOutputValues } from "../../shared/types.js";

/** One notification of a run, as `run()` reports it through `onRunStart`, `onStageStart`, `onStageEnd`, `onStageSessionEvent` and `onRunEnd`. */
export type WorkflowRunEvent =
	| { readonly type: "run_start"; readonly run: RunSnapshot }
	| { readonly type: "stage_start"; readonly runId: string; readonly stage: StageSnapshot }
	| { readonly type: "stage_end"; readonly runId: string; readonly stage: StageSnapshot }
	| {
			readonly type: "stage_session_event";
			readonly runId: string;
			readonly stageId: string;
			readonly event: AgentSessionEvent;
	  }
	| {
			readonly type: "run_end";
			readonly runId: string;
			readonly status: RunStatus;
			readonly result?: WorkflowOutputValues;
			readonly error?: string;
			readonly exitReason?: string;
	  };

export interface RunEventChannel {
	push(event: WorkflowRunEvent): void;
	end(error?: Error): void;
	/** Events held for a reader: lifecycle events before one attaches, then whatever it has not read yet. */
	held(): number;
	readonly events: AsyncIterable<WorkflowRunEvent>;
}

/**
 * The events of one run, for one reader. Lifecycle events, bounded by the size of the run's graph, are
 * kept until the reader attaches; agent-session events are queued only while it is attached, so a run
 * nobody reads holds no session events. A reader that stops early detaches and nothing is kept after it.
 */
export function runEventChannel(): RunEventChannel {
	let backlog: WorkflowRunEvent[] = [];
	let queue: WorkflowRunEvent[] | undefined;
	let wake: (() => void) | undefined;
	let ended = false;
	let detached = false;
	let failure: Error | undefined;
	return {
		push(event) {
			if (ended || detached) return;
			if (queue !== undefined) {
				queue.push(event);
				wake?.();
			} else if (event.type !== "stage_session_event") backlog.push(event);
		},
		end(error) {
			ended = true;
			failure = error;
			wake?.();
		},
		held() {
			return backlog.length + (queue?.length ?? 0);
		},
		events: {
			async *[Symbol.asyncIterator]() {
				const attached = queue ?? backlog;
				backlog = [];
				queue = attached;
				try {
					for (;;) {
						const next = attached.shift();
						if (next !== undefined) {
							yield next;
							continue;
						}
						if (ended) {
							if (failure !== undefined) throw failure;
							return;
						}
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						wake = undefined;
					}
				} finally {
					detached = !ended;
					queue = undefined;
					attached.length = 0;
				}
			},
		},
	};
}
