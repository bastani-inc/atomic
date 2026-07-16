import type { ExtensionContext } from "@bastani/atomic";

/**
 * Workflow-stage traffic must reach the AgentSession synchronously so its shared
 * generation boundary, rather than Intercom's idle queue, owns admission.
 */
export function admitWorkflowStageInbound(
	ctx: Pick<ExtensionContext, "orchestrationContext">,
	deliver: () => void | Promise<void>,
): false | Promise<void> {
	if (ctx.orchestrationContext?.kind !== "workflow-stage") return false;
	try {
		return Promise.resolve(deliver());
	} catch (error) {
		return Promise.reject(error);
	}
}
