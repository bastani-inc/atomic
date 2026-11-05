import { dirname, join, resolve } from "node:path";
import { appendDebugRecord, type DebugFields, isDebugEnabled, reportDebug } from "@bastani/atomic";

/**
 * Diagnostic trace of the pooled stage watch path (#3996), off by default.
 *
 * In debug mode, or with `ATOMIC_DEBUG_POOLED_WATCH=1`, the root, the pool coordinator and every local worker record
 * one line per step: watch opens and ends, reconnect decisions, rebinds, outbox sends and their outcomes, airlock
 * admissions and refusals, and the signals that release redelivery. Debug mode writes them to the debug log.
 * `ATOMIC_DEBUG_POOLED_WATCH=1` writes them to `pooled-watch-trace.jsonl` next to the pool journal; set it to a file
 * path to choose the file.
 */
let journalPath: string | undefined;
let role = "root";

/** Names this process in the trace and places the trace next to the pool journal. */
export function configurePooledWatchTrace(journal: string, processRole: string): void {
	journalPath = journal;
	role = processRole;
}

function ownTraceFile(journal: string, setting: string): string {
	return setting === "1" ? join(dirname(resolve(journal)), "pooled-watch-trace.jsonl") : resolve(setting);
}

/** Records one step of the watch path when tracing is on; nothing otherwise. */
export function tracePooledWatch(step: string, detail: DebugFields): void {
	if (!isDebugEnabled("pooled-watch")) return;
	const journal = journalPath;
	const traceRole = role;
	reportDebug(
		"pooled-watch",
		step,
		{ role: traceRole, ...detail },
		journal === undefined
			? undefined
			: (setting) =>
					appendDebugRecord(ownTraceFile(journal, setting), {
						at: new Date().toISOString(),
						pid: process.pid,
						role: traceRole,
						step,
						...detail,
					}),
	);
}
