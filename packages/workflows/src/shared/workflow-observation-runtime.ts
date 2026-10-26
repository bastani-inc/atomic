import { randomUUID } from "node:crypto";
import type {
	WorkflowControlAction,
	WorkflowHeartbeatEvent,
	WorkflowLifecycleEvent,
	WorkflowLifecycleTarget,
} from "@bastani/atomic";
import type { RunSnapshot } from "./store-types.js";
import { workflowActivityNodeKey } from "./workflow-activity.js";

export type WorkflowRuntimeEvent =
	| { kind: "lifecycle"; event: Omit<WorkflowLifecycleEvent, "cursor" | "ownerSessionId"> }
	| { kind: "heartbeat"; event: Omit<WorkflowHeartbeatEvent, "ownerSessionId"> }
	| { kind: "availability" };

/** A store change confined to one run, or to one stage or tool node of it. */
export interface WorkflowObservationChange {
	readonly runId: string;
	readonly stageId?: string;
	readonly toolNodeId?: string;
}

interface ChangedNodes {
	readonly stages: Set<string>;
	readonly tools: Set<string>;
}

/** A run changed as a whole, or only in the named stages and tool nodes. */
type RunChange = "run" | ChangedNodes;

/** Execution ownership stays with the concrete store across host adoption. */
export class WorkflowObservationRuntime {
	readonly liveRunIds = new Set<string>();
	readonly executingStageIds = new Set<string>();
	readonly executingToolNodeIds = new Set<string>();
	readonly stoppingRunIds = new Set<string>();
	readonly retryingStageIds = new Set<string>();
	readonly acknowledgedFailureRunIds = new Set<string>();
	readonly listeners = new Set<(event: WorkflowRuntimeEvent) => void>();
	readonly replayStageIds = new Set<string>();
	private previous = new Map<string, WorkflowLifecycleTarget>();
	/**
	 * Keys of `previous` by run, then by the run itself ("run") or the stage or tool node that owns
	 * them, so a partial capture can drop keys that disappeared.
	 */
	private owners = new Map<string, Map<string, string[]>>();
	private recoveryDepth = 0;
	constructor(
		private readonly runs: () => readonly RunSnapshot[],
		private readonly invalidate: (change?: WorkflowObservationChange) => void,
	) {}

	get recovering(): boolean {
		return this.recoveryDepth > 0;
	}

	/** A run going live owns its execution; any stop left behind by an earlier incarnation is stale. */
	startRun(runId: string): void {
		this.liveRunIds.add(runId);
		this.stoppingRunIds.delete(runId);
	}

	finishRun(runId: string): void {
		this.liveRunIds.delete(runId);
		this.stoppingRunIds.delete(runId);
		for (const ids of [
			this.executingStageIds,
			this.executingToolNodeIds,
			this.retryingStageIds,
			this.replayStageIds,
		]) {
			for (const id of ids) if (id.startsWith(`${runId}:`)) ids.delete(id);
		}
		this.invalidate({ runId });
	}

