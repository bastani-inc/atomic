import { adoptToolControlRegistry } from "../engine/run-tool-control-registry.js";
import {
	adoptCancellationRegistry,
	type CancellationRegistry,
	currentCancellationRegistry,
} from "../runs/background/cancellation-registry.js";
import { adoptJobTracker } from "../runs/background/job-tracker.js";
import { adoptStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { adoptStageUiBroker } from "../shared/stage-ui-broker.js";
import type { Store } from "../shared/store.js";
import { adoptStore, adoptWorkflowHostStore } from "../shared/store-factory.js";
import { captureWorkflowOwnerResources, type WorkflowOwnerResources } from "./workflow-owner-resources.js";

/**
 * One host session's run-scoped instances. A session resolves them once and
 * passes them explicitly, because the process-global facades follow whichever
 * sibling session adopted last (#3456).
 */
export interface WorkflowSessionRunState extends WorkflowOwnerResources {
	readonly cancellationRegistry: CancellationRegistry;
}

export function currentWorkflowSessionRunState(): WorkflowSessionRunState {
	return { ...captureWorkflowOwnerResources(), cancellationRegistry: currentCancellationRegistry() };
}

/**
 * Re-bind every run-scoped singleton to host session state for `scope` and
 * return that session's instances. Without a scope (unit tests, embedded SDK)
 * nothing is re-bound and the current instances are returned.
 */
export function adoptWorkflowSessionRunState(
	scope: object | undefined,
	scopedOwnership = false,
): WorkflowSessionRunState {
	if (scope === undefined) return currentWorkflowSessionRunState();
	// Explicit ownership retains predecessor runtimes; never infer transfer
	// from whichever sibling most recently adopted a singleton.
	let recoveredCurrent = false;
	let store: Store;
	if (scopedOwnership) store = adoptStore(scope);
	else ({ store, recoveredCurrent } = adoptWorkflowHostStore(scope));
	const stageControlRegistry = adoptStageControlRegistry(scope, recoveredCurrent);
	const cancellationRegistry = adoptCancellationRegistry(scope, recoveredCurrent);
	const toolControlRegistry = adoptToolControlRegistry(scope, recoveredCurrent);
	const jobs = adoptJobTracker(scope, recoveredCurrent);
	const stageUiBroker = adoptStageUiBroker(scope, recoveredCurrent, store);
	return { store, stageControlRegistry, cancellationRegistry, toolControlRegistry, jobs, stageUiBroker };
}
