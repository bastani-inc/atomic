import type { ExtensionContext } from "@bastani/atomic";

/**
 * Workflow-stage traffic must reach the AgentSession synchronously so its shared
 * generation boundary, rather than Intercom's idle queue, owns admission.
 */
export function admitWorkflowStageInbound(
	ctx: Pick<ExtensionContext, "orchestrationContext">,
	deliver: () => void,
): boolean {
	if (ctx.orchestrationContext?.kind !== "workflow-stage") return false;
	deliver();
	return true;
}
