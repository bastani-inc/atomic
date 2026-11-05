import { listSubagentControls, subagentControlCount } from "../inprocess/control-registry.js";
import { ownerlessChildCounts } from "./ownerless-children.js";
import { trackedRunWorktreeCount } from "./run-worktrees.js";
import { subagentChildCardStateSizes } from "./subagent-child-card-state.js";
import { earlyChildHoldCount } from "./subagent-child-hold.js";
import { subagentChildRecordRegistrySizes } from "./subagent-child-records.js";
import { subagentRestoreRegistrySizes } from "./subagent-child-restore.js";
import { subagentTaskRegistrySizes } from "./task-execution.js";
import { retainedTaskOutputCount } from "./task-output-retention.js";

/**
 * Every per-child registry the subagents extension keeps in this process, by name. A released child may leave data
 * in the ones that index its record (`records`, `taskIds`, `targets`); the rest must not grow with released children.
 */
export function subagentRegistrySizes(): Readonly<Record<string, number>> {
	const card = subagentChildCardStateSizes();
	const records = subagentChildRecordRegistrySizes();
	const restore = subagentRestoreRegistrySizes();
	const task = subagentTaskRegistrySizes();
	const ownerless = ownerlessChildCounts();
	const controlSizes: Record<string, number> = {};
	for (const control of listSubagentControls())
		for (const [name, size] of Object.entries(control.registrySizes()))
			controlSizes[name] = (controlSizes[name] ?? 0) + size;
	return {
		...controlSizes,
		records: card.records,
		taskIds: card.taskIds,
		targets: card.targets,
		transcripts: card.transcripts,
		cardOwners: card.owners,
		appendChains: records.appendChains,
		stopRequests: records.stopRequests,
		activeRestorations: restore.active,
		goneChildren: restore.gone,
		queuedChildren: task.queued,
		schedules: task.schedules,
		earlyHolds: earlyChildHoldCount(),
		ownerlessLive: ownerless.live,
		ownerlessStoppedQueued: ownerless.stoppedQueued,
		runWorktrees: trackedRunWorktreeCount(),
		retainedTaskOutputs: retainedTaskOutputCount(),
		controls: subagentControlCount(),
	};
}
