import type { ExtensionContext } from "@bastani/atomic";
import type { EndedChildWakeRequest } from "../../../../intercom/session-recovery.js";
import type { IntercomEventBus } from "../../shared/types.js";
import { indexSubagentChildOwner, subagentChildIdForTarget } from "./subagent-child-card-state.js";
import { subagentChildOwner } from "./subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "./subagent-child-restore.js";
import { wakeSubagentChildForMessage } from "./subagent-run-control.js";

/**
 * Intercom → Subagents (#5999): a message waits at the broker for a child this session launched and reported ended with
 * `wake`; resume it, and answer. Payload: `EndedChildWakeRequest` (`@bastani/intercom` `session-recovery.ts`).
 */
export const SUBAGENT_ENDED_CHILD_WAKE_EVENT = "subagent:ended-child-wake";

function isEndedChildWakeRequest(value: unknown): value is EndedChildWakeRequest {
	const request = value as Partial<EndedChildWakeRequest> | null | undefined;
	return (
		typeof request?.childName === "string" &&
		typeof request.answer === "function" &&
		typeof request.from === "object" &&
		request.from !== null &&
		typeof request.from.id === "string"
	);
}

/**
 * #5999: resume this owner session's ended children for the Intercom messages the broker queues for them. The child is
 * resumed as `subagent({ action: "resume" })` resumes it, by this session, which keeps it: its result, notices and
 * pause or quit stay here, and it keeps its own model, tools and agent. Its prompt names the session whose message woke
 * it. Returns the function that stops listening.
 */
export function bindEndedChildWakes(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	events: IntercomEventBus,
): () => void {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	return events.on(SUBAGENT_ENDED_CHILD_WAKE_EVENT, (payload) => {
		if (!isEndedChildWakeRequest(payload) || payload.handled === true) return;
		const request = payload;
		request.handled = true;
		let childId: string | undefined;
		try {
			indexSubagentChildOwner(ctx);
			childId = subagentChildIdForTarget(ownerSessionId, request.childName);
		} catch (error) {
			request.answer(false, `the session that launched it could not read its record: ${(error as Error).message}`);
			return;
		}
		if (childId === undefined) {
			request.answer(false, "the session that launched it no longer keeps it");
			return;
		}
		const waker = request.from.name?.trim() || request.from.id;
		void wakeSubagentChildForMessage(deps, ctx, childId, waker, request.answer);
	});
}
