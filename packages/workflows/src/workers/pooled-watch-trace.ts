import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Diagnostic trace of the pooled stage watch path (#3996), off by default.
 *
 * With `ATOMIC_DEBUG_POOLED_WATCH=1`, the root, the pool coordinator and every local worker append
 * one JSON line per step to `pooled-watch-trace.jsonl` next to the pool journal: watch opens and
 * ends, reconnect decisions, rebinds, outbox sends and their outcomes, airlock admissions and
 * refusals, and the signals that release redelivery. Set it to a file path to choose the file.
 */
const setting = process.env.ATOMIC_DEBUG_POOLED_WATCH;
let file: string | undefined;
let role = "root";

/** Names this process in the trace and places the trace next to the pool journal. */
export function configurePooledWatchTrace(journalPath: string, processRole: string): void {
	if (setting === undefined || setting === "" || setting === "0") return;
	role = processRole;
	file = setting === "1" ? join(dirname(resolve(journalPath)), "pooled-watch-trace.jsonl") : resolve(setting);
}

/** Appends one step of the watch path when tracing is on; nothing otherwise. */
export function tracePooledWatch(
	step: string,
	detail: Record<string, string | number | boolean | undefined | null | readonly (string | number)[]>,
): void {
	if (file === undefined) return;
	try {
		appendFileSync(
			file,
			`${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, role, step, ...detail })}\n`,
		);
	} catch {
		// Tracing never changes what the pool does.
	}
}
