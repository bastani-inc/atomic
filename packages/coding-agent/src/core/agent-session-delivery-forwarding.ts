import type { SendMessageOptions } from "./extensions/index.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

/** Resolve a retired workflow-stage session to its single live delivery owner. */
export function resolveWorkflowStageDeliveryTarget(session: AgentSession): AgentSession {
	let current = session;
	const visited = new Set<AgentSession>();
	while (current._workflowStageDeliveryForwardTarget !== undefined) {
		if (visited.has(current)) return session;
		visited.add(current);
		current = current._workflowStageDeliveryForwardTarget;
	}
	return current;
}

/** Install one acyclic retirement edge before queue ownership is moved. */
export function forwardWorkflowStageDeliveries(source: AgentSession, target: AgentSession): AgentSession | undefined {
	const liveSource = resolveWorkflowStageDeliveryTarget(source);
	const liveTarget = resolveWorkflowStageDeliveryTarget(target);
	if (liveSource === liveTarget || liveTarget === source) return undefined;
	liveSource._workflowStageDeliveryForwardTarget = liveTarget;
	if (liveSource !== source) source._workflowStageDeliveryForwardTarget = liveTarget;
	return liveSource;
}

/** A delivery already admitted by the source must not re-enter the shared generation boundary. */
export function forwardedMessageOptions(options?: SendMessageOptions): SendMessageOptions | undefined {
	if (options === undefined) return undefined;
	return {
		...(options.triggerTurn === undefined ? {} : { triggerTurn: options.triggerTurn }),
		...(options.deliverAs === undefined ? {} : { deliverAs: options.deliverAs }),
		...(options.excludeFromContext === undefined ? {} : { excludeFromContext: options.excludeFromContext }),
		...(options.persistWhenStreaming === undefined ? {} : { persistWhenStreaming: options.persistWhenStreaming }),
		...(options.interruptAbortMessage === undefined ? {} : { interruptAbortMessage: options.interruptAbortMessage }),
	};
}
