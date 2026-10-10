import type { AgentSession } from "../../core/agent-session.js";
import type { WorkflowActivityFrame, WorkflowRootActivity } from "../../core/extensions/workflow-events.js";
import { serializeInteractiveEngineMessage } from "./protocol.js";

function withoutGraph({ graph: _graph, ...summary }: WorkflowRootActivity): WorkflowRootActivity {
	return summary;
}

/**
 * Forward the engine's workflow activity to the host that owns the terminal. The host reports it as
 * program status, which needs each root's state and outcome but never its graph, so frames that
 * change only the graph are not sent.
 */
export function forwardWorkflowActivity(session: AgentSession, write: (line: string) => void): () => void {
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
		write(serializeInteractiveEngineMessage({ type: "engine_workflow_activity", frame: forward }));
	});
	return () => subscription.dispose();
}

/**
 * The host's view of the engine's workflow activity. The engine publishes its snapshot as soon as it
 * binds, which can be before the host attaches an observer, so the host keeps the frames folded into
 * one current snapshot and replays that to every observer that attaches later.
 */
export class WorkflowActivityMirror {
	private cursor: WorkflowActivityFrame["cursor"] | undefined;
	private availability: "ready" | "recovering" | "unavailable" = "unavailable";
	private readonly roots = new Map<string, WorkflowRootActivity>();

	apply(frame: WorkflowActivityFrame): void {
		this.cursor = frame.cursor;
		if (frame.kind === "snapshot") {
			this.availability = frame.availability;
			this.roots.clear();
			if (frame.availability === "ready") for (const root of frame.roots) this.roots.set(root.rootRunId, root);
		} else if (frame.kind === "changed") this.roots.set(frame.root.rootRunId, frame.root);
		else this.roots.delete(frame.rootRunId);
	}

	/** The snapshot a late observer starts from; absent until the engine published something. */
	current(): WorkflowActivityFrame | undefined {
		if (!this.cursor) return undefined;
		const cursor = { ...this.cursor };
		return this.availability === "ready"
			? { kind: "snapshot", cursor, availability: "ready", roots: [...this.roots.values()] }
			: { kind: "snapshot", cursor, availability: this.availability };
	}

	reset(): void {
		this.cursor = undefined;
		this.availability = "unavailable";
		this.roots.clear();
	}
}
