/**
 * Offline custom compaction: extensions may replace the prepared region string
 * before Atomic resolves model credentials. The runtime keeps the boundary and
 * persists this text verbatim.
 */
import type { ExtensionAPI } from "@bastani/atomic";

export default function customCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event) => {
		const lines = event.preparation.region.lines;
		if (lines.length === 0) return;
		const kept = lines.filter((line, index) => index === 0 || /^\[(User|Assistant|Assistant thinking|Assistant tool calls|Tool result)\]: /.test(line));
		if (kept.length === lines.length) return;
		return { compactedText: kept.join("\n") };
	});

	pi.on("session_compact", async (event) => {
		console.log(`Compacted ${event.result.stats.linesBefore} to ${event.result.stats.linesKept} lines (${event.result.rung})`);
	});
}
