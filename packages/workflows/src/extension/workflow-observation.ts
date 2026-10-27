import type {
	WorkflowActivityPublisher,
	WorkflowGraphNode,
	WorkflowRootActivity,
	WorkflowRootGraph,
} from "@bastani/atomic";
import type { Store } from "../shared/store.js";
import { workflowObservationRuntime } from "../shared/store-factory.js";
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import { projectWorkflowActivity } from "../shared/workflow-activity.js";
import type { WorkflowRuntimeEvent } from "../shared/workflow-observation-runtime.js";

/** Keys of a root graph that serialize, in order. */
function serializedGraphKeys(graph: WorkflowRootGraph): (keyof WorkflowRootGraph)[] {
	return (Object.keys(graph) as (keyof WorkflowRootGraph)[]).filter((key) => graph[key] !== undefined);
}

function sameSerializedNodes(left: readonly WorkflowGraphNode[], right: readonly WorkflowGraphNode[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const before = left[index];
		const after = right[index];
		if (before !== after && (JSON.stringify(before) ?? "null") !== (JSON.stringify(after) ?? "null")) return false;
	}
	return true;
}

/**
 * Whether two root activities serialize to the same JSON, compared part by part (#4009).
 * Projection reuses the graph nodes of unchanged runs, so nodes compare by identity first and
 * only changed ones are serialized; the outcome equals comparing the whole serializations,
 * since `graph` is the last key of every projected root.
 */
function sameSerializedRoot(previous: WorkflowRootActivity | undefined, next: WorkflowRootActivity): boolean {
	if (previous === undefined) return false;
	const { graph: previousGraph, ...previousHead } = previous;
	const { graph: nextGraph, ...nextHead } = next;
	if (previousGraph === undefined || nextGraph === undefined) return JSON.stringify(previous) === JSON.stringify(next);
	if (JSON.stringify(previousHead) !== JSON.stringify(nextHead)) return false;
	const keys = serializedGraphKeys(previousGraph);
	const nextKeys = serializedGraphKeys(nextGraph);
	if (keys.length !== nextKeys.length || keys.some((key, index) => key !== nextKeys[index])) return false;
	return keys.every((key) =>
		key === "nodes"
			? sameSerializedNodes(previousGraph.nodes, nextGraph.nodes)
			: previousGraph[key] === nextGraph[key] ||
				JSON.stringify(previousGraph[key]) === JSON.stringify(nextGraph[key]),
	);
}

/** Pending root-activity publications of every live bridge. */
const pendingPublications = new Set<() => void>();

/**
 * Publishes the root activity of store changes still waiting for the end of the current turn of
 * the event loop, so a caller that observed a run settle reads activity consistent with it.
 */
export function flushWorkflowActivityPublications(): void {
	for (const flush of pendingPublications) flush();
}

/** One bridge per extension activation, attached to its concrete adopted store. */
export function createWorkflowObservation(
	store: Store,
	publisher: WorkflowActivityPublisher,
	ownerSessionId: string,
): { dispose(): void } {
	const runtime = workflowObservationRuntime(store);
	let roots = new Map<string, WorkflowRootActivity>();
	const project = (): WorkflowRootActivity[] =>
		projectWorkflowActivity({ snapshot: store.graphSnapshot(), ownership: { ...runtime, ownerSessionId } });
	const snapshot = (): void => {
		if (runtime.recovering) publisher.publishSnapshot({ availability: "recovering" });
		else {
			const current = project();
			roots = new Map(current.map((root) => [root.rootRunId, root]));
			publisher.publishSnapshot({ availability: "ready", roots: current });
		}
	};
	// Root activity is projected once per turn of the event loop rather than once per store
	// change (#4009): a pooled fan-out publishes hundreds of store changes in one burst, and each
	// projection costs the whole root graph. The final state of every burst is published; the
	// intermediate states inside it are not.
	let pending = false;
	let disposed = false;
	const flush = (): void => {
		if (!pending) return;
		pending = false;
		if (disposed || runtime.recovering) return;
		const current = project();
		const next = new Map(current.map((root) => [root.rootRunId, root]));
		for (const root of current) {
			if (!sameSerializedRoot(roots.get(root.rootRunId), root)) publisher.publishChanged(root);
		}
		for (const id of roots.keys()) if (!next.has(id)) publisher.publishRemoved(id);
		roots = next;
	};
	const unsubscribe = subscribeStoreInvalidation(store, () => {
		if (runtime.recovering || pending) return;
		pending = true;
		process.nextTick(flush);
	});
	pendingPublications.add(flush);
	publisher.bindPendingPublications?.(flush);
	const observeRuntime = (event: WorkflowRuntimeEvent): void => {
		if (event.kind === "availability") {
			pending = false;
			snapshot();
		} else if (event.kind === "lifecycle") {
			// A root run's own transition is never announced ahead of the root activity it settles.
			const { target, rootRunId } = event.event;
			if (target.kind === "run" && target.runId === rootRunId) {
				pending = true;
				flush();
			}
			publisher.publishLifecycle({ ...event.event, ownerSessionId });
		} else publisher.publishHeartbeat({ ...event.event, ownerSessionId });
	};
	runtime.listeners.add(observeRuntime);
	snapshot();
	return {
		dispose() {
			flush();
			disposed = true;
			pendingPublications.delete(flush);
			unsubscribe();
			runtime.listeners.delete(observeRuntime);
			publisher.dispose();
		},
	};
}
