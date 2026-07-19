import type { ExtensionContext } from "@bastani/atomic";

export type WorkflowStageFirstRefusalDisposition = "delivered" | "unclaimed" | "abandoned";

/**
 * Workflow-stage traffic is owned by the AgentSession's shared generation
 * boundary rather than Intercom's idle queue. While that session is busy, the
 * exact foreground subagent owner must first be allowed to detach; otherwise a
 * blocking child request would queue behind the tool call that is awaiting it.
 */
export function admitWorkflowStageInbound(
	ctx: Pick<ExtensionContext, "orchestrationContext"> & Partial<Pick<ExtensionContext, "isIdle">>,
	deliver: () => void | Promise<void>,
	firstRefusal?: () => Promise<WorkflowStageFirstRefusalDisposition>,
): false | Promise<void> {
	if (ctx.orchestrationContext?.kind !== "workflow-stage") return false;
	try {
		let busy = false;
		try {
			busy = ctx.isIdle?.() === false;
		} catch {
			// A retiring context is handled by the generation check in delivery.
		}
		if (!busy || !firstRefusal) return Promise.resolve(deliver());
		return firstRefusal().then((disposition) => {
			if (disposition === "abandoned") {
				throw new Error("Workflow stage retired during foreground-owner admission");
			}
			return deliver();
		});
	} catch (error) {
		return Promise.reject(error);
	}
}
