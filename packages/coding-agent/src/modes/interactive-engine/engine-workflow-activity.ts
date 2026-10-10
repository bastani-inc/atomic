import type { AgentSession } from "../../core/agent-session.js";
import type { WorkflowActivityFrame, WorkflowRootActivity } from "../../core/extensions/workflow-events.js";
import type { InteractiveEngineMessage } from "./protocol.ts";

function withoutGraph({ graph: _graph, ...summary }: WorkflowRootActivity): WorkflowRootActivity {
	return summary;
}

/**
 * Forward the engine's workflow activity to the host that owns the terminal. The host reports it as
 * program status, which needs each root's state and outcome but never its graph, so frames that
 * change only the graph are not sent.
 */
export function forwardWorkflowActivity(
	session: AgentSession,
	send: (message: InteractiveEngineMessage) => void,
): () => void {
	const sent = new Map<string, string>();
	const subscription = session.workflows.observe((frame) => {
		let forward: WorkflowActivityFrame;
		if (frame.kind === "snapshot") {
			sent.clear();
			if (frame.availability !== "ready") {
				forward = frame;
			} else {
				const roots = frame.roots.map(withoutGraph);
				for (const root of roots) sent.set(root.rootRunId, JSON.stringify(root));
				forward = { ...frame, roots };
			}
		} else if (frame.kind === "changed") {
			const root = withoutGraph(frame.root);
			const key = JSON.stringify(root);
			if (sent.get(root.rootRunId) === key) return;
			sent.set(root.rootRunId, key);
			forward = { ...frame, root };
		} else {
			sent.delete(frame.rootRunId);
			forward = frame;
		}
		send({ type: "engine_workflow_activity", frame: forward });
	});
	return () => subscription.dispose();
}
