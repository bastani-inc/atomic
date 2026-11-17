import { reportDebugAsync as reportDebug } from "../../core/debug.ts";
import { stripAnsi } from "../../utils/ansi.js";
import { warnDeprecation } from "../../utils/deprecation.js";
import { type ActivityWatchdogDiagnostic, shouldRenderEngineDiagnosticAsChatError } from "./activity-watchdog.ts";

export interface EngineDiagnosticView {
	stopWorkingLoader(): void;
	showStatus(message: string, persist?: boolean): void;
	showError(message: string): void;
}

/** Sanitize only the display copy, like task-detail's multiline presentation. */
export function renderDiagnosticStatus(message: string, view: Pick<EngineDiagnosticView, "showStatus">): void {
	// ANSI stripping alone misses bare C0/C1 controls and incomplete escape sequences.
	const text = stripAnsi(message).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
	view.showStatus(text, true);
}

const DEPRECATION_LINE = /^Deprecation warning: (.+)$/;

/**
 * Show the engine's stderr as status, except its deprecation warnings: those go through this process's deprecation
 * warnings, so a warning both processes raise about the same settings file is shown once.
 */
function renderEngineStderr(message: string, view: Pick<EngineDiagnosticView, "showStatus">): void {
	const rest: string[] = [];
	for (const line of message.split(/\r?\n/)) {
		const deprecation = DEPRECATION_LINE.exec(stripAnsi(line).trim());
		if (deprecation) warnDeprecation(deprecation[1]!);
		else rest.push(line);
	}
	if (rest.some((line) => line.trim() !== "")) renderDiagnosticStatus(rest.join("\n"), view);
}

/**
 * Host presentation policy for interactive-engine diagnostics.
 *
 * Engine recovery is operational status, not a failure: the engine-death
 * teardown has already remounted the editor and restored focus, so a replacement
 * that succeeds is silent and its reason goes to the debug log. A replacement
 * that fails is a concrete failure and still surfaces. Heartbeat-watchdog gaps stay
 * internal. Concrete engine failures still surface as chat errors.
 */
export function renderEngineDiagnostic(diagnostic: ActivityWatchdogDiagnostic, view: EngineDiagnosticView): void {
	if (diagnostic.source === "stderr") {
		renderEngineStderr(diagnostic.message, view);
		return;
	}
	if (diagnostic.source === "recovery") {
		view.stopWorkingLoader();
		reportDebug("engine", "interactive-engine-recovery", { message: diagnostic.message });
		return;
	}
	if (shouldRenderEngineDiagnosticAsChatError(diagnostic)) view.showError(diagnostic.message);
}
