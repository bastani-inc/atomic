import type { PoolControl } from "../durable/journal/sql-pool-queue.js";
import { WorkflowGracefulQuitError } from "../engine/workflow-tool-abort.js";

export interface WorkerControlHandlers {
	/** Brings the worker's runs to the control's state: pauses or resumes their tools and stages. */
	apply(control: PoolControl): Promise<void>;
	/** Runs once the control is the worker's: acknowledges it, or ends the attempt a quit stops. */
	applied(control: PoolControl): Promise<void>;
}

/**
 * A worker's pool control. It arrives pushed by the coordinator, in heartbeat replies and from control reads, in any
 * order. Each is applied after the ones offered before it, and one whose revision is not newer than the revision
 * applied is ignored: a stale reply never undoes a newer push, and a slow pause never finishes after the resume that
 * followed it.
 */
export class WorkerControl {
	private revision = -1;
	private current: PoolControl["state"] = "running";
	private applying: Promise<void> = Promise.resolve();

	constructor(private readonly handlers: WorkerControlHandlers) {}

	/** The state of the newest revision applied; `running` until one is. */
	get state(): PoolControl["state"] {
		return this.current;
	}

	/** Applies `control` in turn; rejects with the failure of its own application only. */
	offer(control: PoolControl): Promise<void> {
		const application = this.applying.then(async () => {
			if (control.revision <= this.revision) return;
			await this.handlers.apply(control);
			this.current = control.state;
			this.revision = control.revision;
			await this.handlers.applied(control);
		});
		this.applying = Promise.allSettled([application]).then(() => undefined);
		return application;
	}

	/** Resolves once every control offered so far was applied or refused. */
	settled(): Promise<void> {
		return this.applying;
	}
}

/** A run's tools or stages, as pool control pauses and resumes them. */
export interface PausableRunControl {
	pause(): Promise<void> | Promise<readonly object[]>;
	resume(): Promise<void> | Promise<readonly object[]>;
}

/** What a worker's pool control acts on. */
export interface WorkerControlTargets {
	/** The runs of the attempt the worker holds, or of the last one it held. */
	runs(): readonly { readonly id: string }[];
	/** A run's tool controls, while the run has them. */
	tools(runId: string): PausableRunControl | undefined;
	stages(runId: string): PausableRunControl;
	/** The running attempt's controller; undefined between attempts. */
	attempt(): AbortController | undefined;
	/** The root the worker serves: the run a quit names when the attempt has registered none yet. */
	readonly root: string;
	acknowledge(revision: number): Promise<void>;
}

/**
 * How a worker applies pool control. Pause and resume reach every run's tools and stages, and a quit leaves them as
 * they are. A running attempt ends on a quit through a graceful-quit abort naming its run, and acknowledges the quit
 * once it stopped; any other control is acknowledged as soon as it is applied.
 */
export function workerControlHandlers(targets: WorkerControlTargets): WorkerControlHandlers {
	return {
		async apply(next) {
			for (const run of targets.runs()) {
				if (next.state === "paused") {
					await targets.tools(run.id)?.pause();
					await targets.stages(run.id).pause();
				} else if (next.state === "running") {
					await targets.tools(run.id)?.resume();
					await targets.stages(run.id).resume();
				}
			}
		},
		async applied(next) {
			const attempt = targets.attempt();
			if (next.state === "quit" && attempt) {
				attempt.abort(new WorkflowGracefulQuitError(targets.runs()[0]?.id ?? targets.root, "root worker control"));
				return;
			}
			await targets.acknowledge(next.revision);
		},
	};
}
