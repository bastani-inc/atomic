import { adoptToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { adoptCancellationRegistry } from "../runs/background/cancellation-registry.js";
import { adoptJobTracker } from "../runs/background/job-tracker.js";
import { adoptStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { adoptStageUiBroker } from "../shared/stage-ui-broker.js";
import { adoptWorkflowHostStore } from "../shared/store-factory.js";

/**
 * Re-bind every run-scoped singleton to host session state for `scope`.
 * No-op when the host has not supplied a scope (unit tests, embedded SDK).
 */
export function adoptWorkflowSessionRunState(scope: object | undefined): void {
	if (scope === undefined) return;
	const { recoveredCurrent } = adoptWorkflowHostStore(scope);
	adoptStageControlRegistry(scope, recoveredCurrent);
	adoptCancellationRegistry(scope, recoveredCurrent);
	adoptToolControlRegistry(scope, recoveredCurrent);
	adoptJobTracker(scope, recoveredCurrent);
	adoptStageUiBroker(scope, recoveredCurrent);
}
