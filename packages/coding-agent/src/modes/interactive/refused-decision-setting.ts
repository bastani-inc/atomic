import { exitOnDecisionConfigError } from "../../cli/settings-startup.ts";
import { findDecisionError, isDecisionConfigError } from "../../core/decision/errors.js";
import type { FullscreenExitOutput } from "../../core/settings-manager.ts";
import { stopThemeWatcher } from "./theme/theme.js";

/**
 * An invalid `decisionModel` found after startup stops Atomic as it does at startup: the message and hint once,
 * then exit status 1. Legacy `routerModel` settings migrate instead; other errors return.
 */
export function exitOnRefusedDecisionSetting(
	mode: { stop(fullscreenExitOutput?: FullscreenExitOutput): void },
	error: unknown,
): void {
	const refused = findDecisionError(error);
	if (!isDecisionConfigError(refused)) return;
	stopThemeWatcher();
	mode.stop("transcript");
	exitOnDecisionConfigError(refused);
}
