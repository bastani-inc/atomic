import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SessionManager } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableCheckpoint, DurableStageRunTopology, DurableWorkflowHandle } from "./types.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

export async function forkDurableWorkflow(
	backend: DurableWorkflowBackend,
	source: DurableWorkflowHandle,
	cwd: string,
	modelOwner: string | undefined,
): Promise<string> {
	source = structuredClone(source);
	const workflowId = randomUUID();
	const ids = new Map([[source.workflowId, workflowId]]);
	const mapId = (id: string): string => {
		let mapped = ids.get(id);
		if (mapped === undefined) {
			mapped = randomUUID();
			ids.set(id, mapped);
		}
		return mapped;
	};
	const mapRun = (run: DurableStageRunTopology): DurableStageRunTopology => ({
		...run,
		runId: mapId(run.runId),
		...(run.parentRunId === undefined ? {} : { parentRunId: mapId(run.parentRunId) }),
		...(run.rootRunId === undefined ? {} : { rootRunId: workflowId }),
	});
	const sessions = new Map<string, SessionManager>();
	const checkpoints: DurableCheckpoint[] = backend.listCheckpoints(source.workflowId).map((checkpoint) => {
		const copy = structuredClone(checkpoint);
		if (copy.kind === "ui") return { ...copy, workflowId };
		const topology = copy.topology;
		if (copy.kind === "tool")
			return {
				...copy,
				workflowId,
				...(topology === undefined
					? {}
					: {
							topology: {
								...copy.topology!,
								...(copy.topology?.run === undefined ? {} : { run: mapRun(copy.topology.run) }),
							},
						}),
			};
		const stageTopology = copy.topology;
		const boundary = stageTopology?.boundary;
		let session = copy.sessionFile === undefined ? undefined : sessions.get(copy.sessionFile);
		if (session === undefined && copy.sessionFile !== undefined && existsSync(copy.sessionFile)) {
			session = SessionManager.forkFrom(copy.sessionFile, cwd, undefined, {
				internal: true,
				workflow: { runId: workflowId, stageId: stageTopology?.stageId ?? copy.checkpointId, stageName: copy.name },
			});
			sessions.set(copy.sessionFile, session);
		}
		const childOutput = boundary === undefined ? undefined : parseWorkflowChildResult(copy.output);
		return {
			...copy,
			workflowId,
			...(childOutput === undefined ? {} : { output: { ...childOutput, runId: mapId(childOutput.runId) } }),
			sessionId: session?.getSessionId(),
			sessionFile: session?.getSessionFile(),
			...(stageTopology === undefined
				? {}
				: {
						topology: {
							...stageTopology,
							intercomGroup: undefined,
							...(stageTopology.run === undefined ? {} : { run: mapRun(stageTopology.run) }),
							...(boundary === undefined
								? {}
								: {
										boundary: {
											...boundary,
											child: {
												...boundary.child,
												runId: mapId(boundary.child.runId),
												parentRunId: mapId(boundary.child.parentRunId),
												rootRunId: workflowId,
											},
										},
									}),
						},
					}),
		};
	});
	backend.registerWorkflow({
		...source,
		workflowId,
		rootWorkflowId: undefined,
		invocationCwd: cwd,
		workflowCwd: undefined,
		repositoryRoot: undefined,
		gitWorktreeRoot: undefined,
		sessionFile: undefined,
		modelOwner,
		releasedModelOwner: undefined,
		ownerExecutorId: undefined,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		completedCheckpoints: 0,
		pendingStageMessages: source.pendingStageMessages?.map((message) => ({
			...message,
			runId: mapId(message.runId),
		})),
	});
	await backend.flush(workflowId);
	for (const checkpoint of checkpoints) await backend.recordCheckpointAsync(checkpoint);
	await backend.flush(workflowId);
	return workflowId;
}
