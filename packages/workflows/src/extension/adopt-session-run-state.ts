/**
 * Re-bind every run-scoped singleton to the host session before use.
 *
 * `/reload` evaluates this package's module graph afresh while the session
 * and its in-flight workflow runs keep going. Adoption at factory time is
 * what lets the replacement extension instance observe and control the runs
 * its predecessor's graph is still executing: the first load registers its
 * instances against the shared host event bus, and every later load of the
 * same session finds them (see shared/session-scoped-singleton.ts).
 *
 * Without a host event bus (unit tests, embedded SDK use) nothing is adopted
 * and every singleton stays module-local, exactly as before.
 */

import { adoptToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { adoptCancellationRegistry } from "../runs/background/cancellation-registry.js";
import { adoptWorkflowJobTracker } from "../runs/background/job-tracker.js";
import { adoptStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { adoptStageUiBroker } from "../shared/stage-ui-broker.js";
import { adoptWorkflowRunStore } from "../shared/store-factory.js";

export function adoptWorkflowSessionRunState(scope: object | undefined): void {
	if (scope === undefined) return;
	adoptWorkflowRunStore(scope);
	adoptStageControlRegistry(scope);
	adoptCancellationRegistry(scope);
	adoptToolControlRegistry(scope);
	adoptWorkflowJobTracker(scope);
	adoptStageUiBroker(scope);
}
