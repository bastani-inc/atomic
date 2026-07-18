import { vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { SessionManager } from "../src/core/session-manager.js";

const stats = { linesBefore: 2, linesDeleted: 1, linesKept: 1, rangeCount: 1, tokensBefore: 100, tokensAfter: 50, percentReduction: 50 };
export const compactionMocks = {
	runVerbatimCompaction: vi.fn(async (..._args: unknown[]) => ({
		text: "[User]: retained test context\n(filtered 1 lines)", ranges: [{ start: 2, end: 2 }], stats, rung: "planned" as const,
	})),
};

/** Per-session injection avoids process-global module mocks under Bun. */
export function installCompactionMock(session: AgentSession, manager: SessionManager): void {
	(session as unknown as { _applyVerbatimCompaction: (options: { reason: string }) => Promise<object | undefined> })._applyVerbatimCompaction = async (options) => {
		const planned = await compactionMocks.runVerbatimCompaction(undefined, session.model, undefined, undefined, undefined, session.thinkingLevel, { streamFn: session.agent.streamFn });
		const leaf = manager.getLeafId();
		if (!leaf) return undefined;
		manager.appendCompaction(planned.text, leaf, stats.tokensBefore, {
			strategy: "verbatim-lines", promptVersion: 4, format: "full-collapse",
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" }, stats, rung: "planned",
		});
		session.agent.state.messages = manager.buildSessionContext().messages;
		return {
			compactedText: planned.text, firstKeptEntryId: leaf, tokensBefore: stats.tokensBefore, stats,
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" }, promptVersion: 4,
			format: "full-collapse", rung: "planned", reason: options.reason,
		};
	};
}

export async function advanceTimers(milliseconds: number): Promise<void> {
	vi.advanceTimersByTime(milliseconds);
	for (let index = 0; index < 5; index++) await Promise.resolve();
}
