import { randomUUID } from "node:crypto";
import {
	type AgentTaskHost,
	type AgentWakeDispatcher,
	agentWakeDispatcher,
	type ExtensionContext,
	type TaskId,
} from "@bastani/atomic";
import type { IntercomEventBus } from "../../shared/types.js";
import { ReleasedChildError } from "./released-child-errors.js";
import {
	handleReleasedChildWakes,
	holdToolResultsInRecord,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	subagentWakeKey,
} from "./released-children.js";
import { indexSubagentChildOwner, subagentChildRecordForTarget } from "./subagent-child-card-state.js";
import { subagentChildOwner } from "./subagent-child-records.js";
import { restoreSubagentChild, type SubagentChildRestoreDeps } from "./subagent-child-restore.js";

/** Intercom → Subagents: a send or ask waits at the broker for a released child of this session (#4326). */
export const SUBAGENT_RELEASED_CHILD_WAKE_EVENT = "subagent:released-child-wake";

async function awaitTaskSettlement(host: AgentTaskHost, taskId: string): Promise<void> {
	for (;;) {
		const observed = await host.waitForTask(taskId as TaskId);
		if (!observed.ok || observed.value.kind === "settled") return;
	}
}

/**
 * Wake this owner session's released children (#4326): one dispatcher handler for all of them, and one listener for
 * the broker's notices that a send waits for one. A woken child is restored from its own session and the handler
 * waits until that run settles, so wakes for one child are taken one run at a time, in order. Returns the function
 * that stops both.
 */
export function bindReleasedChildWakes(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	events: IntercomEventBus,
	dispatcher: AgentWakeDispatcher = agentWakeDispatcher(),
): () => void {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const disposeHandler = handleReleasedChildWakes(
		ctx,
		async (record, decision) => {
			const outcome = await restoreSubagentChild(deps, ctx, record.childId, {
				prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
				toolResults: decision.toolResults,
				...(decision.prompt ? {} : { promptless: true }),
			});
			if (outcome.kind === "unrestorable")
				throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
			const host = ctx.getAgentTaskHost?.();
			if (outcome.kind === "restored" && host !== undefined) await awaitTaskSettlement(host, outcome.taskId);
		},
		holdToolResultsInRecord(deps.pi),
		dispatcher,
	);
	const unsubscribe = events.on(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, (payload) => {
		const childName = (payload as { readonly childName?: string } | null)?.childName;
		if (typeof childName !== "string") return;
		indexSubagentChildOwner(ctx);
		const record = subagentChildRecordForTarget(ownerSessionId, childName);
		if (record === undefined) return;
		void dispatcher
			.deliver(subagentWakeKey(ownerSessionId, record.childId), { id: `intercom:${randomUUID()}`, kind: "intercom" })
			.catch((error) => dispatcher.reportUnobservedFailure(error));
	});
	return () => {
		disposeHandler();
		unsubscribe();
	};
}
