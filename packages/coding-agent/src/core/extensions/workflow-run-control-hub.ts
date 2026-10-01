import {
	type SessionWorkflows,
	type WorkflowRunAllTarget,
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
	private control: SessionWorkflows | undefined;
	private disposed = false;

	register(control: SessionWorkflows): WorkflowRunControlRegistration {
		if (this.disposed) return { dispose: () => {} };
		this.control = control;
		return {
			dispose: () => {
				if (this.control === control) this.control = undefined;
			},
		};
	}

	current(): SessionWorkflows | undefined {
		return this.control;
	}

	dispose(): void {
		this.disposed = true;
		this.control = undefined;
	}
}

/** Stable per-session handle that follows the current extension generation across reloads. */
export class SessionWorkflowsHandle implements SessionWorkflows {
	private readonly resolve: () => SessionWorkflows | undefined;

	constructor(resolve: () => SessionWorkflows | undefined) {
		this.resolve = resolve;
	}

	private control(): SessionWorkflows {
		const control = this.resolve();
		if (control === undefined) throw new WorkflowRunControlUnavailableError();
		return control;
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
