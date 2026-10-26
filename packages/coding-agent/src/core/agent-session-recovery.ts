import type { AssistantMessage, ToolCall, ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	dismissProtectedStreamingCustomMessage,
	pendingProtectedStreamingCustomMessages,
	recoverProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import type { SessionRecoveryReport } from "./agent-session-types.js";
import type { SessionRecoveryReason } from "./extensions/index.js";
import {
	assertSessionOpen,
	sessionGenerationClosing,
	sessionLifetime,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { pendingTaskCompletionIntents } from "./tasks/completion.js";

export const SESSION_RECOVERY_NOTICE_TYPE = "session-recovery-notice";
export const SESSION_RECOVERY_REPLAY_TYPE = "session-recovery-replay";

const recoveries = new WeakMap<AgentSession, Promise<SessionRecoveryReport>>();

/**
 * Recover work an earlier process left unfinished. Binding never does this, so a host
 * calls it once the transcript is visible; every turn it starts streams like any other.
 */
export function startPendingRecovery(
	this: AgentSession,
	reason: SessionRecoveryReason = "resume",
): Promise<SessionRecoveryReport> {
	let recovery = recoveries.get(this);
	if (recovery === undefined) {
		try {
			assertSessionOpen(this);
			recovery = trackSessionWork(this, () => recover(this, reason));
		} catch (error) {
			recovery = Promise.reject(error);
		}
		recoveries.set(this, recovery);
	}
	return recovery;
}

function isClosing(session: AgentSession): boolean {
	return session._disposed || sessionGenerationClosing.has(session);
}

async function recover(session: AgentSession, reason: SessionRecoveryReason): Promise<SessionRecoveryReport> {
	await session._waitForExtensionStart();
	const report: SessionRecoveryReport = { replayed: 0, dropped: 0, completions: 0, notices: [] };
	if (isClosing(session)) return report;
	const restored = await session.extensionRunner.emitSessionRecovery({ type: "session_recovery_restore", reason });
	report.notices.push(...restored.notices);
	if (isClosing(session)) return report;
	if (reason === "workflow_stage_resume") await askInterruptedQuestions(session);
	if (isClosing(session)) return report;

	const pending = pendingProtectedStreamingCustomMessages(session);
	let replay = pending;
	if (pending.length > 0) {
		const decided = await session.extensionRunner.emitSessionRecovery({
			type: "session_recovery_replay",
			reason,
			pending,
		});
		report.notices.push(...decided.notices);
		if (isClosing(session)) return report;
		// Deferred cards stay pending without a turn, so the next recovery decides about them again.
		replay = pending.filter((entry) => !decided.dropped.has(entry.entryId) && !decided.deferred.has(entry.entryId));
		for (const entry of pending.filter((candidate) => decided.dropped.has(candidate.entryId))) {
			await dismissProtectedStreamingCustomMessage(session, entry);
			report.dropped += 1;
		}
	}

	if (report.notices.length > 0) {
		await session.sendCustomMessage(
			{
				customType: SESSION_RECOVERY_NOTICE_TYPE,
				content: ["Session recovery after restart:", ...report.notices.map((notice) => `- ${notice}`)].join("\n"),
				display: true,
				details: { reason, notices: report.notices },
			},
			{ triggerTurn: false },
		);
	}

	if (!isClosing(session) && pendingTaskCompletionIntents(session.sessionManager).length > 0) {
		session.getAgentTaskHost();
		report.completions = (await session._taskCompletionOutbox?.flushRestored()) ?? 0;
	}

	if (replay.length === 0 || isClosing(session)) return report;
	await session.sendCustomMessage(
		{
			customType: SESSION_RECOVERY_REPLAY_TYPE,
			content: `Replaying ${replay.length === 1 ? "1 interrupted delivery" : `${replay.length} interrupted deliveries`} from before the restart.`,
			display: true,
			details: { reason, entryIds: replay.map((entry) => entry.entryId) },
		},
		{ triggerTurn: false, excludeFromContext: true },
	);
	report.replayed = recoverProtectedStreamingCustomMessages(session, replay);
	if (!session.isStreaming && !session._isPreparingRun) await session._continueQueuedAgentMessages();
	return report;
}

/** Tools whose interrupted calls recovery runs again: asking the user the same question has no side effects. */
const REISSUED_ON_RECOVERY = new Set(["ask_user_question"]);

/**
 * Ask again the questions a stage's earlier process died waiting on (#3996). A workflow stage
 * resumed on a replacement worker would otherwise see its pending `ask_user_question` call as
 * interrupted, and the model may go on without the user's answer. The call runs again with
 * its id and arguments, and its result is recorded as that call's result, so the form shows
 * again and the stage receives exactly the answer the user gives.
 */
async function askInterruptedQuestions(session: AgentSession): Promise<void> {
	const messages = session.sessionManager.buildSessionProjection().messages;
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "assistant") index--;
	const assistant = messages[index] as AssistantMessage | undefined;
	if (assistant?.stopReason !== "toolUse") return;
	const later = messages.slice(index + 1);
	// A later turn already moved past the call; only a session that ended on it is waiting.
	if (later.some((message) => message.role === "user" || message.role === "assistant")) return;
	const answered = new Set(
		later.flatMap((message) => (message.role === "toolResult" ? [(message as ToolResultMessage).toolCallId] : [])),
	);
	const calls = assistant.content.filter(
		(block): block is ToolCall =>
			block.type === "toolCall" && REISSUED_ON_RECOVERY.has(block.name) && !answered.has(block.id),
	);
	if (calls.length === 0) return;
	// The calls are pending again, not interrupted: the transcript a chat shows while the user
	// answers must not report them as interrupted (#4022).
	for (const call of calls) session._reissuedToolCallIds.add(call.id);
	session._refreshFinalizedContext();
	try {
		for (const call of calls) {
			const tool = session._toolRegistry.get(call.name);
			if (tool === undefined || isClosing(session)) return;
			// Through the session's event pipeline, as the agent loop runs a tool: hosts see the call
			// start and end, and the result is persisted as that call's result.
			session._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: call.name,
				args: call.arguments,
			});
			let result: AgentToolResult;
			let isError = false;
			try {
				result = await tool.execute(call.id, call.arguments, sessionLifetime(session));
			} catch (error) {
				if (isClosing(session)) return;
				result = {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: undefined,
				};
				isError = true;
			}
			if (isClosing(session)) return;
			session._handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: call.name,
				result,
				isError,
			});
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: result.content,
				details: result.details,
				isError,
				timestamp: Date.now(),
			};
			session._handleAgentEvent({ type: "message_start", message });
			session._handleAgentEvent({ type: "message_end", message });
			await session._agentEventQueue;
		}
	} finally {
		for (const call of calls) session._reissuedToolCallIds.delete(call.id);
		if (!isClosing(session)) session._refreshFinalizedContext();
	}
}

export const agentSessionRecoveryMethods = {
	startPendingRecovery,
};
