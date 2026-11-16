import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { SessionManager } from "./session-manager.ts";

/**
 * The thinking level a continued conversation saved. Read it before the session is created, because creation records
 * a level of its own for a conversation that has none.
 */
export function savedConversationThinkingLevel(
	sessionManager: Pick<SessionManager, "buildSessionContext" | "getBranch">,
): ThinkingLevel | undefined {
	const context = sessionManager.buildSessionContext();
	return context.messages.length > 0 &&
		sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")
		? (context.thinkingLevel as ThinkingLevel)
		: undefined;
}

/**
 * Saves the thinking level that session creation saves, once a startup that loaded extensions late has selected its
 * model: a continued conversation's saved level stays its latest entry, and any other session saves its startup level.
 */
export async function recordStartupThinkingLevel(
	sessionManager: Pick<SessionManager, "getBranch" | "appendThinkingLevelChange">,
	savedThinkingLevel: ThinkingLevel | undefined,
	startupThinkingLevel: ThinkingLevel,
): Promise<void> {
	const recorded = savedThinkingLevel ?? startupThinkingLevel;
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "thinking_level_change") continue;
		if (entry.thinkingLevel === recorded) return;
		break;
	}
	await sessionManager.appendThinkingLevelChange(recorded);
}
