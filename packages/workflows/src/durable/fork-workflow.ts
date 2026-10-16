import { randomUUID } from "node:crypto";
import { SessionManager } from "@bastani/atomic";
import { isToolPayloadObject } from "../shared/tool-payload-bounds.js";
import { formatWorkflowStageTarget, parseWorkflowStageTarget } from "../shared/workflow-stage-target.js";
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
	const mapTarget = (target: string): string => {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined || parsed.rootRunId !== source.workflowId) return target;
		return formatWorkflowStageTarget(workflowId, ...parsed.segments.map((segment) => ids.get(segment) ?? segment));
	};
	const mapRun = (run: DurableStageRunTopology): DurableStageRunTopology => ({
		...run,
		runId: mapId(run.runId),
		...(run.parentRunId === undefined ? {} : { parentRunId: mapId(run.parentRunId) }),
		...(run.rootRunId === undefined ? {} : { rootRunId: workflowId }),
	});
	const sessions = new Map<string, SessionManager>();
	const checkpoints: DurableCheckpoint[] = [];
	for (const checkpoint of backend.listCheckpoints(source.workflowId)) {
		const copy = structuredClone(checkpoint);
		if (copy.kind === "ui") {
			checkpoints.push({ ...copy, workflowId });
			continue;
		}
		const topology = copy.topology;
		if (copy.kind === "tool") {
			checkpoints.push({
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
			});
			continue;
		}
		const stageTopology = copy.topology;
		const boundary = stageTopology?.boundary;
		const taskOutput =
			isToolPayloadObject(copy.output) && typeof copy.output.text === "string" ? copy.output : undefined;
		const sessionFile =
			copy.sessionFile ?? (typeof taskOutput?.sessionFile === "string" ? taskOutput.sessionFile : undefined);
		let session = sessionFile === undefined ? undefined : sessions.get(sessionFile);
		if (session === undefined && sessionFile !== undefined) {
			session = await SessionManager.forkFromAsync(sessionFile, cwd, undefined, {
				internal: true,
				workflow: { runId: workflowId, stageId: stageTopology?.stageId ?? copy.checkpointId, stageName: copy.name },
			});
			sessions.set(sessionFile, session);
		}
		const childOutput = boundary === undefined ? undefined : parseWorkflowChildResult(copy.output);
		checkpoints.push({
			...copy,
			workflowId,
			...(childOutput === undefined ? {} : { output: { ...childOutput, runId: mapId(childOutput.runId) } }),
			...(taskOutput === undefined
				? {}
				: {
						output: { ...taskOutput, sessionId: session?.getSessionId(), sessionFile: session?.getSessionFile() },
					}),
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
		});
	}
	const fork = {
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
			stageKey: mapTarget(message.stageKey),
			...(message.targetPath === undefined ? {} : { targetPath: mapTarget(message.targetPath) }),
		})),
	};
	await backend.registerWorkflow({ ...fork, status: "running", resumable: false });
	for (const checkpoint of checkpoints) await backend.recordCheckpointAsync(checkpoint);
	await backend.registerWorkflow({
		...fork,
		resumable: source.resumable ?? true,
		completedCheckpoints: backend.getWorkflow(workflowId)!.completedCheckpoints,
	});
	return workflowId;
}
