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

interface SessionRestorePhases {
	restart?: Promise<readonly string[]>;
	full?: Promise<readonly string[]>;
	readonly postedNotices: Set<string>;
}

const recoveries = new WeakMap<AgentSession, Promise<SessionRecoveryReport>>();
/** Per-session restore barriers keyed by phase kind (`restart` vs `full`) plus atomic notice deduplication. */
const restorePhases = new WeakMap<AgentSession, SessionRestorePhases>();

function phasesOf(session: AgentSession): SessionRestorePhases {
	let phases = restorePhases.get(session);
	if (phases === undefined) {
		phases = { postedNotices: new Set() };
		restorePhases.set(session, phases);
	}
	return phases;
}

/** Atomically claim notices not yet claimed for posting on this session. */
function claimUnpostedNotices(phases: SessionRestorePhases, notices: readonly string[]): string[] {
	const claimed: string[] = [];
	for (const notice of notices) {
		if (phases.postedNotices.has(notice)) continue;
		phases.postedNotices.add(notice);
		claimed.push(notice);
	}
	return claimed;
}

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
 * or prompting the user. Reuses an in-flight or completed full restore when present, while keeping its own phase key
 * so a later {@link startPendingRecovery} still runs extensions (such as Intercom) that skip `engineRestart: true`.
 */
export function startPendingRecoveryRestore(
	this: AgentSession,
	reason: SessionRecoveryReason = "resume",
): Promise<SessionRecoveryReport> {
	try {
		assertSessionOpen(this);
		return trackSessionWork(this, async (): Promise<SessionRecoveryReport> => {
			const phases = phasesOf(this);
			// Full recovery is a strict superset and owns posting its own notices.
			if (phases.full !== undefined) {
				await phases.full;
				return { replayed: 0, dropped: 0, completions: 0, notices: [] };
			}
			const notices = await runRestartRestorePhase(this, phases, reason);
			if (isClosing(this)) return { replayed: 0, dropped: 0, completions: 0, notices: [] };
			const toPost = claimUnpostedNotices(phases, notices);
			if (toPost.length > 0) {
				await this.sendCustomMessage(
					{
						customType: SESSION_RECOVERY_NOTICE_TYPE,
						content: ["Session recovery after restart:", ...toPost.map((notice) => `- ${notice}`)].join("\n"),
						display: true,
						details: { reason, notices: [...toPost] },
					},
					{ triggerTurn: false },
				);
			}
			return { replayed: 0, dropped: 0, completions: 0, notices: toPost };
		});
	} catch (error) {
		return Promise.reject(error);
	}
}

function isClosing(session: AgentSession): boolean {
	return session._disposed || sessionGenerationClosing.has(session);
}

function runRestartRestorePhase(
	session: AgentSession,
	phases: SessionRestorePhases,
	reason: SessionRecoveryReason,
): Promise<readonly string[]> {
	if (phases.restart === undefined) {
		phases.restart = (async () => {
			await session._waitForExtensionStart();
			if (isClosing(session)) return [];
			const restored = await session.extensionRunner.emitSessionRecovery({
				type: "session_recovery_restore",
				reason,
				engineRestart: true,
			});
			return restored.notices;
		})();
	}
	return phases.restart;
}

function runFullRestorePhase(
	session: AgentSession,
	phases: SessionRestorePhases,
	reason: SessionRecoveryReason,
): Promise<readonly string[]> {
	if (phases.full === undefined) {
		phases.full = (async () => {
			await session._waitForExtensionStart();
			// Serialize behind any in-flight restart-only restore so extensions that restore once per session
			// finish before full recovery runs extensions (such as Intercom) that skipped `engineRestart: true`.
			if (phases.restart !== undefined) await phases.restart.catch(() => undefined);
			if (isClosing(session)) return [];
			const restored = await session.extensionRunner.emitSessionRecovery({
				type: "session_recovery_restore",
				reason,
			});
			return restored.notices;
		})();
	}
	return phases.full;
}

async function recover(session: AgentSession, reason: SessionRecoveryReason): Promise<SessionRecoveryReport> {
	await session._waitForExtensionStart();
	const report: SessionRecoveryReport = { replayed: 0, dropped: 0, completions: 0, notices: [] };
	if (isClosing(session)) return report;
	const phases = phasesOf(session);
	const restoredNotices = await runFullRestorePhase(session, phases, reason);
	if (isClosing(session)) return report;
	// Claim unposted restore notices atomically before awaiting replay so no concurrent caller can duplicate them,
	// while preserving distinct notices from this full pass (e.g. Intercom) and from session_recovery_replay.
	report.notices.push(...claimUnpostedNotices(phases, restoredNotices));
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
