import { randomUUID } from "node:crypto";
import type {
	WorkflowActivityFrame,
	WorkflowActivityObserver,
	WorkflowActivityPublisher,
	WorkflowActivitySnapshotFrame,
	WorkflowActivitySubscription,
	WorkflowEvent,
	WorkflowObservationCursor,
	WorkflowObservationDiagnostic,
	WorkflowRootActivity,
} from "./workflow-events.js";

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
		const copy = structuredClone(event);
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
		if (this.availability !== "ready")
			this.record(this.availability === "recovering" ? "SourceRecovering" : "SourceUnavailable");
		this.observers.add(lease);
		this.enqueue(lease, this.getSnapshotFrame());
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
			lease.queue = [this.getSnapshotFrame()];
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
				await lease.observer(structuredClone(lease.queue.shift()!));
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
			this.record("SourceUnavailable");
			this.broadcast(this.getSnapshotFrame());
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
				this.roots = new Map(
					input.availability === "ready" ? input.roots.map((root) => [root.rootRunId, { ...root }]) : [],
				);
				this.advance();
				this.broadcast(this.getSnapshotFrame());
			},
			publishChanged: (root) => {
				if (!admitted()) return;
				this.roots.set(root.rootRunId, { ...root });
				const cursor = this.advance();
				this.broadcast({ kind: "changed", cursor, root: { ...root } });
				this.emit({ type: "workflow_activity_changed", cursor, root: { ...root } }, isCurrent);
			},
			publishRemoved: (rootRunId) => {
				if (!admitted()) return;
				this.roots.delete(rootRunId);
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
				this.advance();
				this.record("SourceUnavailable");
				this.broadcast(this.getSnapshotFrame());
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
