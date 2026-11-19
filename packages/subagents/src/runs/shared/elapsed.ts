import { spanElapsedMs, type TaskElapsedSpan } from "@bastani/atomic";
import type { AgentProgress, TaskExecutionHooks } from "../../shared/types.js";

/** End this execution once, before disposal or output delivery can extend it. */
export function finishElapsedSpan(
	span: TaskElapsedSpan,
	hooks?: Pick<TaskExecutionHooks, "reportActivity">,
	progress?: Pick<AgentProgress, "toolCount" | "tokens">,
): void {
	if (span.endedAt !== undefined) return;
	span.endedAt = Date.now();
	try {
		hooks?.reportActivity({
			reportId: "terminal-elapsed",
			change: {
				kind: "metrics",
				elapsedMs: spanElapsedMs(span),
				...(progress === undefined ? {} : { toolCount: progress.toolCount, tokenCount: progress.tokens }),
			},
		});
	} catch {
		// A closing host can refuse the last report. That does not change the result or its time.
	}
}
