import { type ActivityWatchdogDiagnostic, shouldRenderEngineDiagnosticAsChatError } from "./activity-watchdog.ts";

export interface EngineDiagnosticView {
	stopWorkingLoader(): void;
	showStatus(message: string): void;
	showError(message: string): void;
}

/**
 * Host presentation policy for interactive-engine diagnostics.
 *
 * Engine recovery is operational status, not a failure: the engine-death
 * teardown has already remounted the editor and restored focus, so the notice is
 * a calm status line rather than a red chat error. Heartbeat-watchdog gaps stay
 * internal. Concrete engine failures still surface as chat errors.
 */
export function renderEngineDiagnostic(diagnostic: ActivityWatchdogDiagnostic, view: EngineDiagnosticView): void {
	if (diagnostic.source === "recovery") {
		view.stopWorkingLoader();
		view.showStatus(diagnostic.message);
		return;
	}
	if (shouldRenderEngineDiagnosticAsChatError(diagnostic)) view.showError(diagnostic.message);
}
