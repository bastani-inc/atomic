import type { Store } from "../../shared/store.js";
import { isTerminalRunStatus } from "../../shared/store-internal.js";

/**
 * A stage blocked by a recoverable failure closes resumably, keeping its subagent children resumable with its run. Once
 * that run ends without staying resumable (killed, cancelled, or ended otherwise), the stage closes for good, as a stage
 * that finished does: `close` then ends its children.
 */
export function closeBlockedStageForGoodWhenRunEnds(store: Store, runId: string, close: () => Promise<void>): void {
	const unsubscribe = store.subscribe(() => {
		const run = store.runs().find((candidate) => candidate.id === runId);
		if (run && (!isTerminalRunStatus(run.status) || run.resumable === true)) return;
		unsubscribe();
		if (run) void close().catch(() => {});
	});
}
