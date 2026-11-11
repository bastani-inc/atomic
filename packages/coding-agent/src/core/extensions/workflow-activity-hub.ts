import { randomUUID } from "node:crypto";
import type {
	WorkflowActivityFrame,
	WorkflowActivityObserver,
	WorkflowActivityPublisher,
	WorkflowActivitySnapshotFrame,
	WorkflowActivitySubscription,
	WorkflowEvent,
	WorkflowGraphNode,
	WorkflowObservationCursor,
	WorkflowObservationDiagnostic,
	WorkflowRootActivity,
	WorkflowRootGraph,
} from "./workflow-events.js";

/** Graph nodes found deep-frozen, which every copy of every frame may share. */
const sharedGraphNodes = new WeakSet<WorkflowGraphNode>();
/** Graphs the hub built from a publication; their nodes are all shared. */
const ownedGraphs = new WeakSet<WorkflowRootGraph>();

function isDeepFrozen(value: unknown): boolean {
	if (value === null || typeof value !== "object") return true;
	if (!Object.isFrozen(value)) return false;
	return Object.values(value).every(isDeepFrozen);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

/** A node every copy may share: the node itself when it is deep-frozen, else a deep-frozen copy of it as it is now. */
function shareableNode(node: WorkflowGraphNode): WorkflowGraphNode {
	if (sharedGraphNodes.has(node)) return node;
	if (!isDeepFrozen(node)) return deepFreeze(structuredClone(node));
	sharedGraphNodes.add(node);
	return node;
}

/** A copy of `graph` holding `nodes` as its nodes array, other fields cloned, in the same key order. */
function graphWithNodes(graph: WorkflowRootGraph, nodes: readonly WorkflowGraphNode[]): WorkflowRootGraph {
	const { nodes: _nodes, ...rest } = graph;
	const cloned: Partial<WorkflowRootGraph> = structuredClone(rest);
	const copy: Partial<WorkflowRootGraph> = {};
	for (const key of Object.keys(graph) as (keyof WorkflowRootGraph)[])
		Object.assign(copy, { [key]: key === "nodes" ? nodes : cloned[key] });
	return copy as WorkflowRootGraph;
}

/**
 * A deep copy of a root activity. A graph the hub owns keeps its frozen nodes, shared with every other copy, so a copy
 * costs the root's fields rather than every node of its graph (#4642); anything else is cloned.
 */
function copyRoot(root: WorkflowRootActivity): WorkflowRootActivity {
	const { graph, ...head } = root;
	if (graph === undefined || !ownedGraphs.has(graph)) return structuredClone(root);
	const cloned: Partial<WorkflowRootActivity> = structuredClone(head);
	const copy: Partial<WorkflowRootActivity> = {};
	for (const key of Object.keys(root) as (keyof WorkflowRootActivity)[])
		Object.assign(copy, { [key]: key === "graph" ? graphWithNodes(graph, graph.nodes.slice()) : cloned[key] });
	return copy as WorkflowRootActivity;
}

function copyFrame(frame: WorkflowActivityFrame): WorkflowActivityFrame {
	if (frame.kind === "changed")
		return { ...structuredClone({ ...frame, root: undefined }), root: copyRoot(frame.root) };
	if (frame.kind === "snapshot" && frame.availability === "ready")
		return { ...structuredClone({ ...frame, roots: [] }), roots: frame.roots.map(copyRoot) };
	return structuredClone(frame);
}

function copyEvent(event: WorkflowEvent): WorkflowEvent {
	if (event.type === "workflow_activity_changed")
		return { ...structuredClone({ ...event, root: undefined }), root: copyRoot(event.root) };
	return structuredClone(event);
}

interface ObserverLease {
	observer: WorkflowActivityObserver;
	queue: WorkflowActivityFrame[];
	delivering: boolean;
	active: boolean;
}

export class WorkflowActivityHub {
	private readonly runDelivery: (operation: () => Promise<void>) => Promise<void>;
	constructor(runDelivery: (operation: () => Promise<void>) => Promise<void> = (run) => run()) {
		this.runDelivery = runDelivery;
	}
	private cursor: WorkflowObservationCursor = { epoch: randomUUID(), revision: 0 };
	private availability: "ready" | "recovering" | "unavailable" = "unavailable";
	private roots = new Map<string, WorkflowRootActivity>();
	/** Per root, the nodes of its last publication and the shared nodes the hub kept for them. */
	private publishedNodes = new Map<
		string,
		{ readonly source: readonly WorkflowGraphNode[]; readonly shared: readonly WorkflowGraphNode[] }
	>();
	/**
	 * The publication of a root as the hub keeps it: a shallow copy whose graph holds shareable nodes. A node published
	 * at the same position as before is checked again only when it is another object (#4642).
	 */
	private own(root: WorkflowRootActivity): WorkflowRootActivity {
		const { graph } = root;
		if (graph === undefined) {
			this.publishedNodes.delete(root.rootRunId);
			return { ...root };
		}
		const previous = this.publishedNodes.get(root.rootRunId);
		const shared = previous === undefined ? [] : previous.shared.slice(0, graph.nodes.length);
		for (let index = 0; index < graph.nodes.length; index++) {
			const node = graph.nodes[index]!;
			if (index >= shared.length) shared.push(shareableNode(node));
			else if (node !== previous?.source[index] || node !== shared[index]) shared[index] = shareableNode(node);
		}
		this.publishedNodes.set(root.rootRunId, { source: graph.nodes, shared });
		const owned = graphWithNodes(graph, shared);
		ownedGraphs.add(owned);
		return { ...root, graph: owned };
	}
	private observers = new Set<ObserverLease>();
	private failures: WorkflowObservationDiagnostic[] = [];
	private disposed = false;
	private dispatch?: (event: WorkflowEvent, isCurrent: () => boolean) => Promise<void>;
	private pendingDispatches: (() => void)[] = [];
	/** Publishes root changes the current publisher has coalesced but not yet published. */
	private pendingPublications?: () => void;
	bindDispatcher(dispatch: (event: WorkflowEvent, isCurrent: () => boolean) => Promise<void>): void {
		if (this.disposed) return;
		this.dispatch = dispatch;
		for (const deliver of this.pendingDispatches) deliver();
		this.pendingDispatches = [];
	}
	private emit(event: WorkflowEvent, isCurrent: () => boolean): void {
		const copy = copyEvent(event);
		const deliver = () =>
			queueMicrotask(() => {
				if (!isCurrent()) return;
				void this.dispatch?.(copy, isCurrent).catch(() => this.record("ObserverDeliveryFailed"));
			});
		if (this.dispatch) deliver();
		else this.pendingDispatches.push(deliver);
	}

	getSnapshotFrame(): WorkflowActivitySnapshotFrame {
		this.pendingPublications?.();
		return this.currentSnapshotFrame();
	}
	/** The published state as is; publications the source still coalesces are not flushed. */
	private currentSnapshotFrame(): WorkflowActivitySnapshotFrame {
		return this.availability === "ready"
			? {
					kind: "snapshot",
					cursor: { ...this.cursor },
					availability: "ready",
					roots: [...this.roots.values()].map((root) => ({ ...root })),
				}
			: { kind: "snapshot", cursor: { ...this.cursor }, availability: this.availability };
	}
	observeWorkflowActivity(observer: WorkflowActivityObserver): WorkflowActivitySubscription {
		const lease: ObserverLease = { observer, queue: [], delivering: false, active: true };
		if (this.disposed) {
			this.record("ObserverDisposed");
			return { dispose: () => {} };
		}
		// Publish coalesced changes before this observer exists, so they reach it inside its snapshot
		// rather than as frames queued ahead of it (#4009).
		this.pendingPublications?.();
		if (this.availability !== "ready")
			this.record(this.availability === "recovering" ? "SourceRecovering" : "SourceUnavailable");
		const snapshot = this.currentSnapshotFrame();
		this.observers.add(lease);
		this.enqueue(lease, snapshot);
		return { dispose: () => this.disposeLease(lease) };
	}
	private disposeLease(lease: ObserverLease): void {
		if (!lease.active) return;
		lease.active = false;
		lease.queue = [];
		this.observers.delete(lease);
		this.record("ObserverDisposed");
	}
	private enqueue(lease: ObserverLease, frame: WorkflowActivityFrame): void {
		if (lease.queue.length >= 256) {
			lease.queue = [this.currentSnapshotFrame()];
			this.record("ObserverOverflow");
		} else lease.queue.push(frame);
		if (lease.delivering) return;
		lease.delivering = true;
		void this.runDelivery(async () => {
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await this.deliver(lease);
		});
	}
	private async deliver(lease: ObserverLease): Promise<void> {
		while (lease.active && lease.queue.length) {
			try {
				await lease.observer(copyFrame(lease.queue.shift()!));
			} catch {
				this.record("ObserverDeliveryFailed");
			}
		}
		lease.delivering = false;
	}
	private broadcast(frame: WorkflowActivityFrame): void {
		for (const lease of this.observers) this.enqueue(lease, frame);
	}
	private advance(): WorkflowObservationCursor {
		this.cursor = { ...this.cursor, revision: this.cursor.revision + 1 };
		return { ...this.cursor };
	}
	registerWorkflowActivityPublisher(): WorkflowActivityPublisher {
		let active = !this.disposed;
		if (active) {
			this.cursor = { epoch: randomUUID(), revision: 0 };
			this.pendingPublications = undefined;
			this.availability = "unavailable";
			this.roots.clear();
			this.publishedNodes.clear();
			this.record("SourceUnavailable");
			this.broadcast(this.currentSnapshotFrame());
		}
		const epoch = this.cursor.epoch;
		const isCurrent = () => active && !this.disposed && this.cursor.epoch === epoch;
		const admitted = () => {
			if (isCurrent()) return true;
			this.record("PublisherFenced");
			return false;
		};
		return {
			publishSnapshot: (input) => {
				if (!admitted()) return;
				if (input.availability !== "ready")
					this.record(input.availability === "recovering" ? "SourceRecovering" : "SourceUnavailable");
				this.availability = input.availability;
				const roots = input.availability === "ready" ? input.roots : [];
				const published = new Set(roots.map((root) => root.rootRunId));
				for (const rootRunId of this.publishedNodes.keys())
					if (!published.has(rootRunId)) this.publishedNodes.delete(rootRunId);
				this.roots = new Map(roots.map((root) => [root.rootRunId, this.own(root)]));
				this.advance();
				this.broadcast(this.currentSnapshotFrame());
			},
			publishChanged: (root) => {
				if (!admitted()) return;
				const owned = this.own(root);
				this.roots.set(root.rootRunId, owned);
				const cursor = this.advance();
				this.broadcast({ kind: "changed", cursor, root: { ...owned } });
				this.emit({ type: "workflow_activity_changed", cursor, root: { ...owned } }, isCurrent);
			},
			publishRemoved: (rootRunId) => {
				if (!admitted()) return;
				this.roots.delete(rootRunId);
				this.publishedNodes.delete(rootRunId);
				this.broadcast({ kind: "removed", cursor: this.advance(), rootRunId });
			},
			publishLifecycle: (input) => {
				if (!admitted()) return;
				const event = { ...input, cursor: this.advance() };
				this.emit(event, isCurrent);
				if (event.target.kind === "stage" && event.target.status === "completed") {
					this.emit(
						{ ...event, type: "workflow_stage_completed", target: { ...event.target, status: "completed" } },
						isCurrent,
					);
				}
			},
			publishHeartbeat: (event) => {
				if (admitted()) this.emit(event, isCurrent);
			},
			bindPendingPublications: (flush) => {
				if (!isCurrent()) return;
				const pending = () => {
					if (isCurrent()) flush();
				};
				this.pendingPublications = pending;
			},
			dispose: () => {
				if (!active) return;
				const current = admitted();
				active = false;
				if (!current) return;
				this.availability = "unavailable";
				this.roots.clear();
				this.publishedNodes.clear();
				this.advance();
				this.record("SourceUnavailable");
				this.broadcast(this.currentSnapshotFrame());
			},
		};
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.dispatch = undefined;
		this.pendingDispatches = [];
		for (const lease of this.observers) this.disposeLease(lease);
	}
	diagnostics(): readonly WorkflowObservationDiagnostic[] {
		return structuredClone(this.failures);
	}
	private record(kind: WorkflowObservationDiagnostic["kind"]): void {
		this.failures.push({ kind, cursor: { ...this.cursor } });
		if (this.failures.length > 256) this.failures.shift();
	}
}
