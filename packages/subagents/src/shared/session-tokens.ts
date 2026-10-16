import type { SessionStore } from "@bastani/atomic";
import type { TokenUsage } from "./types.js";

export async function parseSessionTokens(store: SessionStore, sessionId: string): Promise<TokenUsage | null> {
	try {
		const snapshot = await store.load(sessionId);
		let input = 0;
		let output = 0;
		for (const entry of snapshot.entries) {
			const usage =
				entry.type === "usage"
					? entry.usage
					: entry.type === "message" && entry.message.role === "assistant"
						? entry.message.usage
						: undefined;
			if (usage === undefined) continue;
			input += usage.input;
			output += usage.output;
		}
		return { input, output, total: input + output };
	} catch {
		return null;
	}
}