	private emit(event: WorkflowRuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* Observation cannot fail execution. */
			}
		}
	}

	private rootRunId(run: RunSnapshot): string {
		if (run.rootRunId !== undefined) return run.rootRunId;
		if (run.parentRunId === undefined) return run.id;
		const parent = this.runs().find((candidate) => candidate.id === run.parentRunId);
		return parent ? this.rootRunId(parent) : run.parentRunId;
	}

	lifecycle(target: WorkflowLifecycleTarget, attribution: WorkflowLifecycleEvent["attribution"] = "unknown"): void {
		if (this.recovering && !this.liveRunIds.has(target.runId)) return;
		const run = this.runs().find((candidate) => candidate.id === target.runId);
		if (!run) return;
		const rootRunId = this.rootRunId(run);
		const now = Date.now();
		this.emit({
			kind: "lifecycle",
			event: {
				type: "workflow_lifecycle",
				eventId: randomUUID(),
				runId: run.id,
				rootRunId,
				occurredAt: now,
				observedAt: now,
				target: canonicalTarget(target, rootRunId),
				attribution,
				delivery:
					target.kind === "stage" && this.replayStageIds.has(workflowActivityNodeKey(run.id, target.stageId))
						? "replay"
						: "live",
			},
		});
	}

	control(
		runId: string,
		action: WorkflowControlAction,
		attribution: WorkflowLifecycleEvent["attribution"] = "unknown",
	): void {
		const run = this.runs().find((candidate) => candidate.id === runId);
		if (!run) return;
		if ((action === "quit" || action === "kill" || action === "pause") && this.liveRunIds.has(runId))
			this.stoppingRunIds.add(runId);
		if (action === "resume") this.stoppingRunIds.delete(runId);
		this.lifecycle({ kind: "run", runId, status: run.status, action }, attribution);
		this.invalidate({ runId });
	}

	heartbeat(runId: string, scheduledAt: number, intervalMinutes: number): void {
		const run = this.runs().find((candidate) => candidate.id === runId);
		if (run)
			this.emit({
				kind: "heartbeat",
				event: { type: "workflow_heartbeat", runId, rootRunId: this.rootRunId(run), scheduledAt, intervalMinutes },
			});
	}

	beginRecovery(): () => void {
		this.recoveryDepth++;
		if (this.recoveryDepth === 1) this.emit({ kind: "availability" });
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.capture();
			this.recoveryDepth--;
			if (!this.recovering) this.emit({ kind: "availability" });
		};
	}

	/**
	 * Read scalar transition state before store observers run; never infer ownership from history.
	 *
	 * Without `changes` every run is re-read. With `changes`, only the named runs, stages and tool
	 * nodes are re-read, in store order. The store names them when a mutation changed nothing else,
	 * so the transitions match a full read while the cost follows what changed.
	 */
	capture(changes?: readonly WorkflowObservationChange[]): void {
		if (changes === undefined) {
			const next = new Map<string, WorkflowLifecycleTarget>();
			const nextOwners = new Map<string, Map<string, string[]>>();
			for (const run of this.runs()) {
				const owners = nextOwners.get(run.id) ?? new Map<string, string[]>();
				nextOwners.set(run.id, owners);
				this.captureRun(run, this.previous.has(`run:${run.id}`), next, owners);
			}
			this.previous = next;
			this.owners = nextOwners;
			return;
		}
		if (changes.length === 0) return;
		const changed = new Map<string, RunChange>();
		for (const change of changes) {
			const current = changed.get(change.runId);
			if (current === "run") continue;
			if (change.stageId === undefined && change.toolNodeId === undefined) {
				changed.set(change.runId, "run");
				continue;
			}
			const nodes = current ?? { stages: new Set<string>(), tools: new Set<string>() };
			if (change.stageId !== undefined) nodes.stages.add(change.stageId);
			if (change.toolNodeId !== undefined) nodes.tools.add(change.toolNodeId);
			changed.set(change.runId, nodes);
		}
		for (const run of this.runs()) {
			const change = changed.get(run.id);
			if (change === undefined) continue;
			const existing = this.previous.has(`run:${run.id}`);
			// A run never read before is read whole, so its pre-existing nodes stay historical.
			const nodes = change === "run" || !existing ? undefined : change;
			const next = new Map<string, WorkflowLifecycleTarget>();
			const nextOwners = new Map<string, string[]>();
			this.captureRun(run, existing, next, nextOwners, nodes);
			const owners = this.owners.get(run.id) ?? new Map<string, string[]>();
			const reread =
				nodes === undefined
					? [...owners.keys()]
					: [...[...nodes.stages].map((id) => `stage:${id}`), ...[...nodes.tools].map((id) => `tool:${id}`)];
			for (const owner of reread)
				for (const key of owners.get(owner) ?? []) if (!next.has(key)) this.previous.delete(key);
			for (const [key, target] of next) this.previous.set(key, target);
			if (nodes === undefined) {
				this.owners.set(run.id, nextOwners);
				continue;
			}
			for (const owner of reread) {
				const keys = nextOwners.get(owner);
				if (keys === undefined) owners.delete(owner);
				else owners.set(owner, keys);
			}
			this.owners.set(run.id, owners);
		}
	}

	/**
	 * Visits one run's lifecycle targets into `next`, emitting live transitions, and records under
	 * `owners` which run, stage or tool node each key belongs to. `nodes` limits the visit to the
	 * run's own status and those stages and tool nodes.
	 */
	private captureRun(
		run: RunSnapshot,
		existing: boolean,
		next: Map<string, WorkflowLifecycleTarget>,
		owners: Map<string, string[]>,
		nodes?: ChangedNodes,
	): void {
		const visit = (owner: string, key: string, target: WorkflowLifecycleTarget, historical = false): void => {
			next.set(key, target);
			const keys = owners.get(owner);
			if (keys === undefined) owners.set(owner, [key]);
			else keys.push(key);
			const previous = this.previous.get(key);
			if (!historical && this.liveRunIds.has(target.runId) && previous?.status !== target.status) {
				this.lifecycle(
					previous && previous.kind !== "prompt" && target.kind !== "prompt"
						? ({ ...target, previousStatus: previous.status } as WorkflowLifecycleTarget)
						: target,
					this.runs().find((candidate) => candidate.id === target.runId)?.origin,
				);
			}
		};
		visit("run", `run:${run.id}`, { kind: "run", runId: run.id, status: run.status });
		for (const stage of run.stages) {
			if (nodes !== undefined && !nodes.stages.has(stage.id)) continue;
			const owner = `stage:${stage.id}`;
			visit(
				owner,
				`stage:${workflowActivityNodeKey(run.id, stage.id)}`,
				{ kind: "stage", runId: run.id, stageId: stage.id, stageName: stage.name, status: stage.status },
				!existing,
			);
			if (stage.pendingPrompt)
				visit(
					owner,
					`prompt:${stage.pendingPrompt.id}`,
					{
						kind: "prompt",
						runId: run.id,
						stageId: stage.id,
						promptId: stage.pendingPrompt.id,
						status: "opened",
					},
					!existing,
				);
		}
		for (const tool of run.toolNodes) {
			if (nodes !== undefined && !nodes.tools.has(tool.id)) continue;
			visit(
				`tool:${tool.id}`,
				`tool:${workflowActivityNodeKey(run.id, tool.id)}`,
				{ kind: "tool", runId: run.id, toolNodeId: tool.id, toolName: tool.name, status: tool.status },
				!existing,
			);
		}
		if (nodes === undefined && run.pendingPrompt)
			visit(
				"run",
				`prompt:${run.pendingPrompt.id}`,
				{ kind: "prompt", runId: run.id, promptId: run.pendingPrompt.id, status: "opened" },
				!existing,
			);
	}
}

export const workflowObservationRuntimeKey = Symbol.for("atomic-workflows/store-observation-runtime@1");

function canonicalTarget(target: WorkflowLifecycleTarget, rootRunId: string): WorkflowLifecycleTarget {
	if (target.runId === rootRunId) return target;
	switch (target.kind) {
		case "stage":
			return { ...target, stageId: workflowActivityNodeKey(target.runId, target.stageId) };
		case "tool":
			return { ...target, toolNodeId: workflowActivityNodeKey(target.runId, target.toolNodeId) };
		case "prompt":
			return target.stageId === undefined
				? target
				: { ...target, stageId: workflowActivityNodeKey(target.runId, target.stageId) };
		case "run":
			return target;
	}
}
