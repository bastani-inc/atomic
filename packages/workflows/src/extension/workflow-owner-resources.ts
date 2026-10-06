import { currentToolControlRegistry, type ToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { currentJobTracker, type JobTracker } from "../runs/background/job-tracker.js";
import { currentStageControlRegistry, type StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { currentStageUiBroker, type StageUiBroker } from "../shared/stage-ui-broker.js";
import type { Store } from "../shared/store.js";
import { currentWorkflowStore } from "../shared/store-factory.js";

/** Concrete resources captured at the owning extension's construction, not mutable facades. */
export interface WorkflowOwnerResources {
	readonly store: Store;
	readonly toolControlRegistry: ToolControlRegistry;
	readonly stageControlRegistry: StageControlRegistry;
	readonly stageUiBroker: StageUiBroker;
	readonly jobs: JobTracker;
}

export function captureWorkflowOwnerResources(
	resources: WorkflowOwnerResources = {
		store: currentWorkflowStore(),
		toolControlRegistry: currentToolControlRegistry(),
		stageControlRegistry: currentStageControlRegistry(),
		stageUiBroker: currentStageUiBroker(),
		jobs: currentJobTracker(),
	},
): WorkflowOwnerResources {
	return {
		store: resources.store,
		toolControlRegistry: resources.toolControlRegistry,
		stageControlRegistry: resources.stageControlRegistry,
		stageUiBroker: resources.stageUiBroker,
		jobs: resources.jobs,
	};
}
