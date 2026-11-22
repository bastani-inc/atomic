/**
 * Offline custom compaction: an extension can replace the context with its own text, without a model call or provider
 * credentials. The model then sees the text in a `Context compacted` boundary message, followed by instructions for
 * recovering the rest of the conversation from session history.
 */
import type { ExtensionAPI } from "@bastani/atomic";

export default function customCompaction(atomic: ExtensionAPI): void {
	atomic.on("session_before_compact", async (event) => {
		// Keep the first line of each user request; the agent recovers everything else from history.
		const requests = event.preparation.region.lines.filter((line) => line.startsWith("[User]: "));
		if (requests.length === 0) return;
		return { compactedText: ["Requests so far:", ...requests].join("\n") };
	});

	atomic.on("session_compact", async (event) => {
		const { form, backend, stats } = event.result;
		console.log(
			`Context ${form}${backend ? ` by ${backend}` : ""}: ${stats.tokensBefore} → ${stats.tokensAfter} tokens`,
		);
	});
}
