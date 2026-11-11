import { failureDebugFields, reportDebug } from "../../core/debug.ts";
import type { ToolStatusReport } from "../../core/tool-status.js";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

export interface UnavailableToolsNoticeMode {
	readonly runtimeHost?: InteractiveModeBase["runtimeHost"];
	readonly session: Pick<InteractiveModeBase["session"], "getToolStatus">;
	readonly startupNoticesContainer: InteractiveModeBase["startupNoticesContainer"];
	showWarning(message: string, targetContainer?: InteractiveModeBase["startupNoticesContainer"]): void;
}

async function readStartupToolStatus(mode: UnavailableToolsNoticeMode): Promise<ToolStatusReport> {
	const host = mode.runtimeHost;
	if (!(host instanceof IsolatedInteractiveRuntime)) return mode.session.getToolStatus();
	// The runtime reports a failed resource load as its own diagnostic; the tools that failure left missing are
	// reported from the status read after it.
	await host.waitUntilResourcesReady().catch(() => undefined);
	return host.getToolStatus();
}

export function formatUnavailableToolsNotice(report: Pick<ToolStatusReport, "missing">): string | undefined {
	const names = report.missing.map((tool) => tool.name);
	if (names.length === 0) return undefined;
	const subject = names.length === 1 ? "A tool this session was using isn't" : "Tools this session was using aren't";
	return `${subject} available right now: ${names.join(", ")}. /tools shows why; /reload retries once that is fixed.`;
}

/**
 * Once startup has loaded extensions, name every selected tool, and every tool the session's history records as
 * active, that nothing registered, so a tool never goes missing silently after a resume (#4660).
 */
export async function showUnavailableToolsNotice(mode: UnavailableToolsNoticeMode): Promise<void> {
	const notice = formatUnavailableToolsNotice(await readStartupToolStatus(mode));
	if (notice) mode.showWarning(notice, mode.startupNoticesContainer);
}

/**
 * Shows the notice and never fails startup: the notice only helps, so a status that cannot be read leaves the session
 * as it is, with its tools, and what follows startup still runs. The reason goes to the debug log (#4660).
 */
export async function reportUnavailableTools(mode: UnavailableToolsNoticeMode): Promise<void> {
	try {
		await showUnavailableToolsNotice(mode);
	} catch (error) {
		reportDebug("storage", "startup-tool-status-unreadable", failureDebugFields(error));
	}
}
