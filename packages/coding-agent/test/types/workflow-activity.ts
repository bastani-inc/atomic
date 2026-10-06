import type * as Extensions from "../../src/core/extensions/index.js";
import type * as Contracts from "../../src/core/extensions/workflow-events.js";
import type * as Host from "../../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type PublicContracts = [
	Assert<Equal<Host.WorkflowActivityState, Contracts.WorkflowActivityState>>,
	Assert<Equal<Host.WorkflowActivityReason, Contracts.WorkflowActivityReason>>,
	Assert<Equal<Host.WorkflowRootActivity, Contracts.WorkflowRootActivity>>,
	Assert<Equal<Host.WorkflowObservationCursor, Contracts.WorkflowObservationCursor>>,
	Assert<Equal<Host.WorkflowActivityFrame, Contracts.WorkflowActivityFrame>>,
	Assert<Equal<Host.WorkflowLifecycleDelivery, Contracts.WorkflowLifecycleDelivery>>,
	Assert<Equal<Host.WorkflowLifecycleTarget, Contracts.WorkflowLifecycleTarget>>,
	Assert<Equal<Host.WorkflowLifecycleEvent, Contracts.WorkflowLifecycleEvent>>,
	Assert<Equal<Host.WorkflowStageCompletedEvent, Contracts.WorkflowStageCompletedEvent>>,
	Assert<Equal<Host.WorkflowActivityChangedEvent, Contracts.WorkflowActivityChangedEvent>>,
	Assert<Equal<Host.WorkflowHeartbeatEvent, Contracts.WorkflowHeartbeatEvent>>,
	Assert<Equal<Host.WorkflowRunStatus, Contracts.WorkflowRunStatus>>,
	Assert<Equal<Host.WorkflowStageStatus, Contracts.WorkflowStageStatus>>,
	Assert<Equal<Host.WorkflowToolNodeStatus, Contracts.WorkflowToolNodeStatus>>,
	Assert<Equal<Host.WorkflowControlAction, Contracts.WorkflowControlAction>>,
	Assert<Equal<Extensions.WorkflowActivityPublisher, Host.WorkflowActivityPublisher>>,
	Assert<Equal<Extensions.WorkflowActivityObserver, Host.WorkflowActivityObserver>>,
	Assert<Equal<Extensions.WorkflowActivitySubscription, Host.WorkflowActivitySubscription>>,
	Assert<Equal<Extensions.WorkflowObservationDiagnostic, Host.WorkflowObservationDiagnostic>>,
	Assert<Equal<Extensions.WorkflowEvent, Host.WorkflowEvent>>,
	Assert<Equal<Extensions.WorkflowActivitySnapshotInput, Host.WorkflowActivitySnapshotInput>>,
	Assert<Equal<Extensions.WorkflowActivitySnapshotFrame, Host.WorkflowActivitySnapshotFrame>>,
	Assert<Equal<Host.WorkflowRootGraph, Contracts.WorkflowRootGraph>>,
	Assert<Equal<Host.WorkflowGraphNode, Contracts.WorkflowGraphNode>>,
	Assert<Equal<Host.WorkflowGraphNodePrompt, Contracts.WorkflowGraphNodePrompt>>,
	Assert<Equal<Host.WorkflowGraphRunPrompt, Contracts.WorkflowGraphRunPrompt>>,
];

export function sessionWorkflowObservation(workflows: Host.SessionWorkflows): void {
	const lease: Host.WorkflowActivitySubscription = workflows.observe((frame) => {
		if (frame.kind !== "changed") return;
		for (const node of frame.root.graph?.nodes ?? []) {
			const parents: readonly string[] = node.parentIds;
			void parents;
			if (node.kind === "tool") {
				const ordinal: number = node.ordinal;
				const status: Host.WorkflowToolNodeStatus = node.status;
				void [ordinal, status];
			} else {
				const prompt: string | undefined = node.pendingPrompt?.message;
				const status: Host.WorkflowStageStatus = node.status;
				void [prompt, status];
			}
		}
	});
	lease.dispose();
}

export function runControlRegistration(pi: Extensions.ExtensionAPI, control: Host.WorkflowRunControl): void {
	pi.registerWorkflowRunControl(control);
	// @ts-expect-error Observation belongs to the session handle; registered controls do not implement it.
	const observe: Host.SessionWorkflows = control;
	void observe;
}

export function workflowHooks(pi: Extensions.ExtensionAPI, ctx: Host.ExtensionContext): void {
	pi.on("workflow_lifecycle", (event) => {
		const value: Host.WorkflowLifecycleEvent = event;
		void value;
	});
	pi.on("workflow_stage_completed", (event) => {
		const status: "completed" = event.target.status;
		void status;
	});
	pi.on("workflow_activity_changed", (event) => {
		const value: Host.WorkflowActivityChangedEvent = event;
		void value;
	});
	pi.on("workflow_heartbeat", (event) => {
		const value: Host.WorkflowHeartbeatEvent = event;
		void value;
	});
	const lease: { dispose(): void } = ctx.observeWorkflowActivity(async (frame) => {
		if (frame.kind === "snapshot" && frame.availability === "ready") {
			const roots: readonly Host.WorkflowRootActivity[] = frame.roots;
			void roots;
		}
	});
	lease.dispose();
	pi.registerWorkflowActivityPublisher().publishSnapshot({ availability: "unavailable" });
}

export function workflowFrameNarrowing(frame: Host.WorkflowActivityFrame): void {
	if (frame.kind === "snapshot" && frame.availability !== "ready") {
		// @ts-expect-error Unknown availability omits roots rather than reporting known emptiness.
		void frame.roots;
	}
	// @ts-expect-error Stage outcomes mirror the runtime union, which has no cancelled stage.
	const status: Host.WorkflowStageStatus = "cancelled";
	void status;
}
