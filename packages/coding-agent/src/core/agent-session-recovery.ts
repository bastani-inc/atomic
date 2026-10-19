import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	dismissProtectedStreamingCustomMessage,
	pendingProtectedStreamingCustomMessages,
	recoverProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import type { SessionRecoveryReport } from "./agent-session-types.js";
import type { SessionRecoveryReason } from "./extensions/index.js";
import { assertSessionOpen, sessionGenerationClosing, trackSessionWork } from "./session-lifecycle-work.ts";
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

export const agentSessionRecoveryMethods = {
	startPendingRecovery,
};
