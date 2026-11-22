import { holdsTurnsForDetachedResults } from "./agent-session-detached-tools.ts";
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
/** Shared per-session restore barrier so startup recovery and post-crash restore never restore children twice. */
const restores = new WeakMap<AgentSession, Promise<readonly string[]>>();
/** Sessions whose restore notices have already been written, preventing duplicate notice messages. */
const restoreNoticesPosted = new WeakSet<AgentSession>();

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

/**
 * Run only the background-restore phase (`session_recovery_restore`) after an isolated engine child replaces one that
 * crashed: restores interrupted running subagents without replaying interrupted deliveries, starting a main-chat turn,
 * or prompting the user. Shares its per-session restore barrier with {@link startPendingRecovery}.
 */
export function startPendingRecoveryRestore(
	this: AgentSession,
	reason: SessionRecoveryReason = "resume",
): Promise<SessionRecoveryReport> {
	try {
		assertSessionOpen(this);
		return trackSessionWork(this, async (): Promise<SessionRecoveryReport> => {
			const notices = await runRestorePhase(this, reason, true);
			if (notices.length > 0 && !isClosing(this) && !restoreNoticesPosted.has(this)) {
				restoreNoticesPosted.add(this);
				await this.sendCustomMessage(
					{
						customType: SESSION_RECOVERY_NOTICE_TYPE,
						content: ["Session recovery after restart:", ...notices.map((notice) => `- ${notice}`)].join("\n"),
						display: true,
						details: { reason, notices: [...notices] },
					},
					{ triggerTurn: false },
				);
			}
			return { replayed: 0, dropped: 0, completions: 0, notices: [...notices] };
		});
	} catch (error) {
		return Promise.reject(error);
	}
}

function isClosing(session: AgentSession): boolean {
	return session._disposed || sessionGenerationClosing.has(session);
}

function runRestorePhase(
	session: AgentSession,
	reason: SessionRecoveryReason,
	engineRestart: boolean,
): Promise<readonly string[]> {
	let pending = restores.get(session);
	if (pending === undefined) {
		pending = (async () => {
			await session._waitForExtensionStart();
			if (isClosing(session)) return [];
			const restored = await session.extensionRunner.emitSessionRecovery({
				type: "session_recovery_restore",
				reason,
				...(engineRestart ? { engineRestart: true as const } : {}),
			});
			return restored.notices;
		})();
		restores.set(session, pending);
	}
	return pending;
}

async function recover(session: AgentSession, reason: SessionRecoveryReason): Promise<SessionRecoveryReport> {
	await session._waitForExtensionStart();
	const report: SessionRecoveryReport = { replayed: 0, dropped: 0, completions: 0, notices: [] };
	if (isClosing(session)) return report;
	const restoredNotices = await runRestorePhase(session, reason, false);
	const includeRestoreNotices = !restoreNoticesPosted.has(session);
	if (includeRestoreNotices) report.notices.push(...restoredNotices);
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
		if (includeRestoreNotices && restoredNotices.length > 0) restoreNoticesPosted.add(session);
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
		session._taskCompletionOutbox?.adoptSavedIntents();
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
	if (!session.isStreaming && !session._isPreparingRun) {
		const startsChildRecoveryRun =
			session._subagentMessageAdmission !== undefined &&
			session._activePromptCount === 0 &&
			!session._queuedMessagesPaused &&
			!holdsTurnsForDetachedResults(session) &&
			session.agent.hasQueuedMessages();
		if (startsChildRecoveryRun) await session._runAgentContinuation(async () => {}, "recovery");
		else await session._continueQueuedAgentMessages();
	}
	return report;
}

export const agentSessionRecoveryMethods = {
	startPendingRecovery,
	startPendingRecoveryRestore,
};
