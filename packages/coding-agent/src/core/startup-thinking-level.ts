import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { SessionContext, SessionManager } from "./session-manager.ts";

export function savedConversationThinkingLevel(
	sessionManager: Pick<SessionManager, "getBranch">,
	context: Pick<SessionContext, "messages" | "thinkingLevel">,
): ThinkingLevel | undefined {
	return context.messages.length > 0 &&
		sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")
		? (context.thinkingLevel as ThinkingLevel)
		: undefined;
}

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
