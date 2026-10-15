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
	private recoveryDepth = 0;
	constructor(
		private readonly runs: () => readonly RunSnapshot[],
		private readonly invalidate: () => void,
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
		this.invalidate();
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
		this.invalidate();
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

	/** Read scalar transition state before store observers run; never infer ownership from history. */
	capture(): void {
		const next = new Map<string, WorkflowLifecycleTarget>();
		const visit = (key: string, target: WorkflowLifecycleTarget, historical = false): void => {
			next.set(key, target);
			const previous = this.previous.get(key);
			if (!historical && this.liveRunIds.has(target.runId) && previous?.status !== target.status) {
				this.lifecycle(
					previous && previous.kind !== "prompt" && target.kind !== "prompt"
						? ({ ...target, previousStatus: previous.status } as WorkflowLifecycleTarget)
						: target,
					this.runs().find((run) => run.id === target.runId)?.origin,
				);
			}
		};
		for (const run of this.runs()) {
			const existing = this.previous.has(`run:${run.id}`);
			visit(`run:${run.id}`, { kind: "run", runId: run.id, status: run.status });
			for (const stage of run.stages) {
				visit(
					`stage:${workflowActivityNodeKey(run.id, stage.id)}`,
					{ kind: "stage", runId: run.id, stageId: stage.id, stageName: stage.name, status: stage.status },
					!existing,
				);
				if (stage.pendingPrompt)
					visit(
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
			for (const tool of run.toolNodes)
				visit(
					`tool:${workflowActivityNodeKey(run.id, tool.id)}`,
					{ kind: "tool", runId: run.id, toolNodeId: tool.id, toolName: tool.name, status: tool.status },
					!existing,
				);
			if (run.pendingPrompt)
				visit(
					`prompt:${run.pendingPrompt.id}`,
					{ kind: "prompt", runId: run.id, promptId: run.pendingPrompt.id, status: "opened" },
					!existing,
				);
		}
		this.previous = next;
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
