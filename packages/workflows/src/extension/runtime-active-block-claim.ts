import type { DurableWorkflowBackend } from "../durable/backend.js";
import { appendRunEnd } from "../shared/persistence-session-entries.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowPersistencePort } from "../shared/types.js";

export interface ActiveBlockedResumeClaim {
	readonly sourceId: string;
	readonly store: Store;
	killedByClaim: boolean;
	mismatchSettled: boolean;
	terminalEndAttempted: boolean;
}

/** Store-scoped active-block resumes prevent duplicate same-session dispatch. */
const inFlightActiveBlockResumes = new WeakMap<Store, Map<string, ActiveBlockedResumeClaim>>();

/**
 * Claim the right to resume an active recoverable block in this session. The
 * durable source is intentionally NOT mutated: it stays `blocked`/resumable so
 * it remains discoverable if the process dies before continuation settlement.
 */
export function claimActiveBlockedResume(store: Store, sourceId: string): ActiveBlockedResumeClaim | undefined {
	let claims = inFlightActiveBlockResumes.get(store);
	if (claims?.has(sourceId)) return undefined;
	if (claims === undefined) {
		claims = new Map();
		inFlightActiveBlockResumes.set(store, claims);
	}
	const claim: ActiveBlockedResumeClaim = {
		sourceId,
		store,
		killedByClaim: false,
		mismatchSettled: false,
		terminalEndAttempted: false,
	};
	claims.set(sourceId, claim);
	return claim;
}

/** Release an in-flight claim (dispatch failed, or the source was finalized). */
export function releaseActiveBlockedClaim(claim: ActiveBlockedResumeClaim): void {
	const claims = inFlightActiveBlockResumes.get(claim.store);
	if (claims?.get(claim.sourceId) !== claim) return;
	claims.delete(claim.sourceId);
	if (claims.size === 0) inFlightActiveBlockResumes.delete(claim.store);
}

/** Remove a continuation that settled before startup admission completed. */
export async function discardFailedActiveBlockedContinuation(
	backend: DurableWorkflowBackend,
	runId: string,
	store: Store,
): Promise<void> {
	store.removeRun(runId);
	const handle = backend.getWorkflow(runId);
	if (handle?.status === "running") {
		backend.setWorkflowStatus(runId, "failed", handle.pendingPrompts, false);
		await backend.flush();
	}
	const deleted = await backend.deleteWorkflowIfInactive(runId);
	if (!deleted.ok && deleted.reason !== "not_found") {
		throw new Error(`continuation ${runId} remained ${deleted.reason}`);
	}
}

function terminalSourceMetadata(source: RunSnapshot) {
	return {
		...(source.failureKind !== undefined ? { failureKind: source.failureKind } : {}),
		...(source.failureCode !== undefined ? { failureCode: source.failureCode } : {}),
		failureRecoverability: "non_recoverable" as const,
		failureDisposition: "terminal_killed" as const,
		...(source.failureMessage !== undefined ? { failureMessage: source.failureMessage } : {}),
		...(source.failedStageId !== undefined ? { failedStageId: source.failedStageId } : {}),
		resumable: false,
		...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
	};
}

/** Mark the source killed locally so this session has only one active run. */
export function finalizeResumedActiveBlockedSourceRun(
	claim: ActiveBlockedResumeClaim,
	source: RunSnapshot,
	continuationRunId: string,
): void {
	if (claim.mismatchSettled || claim.killedByClaim) return;
	const error = source.error ?? source.failureMessage ?? `workflow resumed in new run ${continuationRunId}`;
	claim.killedByClaim = claim.store.recordRunEnd(
		source.id,
		"killed",
		undefined,
		error,
		terminalSourceMetadata(source),
	);
}

function canRestoreActiveBlockedSource(live: RunSnapshot | undefined, claim: ActiveBlockedResumeClaim): boolean {
	if (live === undefined) return true;
	if (live.status === "killed" && live.failureDisposition === "terminal_killed") {
		return claim.killedByClaim && !claim.terminalEndAttempted;
	}
	if (live.endedAt === undefined && live.resumable === true && live.failureDisposition === "active_blocked") {
		return true;
	}
	return !isTerminalRunStatus(live.status);
}

function restoreActiveBlockedSource(source: RunSnapshot, claim: ActiveBlockedResumeClaim): void {
	const live = claim.store.runs().find((candidate) => candidate.id === source.id);
	if (!canRestoreActiveBlockedSource(live, claim)) return;
	claim.store.restoreActiveBlockedRun(source, source.error ?? source.failureMessage ?? "workflow is blocked", {
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		resumable: true,
		...(source.failureKind !== undefined ? { failureKind: source.failureKind } : {}),
		...(source.failureCode !== undefined ? { failureCode: source.failureCode } : {}),
		...(source.failureMessage !== undefined ? { failureMessage: source.failureMessage } : {}),
		...(source.failedStageId !== undefined ? { failedStageId: source.failedStageId } : {}),
		...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
		...(source.blockedAt !== undefined ? { blockedAt: source.blockedAt } : {}),
		...(source.result !== undefined ? { result: source.result } : {}),
		...(source.budgetState !== undefined ? { budgetState: source.budgetState } : {}),
	});
}

export function isReplayTopologyMismatchFailure(
	result: { readonly error?: string } | undefined,
	error: unknown,
): boolean {
	const message =
		result?.error ?? (error instanceof Error ? error.message : error === undefined ? undefined : String(error));
	return (
		typeof message === "string" &&
		(message.includes("insufficient_state: replay topology mismatch") ||
			message.includes("insufficient_state: replay topology ambiguous"))
	);
}

/**
 * A fail-closed replay topology failure puts the reserved snapshot back so the
 * same session can retry. If restore wins the race with the local kill, the
 * kill is skipped. Other settlements leave the local kill in place. Errors stay
 * inside this callback.
 */
export function finalizeActiveBlockedSourceAfterContinuation(input: {
	readonly claim: ActiveBlockedResumeClaim;
	readonly source: RunSnapshot;
	readonly continuationRunId: string;
	readonly persistence?: WorkflowPersistencePort;
	readonly result?: { readonly error?: string };
	readonly error?: unknown;
}): void {
	try {
		if (isReplayTopologyMismatchFailure(input.result, input.error)) {
			if (input.claim.mismatchSettled || input.claim.terminalEndAttempted) return;
			input.claim.mismatchSettled = true;
			restoreActiveBlockedSource(input.source, input.claim);
			return;
		}
		if (input.claim.mismatchSettled || input.claim.terminalEndAttempted) return;
		input.claim.terminalEndAttempted = true;
		if (input.persistence) {
			const error =
				input.source.error ??
				input.source.failureMessage ??
				`workflow resumed in new run ${input.continuationRunId}`;
			appendRunEnd(input.persistence, {
				runId: input.source.id,
				status: "killed",
				error,
				...terminalSourceMetadata(input.source),
				ts: Date.now(),
			});
		}
	} catch {
		// Claim release is required even when restore or persistence fails.
	} finally {
		releaseActiveBlockedClaim(input.claim);
	}
}
