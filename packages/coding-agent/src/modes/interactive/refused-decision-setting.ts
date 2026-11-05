import { exitOnDecisionConfigError } from "../../cli/settings-startup.ts";
import { findDecisionError, isDecisionConfigError } from "../../core/decision/errors.js";
import type { FullscreenExitOutput } from "../../core/settings-manager.ts";
import { stopThemeWatcher } from "./theme/theme.js";

/**
 * A refused decision-model setting found after startup, such as a renamed `routerModel` key in a project trusted at
 * the prompt, stops Atomic as it does at startup: the message and hint once, then exit status 1. Other errors return.
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
