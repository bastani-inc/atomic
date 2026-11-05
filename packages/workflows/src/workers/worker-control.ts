import type { PoolControl } from "../durable/journal/sql-pool-queue.js";

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
