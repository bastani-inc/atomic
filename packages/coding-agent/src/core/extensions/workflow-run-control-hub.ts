import type { WorkflowActivityObserver, WorkflowActivitySubscription } from "./workflow-events.js";
import {
	type SessionWorkflows,
	type WorkflowRunAllTarget,
	type WorkflowRunControl,
	type WorkflowRunControlOutcome,
	type WorkflowRunControlRegistration,
	WorkflowRunControlUnavailableError,
	type WorkflowRunDetail,
	type WorkflowRunListFilter,
	type WorkflowRunPauseOptions,
	type WorkflowRunResumeOptions,
	type WorkflowRunStageSummary,
	type WorkflowRunSummary,
	type WorkflowStageListFilter,
} from "./workflow-run-control.js";

/** Holds the run-control implementation that the workflows extension registers for one extension generation. */
export class WorkflowRunControlHub {
	private control: WorkflowRunControl | undefined;
	private disposed = false;

	register(control: WorkflowRunControl): WorkflowRunControlRegistration {
		if (this.disposed) return { dispose: () => {} };
		this.control = control;
		return {
			dispose: () => {
				if (this.control === control) this.control = undefined;
			},
		};
	}

	current(): WorkflowRunControl | undefined {
		return this.control;
	}

	dispose(): void {
		this.disposed = true;
		this.control = undefined;
	}
}

export type ObserveWorkflowActivity = (observer: WorkflowActivityObserver) => WorkflowActivitySubscription;

interface SessionObserverLease {
	/** Serialized delivery shared by every generation this observer is bound to. */
	readonly deliver: WorkflowActivityObserver;
	readonly close: () => void;
	subscription: WorkflowActivitySubscription;
}

/** Stable per-session handle that follows the current extension generation across reloads. */
export class SessionWorkflowsHandle implements SessionWorkflows {
	private readonly resolve: () => WorkflowRunControl | undefined;
	private readonly resolveObserve: () => ObserveWorkflowActivity | undefined;
	private readonly observers = new Set<SessionObserverLease>();

	constructor(
		resolve: () => WorkflowRunControl | undefined,
		resolveObserve: () => ObserveWorkflowActivity | undefined,
	) {
		this.resolve = resolve;
		this.resolveObserve = resolveObserve;
	}

	private control(): WorkflowRunControl {
		const control = this.resolve();
		if (control === undefined) throw new WorkflowRunControlUnavailableError();
		return control;
	}

	observe(observer: WorkflowActivityObserver): WorkflowActivitySubscription {
		const observe = this.resolveObserve();
		if (observe === undefined) throw new WorkflowRunControlUnavailableError();
		let active = true;
		let previous: Promise<void> = Promise.resolve();
		// Each generation delivers independently; chain them so a reload never overlaps two callbacks.
		const deliver: WorkflowActivityObserver = (frame) => {
			const delivery = previous.then(() => (active ? observer(frame) : undefined));
			previous = delivery.catch(() => {});
			return delivery;
		};
		const lease: SessionObserverLease = {
			deliver,
			close: () => {
				active = false;
				lease.subscription.dispose();
			},
			subscription: observe(deliver),
		};
		this.observers.add(lease);
		return {
			dispose: () => {
				if (this.observers.delete(lease)) lease.close();
			},
		};
	}

	/** Move every observer to the current extension generation; each receives that generation's snapshot first. */
	rebindObservers(): void {
		const observe = this.resolveObserve();
		for (const lease of this.observers) {
			lease.subscription.dispose();
			lease.subscription = observe?.(lease.deliver) ?? { dispose: () => {} };
		}
	}

	/** Release every observer when the session closes. */
	disposeObservers(): void {
		for (const lease of this.observers) lease.close();
		this.observers.clear();
	}

	async listRuns(filter?: WorkflowRunListFilter): Promise<readonly WorkflowRunSummary[]> {
		return this.control().listRuns(filter);
	}

	async getRun(runId: string): Promise<WorkflowRunDetail> {
		return this.control().getRun(runId);
	}

	async getStages(runId: string, filter?: WorkflowStageListFilter): Promise<readonly WorkflowRunStageSummary[]> {
		return this.control().getStages(runId, filter);
	}

	pause(runId: string, options?: WorkflowRunPauseOptions): Promise<WorkflowRunControlOutcome>;
	pause(target: WorkflowRunAllTarget): Promise<WorkflowRunControlOutcome>;
	async pause(
		target: string | WorkflowRunAllTarget,
		options?: WorkflowRunPauseOptions,
	): Promise<WorkflowRunControlOutcome> {
		const control = this.control();
		return typeof target === "string" ? control.pause(target, options) : control.pause(target);
	}

	async quit(target: string | WorkflowRunAllTarget): Promise<WorkflowRunControlOutcome> {
		return this.control().quit(target);
	}

	async resume(runId: string, options?: WorkflowRunResumeOptions): Promise<WorkflowRunControlOutcome> {
		return this.control().resume(runId, options);
	}
}
