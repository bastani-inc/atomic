import type { QueuedMessageReceipt } from "../../../core/queued-message-delivery.ts";
import type { AgentViewStatus } from "./contracts.ts";

/** Physical identity of a subagent's session, stable across engine restarts. */
export interface ChildSessionIdentity {
	readonly sessionId: string;
	readonly sessionFile?: string;
}

/** Why a pending lost-queue restore for a subagent child is no longer valid. */
export type ChildInvalidationReason = "stopped" | "cleared" | "session-ended" | "sent-elsewhere";

/** What a subagent's lost engine had taken from its queue and not been seen to save, with its receipt if it has one. */
export interface TakenSubagentMessage {
	readonly text: string;
	readonly receipt?: QueuedMessageReceipt;
}

/** What the host needs to know about a currently viewed subagent port to decide restore ownership. */
export interface ChildViewSnapshot {
	readonly agentKey: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly readOnlyReason?: string;
	readonly gone: boolean;
}

/** One-shot unsaved queued messages waiting for their exact child chat to reopen writable in the same host session. */
export interface PendingChildRestore {
	readonly key: string;
	readonly identity: ChildSessionIdentity;
	readonly agent: string;
	readonly hostSessionId: string | undefined;
	readonly messages: readonly string[];
}

/** Captured context of one lost subagent's receipt lookup. */
export interface LostChildLookupTicket {
	readonly agent: string;
	readonly taken: readonly TakenSubagentMessage[];
	readonly listed: readonly string[];
	readonly identity: ChildSessionIdentity | undefined;
	readonly hostEpoch: number;
	readonly hostSessionId: string | undefined;
	readonly invalidationKeyVersion: number;
	readonly invalidationSessionVersion: number;
}

/** Effects produced by {@link SubagentQueueRestoreMachine}. */
export type LostQueueRestoreAction =
	| { readonly kind: "unconfirmed-notice"; readonly agent: string; readonly messages: readonly string[] }
	| { readonly kind: "notice-full"; readonly agent: string; readonly messages: readonly string[] }
	| { readonly kind: "notice-pending"; readonly agent: string; readonly count: number }
	| {
			readonly kind: "restore-now";
			readonly agentKey: string;
			readonly agent: string;
			readonly messages: readonly string[];
	  }
	| {
			readonly kind: "restore-on-open";
			readonly agentKey: string;
			readonly agent: string;
			readonly messages: readonly string[];
	  };

/** Canonical map key for a child's physical `(sessionId, sessionFile)` identity. */
export function childSessionKey(identity: ChildSessionIdentity): string {
	return JSON.stringify([identity.sessionId, identity.sessionFile ?? null]);
}

/** Physical child session identity reported by a view status, or `undefined` for an engine that does not send one. */
export function statusChildIdentity(
	status: Pick<AgentViewStatus, "sessionId" | "sessionFile">,
): ChildSessionIdentity | undefined {
	if (typeof status.sessionId !== "string" || status.sessionId.length === 0) return undefined;
	return {
		sessionId: status.sessionId,
		...(typeof status.sessionFile === "string" && status.sessionFile.length > 0
			? { sessionFile: status.sessionFile }
			: {}),
	};
}

/**
 * Physical child identity eligible for child-editor restore: requires the engine to report `AgentViewStatus.sessionId`
 * (an older engine that only sent `receipts.sessionId` falls back to notice-only) and agree with `receipts`.
 */
export function canTrackChildRestore(
	status: Pick<AgentViewStatus, "sessionId" | "sessionFile" | "receipts">,
): ChildSessionIdentity | undefined {
	const identity = statusChildIdentity(status);
	if (identity === undefined) return undefined;
	const receipts = status.receipts;
	if (receipts !== undefined) {
		if (receipts.sessionId !== identity.sessionId) return undefined;
		if (
			identity.sessionFile !== undefined &&
			receipts.sessionFile !== undefined &&
			identity.sessionFile !== receipts.sessionFile
		)
			return undefined;
		const sessionFile = identity.sessionFile ?? receipts.sessionFile;
		return {
			sessionId: identity.sessionId,
			...(sessionFile === undefined ? {} : { sessionFile }),
		};
	}
	return identity;
}

/** Whether `view` is a live, non-gone view of the exact physical child `identity`. */
function viewMatchesIdentity(view: ChildViewSnapshot | undefined, identity: ChildSessionIdentity): boolean {
	if (view === undefined || view.gone) return false;
	const current = statusChildIdentity(view);
	return current !== undefined && childSessionKey(current) === childSessionKey(identity);
}

/**
 * Typed state machine for restoring a lost subagent chat's known-unsaved queued messages into that child chat's own
 * composer. Guarantees:
 * - Immediate restore into the child's composer when that exact physical child is open and writable at settlement.
 * - One-shot pending restore keyed by `(sessionId, sessionFile)` when closed at settlement, consumed once on the first
 *   writable reopen in the same host session (surviving an intervening second crash).
 * - Fallback to the full-text notice when read-only (at settlement or on reopen), when the engine is an older version
 *   without `AgentViewStatus.sessionId`, or when replacement failed.
 * - Dropped when the child is stopped, cleared, ended non-resumably, sent to by another path, or when the host session
 *   changes — including invalidations arriving while a receipt lookup is still in flight.
 * - Never writes into the main chat's editor or another child's editor.
 */
export class SubagentQueueRestoreMachine {
	private hostEpoch = 0;
	private detached = false;
	private readonly pending = new Map<string, PendingChildRestore>();
	private readonly invalidationVersions = new Map<string, number>();
	private readonly sessionInvalidationVersions = new Map<string, number>();

	beginLookup(input: {
		readonly agent: string;
		readonly taken: readonly TakenSubagentMessage[];
		readonly listed: readonly string[];
		readonly identity: ChildSessionIdentity | undefined;
		readonly hostSessionId: string | undefined;
	}): LostChildLookupTicket {
		const key = input.identity === undefined ? undefined : childSessionKey(input.identity);
		return {
			agent: input.agent,
			taken: input.taken,
			listed: input.listed,
			identity: input.identity,
			hostEpoch: this.hostEpoch,
			hostSessionId: input.hostSessionId,
			invalidationKeyVersion: key === undefined ? 0 : (this.invalidationVersions.get(key) ?? 0),
			invalidationSessionVersion:
				input.identity === undefined ? 0 : (this.sessionInvalidationVersions.get(input.identity.sessionId) ?? 0),
		};
	}

	settleLookup(
		ticket: LostChildLookupTicket,
		outcome: {
			readonly replaced: boolean;
			readonly found: { readonly saved: ReadonlySet<string>; readonly absent: ReadonlySet<string> } | undefined;
			readonly currentHostSessionId: string | undefined;
			readonly currentView: ChildViewSnapshot | undefined;
		},
	): readonly LostQueueRestoreAction[] {
		if (
			this.detached ||
			ticket.hostEpoch !== this.hostEpoch ||
			outcome.currentHostSessionId !== ticket.hostSessionId
		) {
			return [];
		}
		const classify = (message: TakenSubagentMessage): "saved" | "unsaved" | "unknown" =>
			message.receipt === undefined
				? "unknown"
				: outcome.found?.saved.has(message.receipt.id)
					? "saved"
					: outcome.found?.absent.has(message.receipt.id)
						? "unsaved"
						: "unknown";
		const unconfirmed = ticket.taken.flatMap((message) => (classify(message) === "unknown" ? [message.text] : []));
		const unsent = ticket.taken.flatMap((message) =>
			classify(message) === "unsaved" ? [message.receipt?.typed ?? message.text] : [],
		);
		const actions: LostQueueRestoreAction[] = [];
		if (unconfirmed.length > 0)
			actions.push({ kind: "unconfirmed-notice", agent: ticket.agent, messages: unconfirmed });
		const restorable = [...unsent, ...ticket.listed];
		if (restorable.length === 0) return actions;

		const identity = ticket.identity;
		const canUseEditor = outcome.replaced && identity !== undefined && !this.wasInvalidatedSince(identity, ticket);
		if (!canUseEditor) {
			actions.push({ kind: "notice-full", agent: ticket.agent, messages: restorable });
			return actions;
		}

		const key = childSessionKey(identity);
		const existing = this.pending.get(key)?.messages ?? [];
		if (viewMatchesIdentity(outcome.currentView, identity)) {
			this.pending.delete(key);
			const combined = [...existing, ...restorable];
			if (outcome.currentView?.readOnlyReason === undefined) {
				actions.push({
					kind: "restore-now",
					agentKey: outcome.currentView!.agentKey,
					agent: ticket.agent,
					messages: combined,
				});
			} else {
				actions.push({ kind: "notice-full", agent: ticket.agent, messages: combined });
			}
			return actions;
		}

		// Closed (main or another child shown): keep a one-shot pending restore keyed by (sessionId, sessionFile).
		this.pending.set(key, {
			key,
			identity,
			agent: ticket.agent,
			hostSessionId: ticket.hostSessionId,
			messages: [...existing, ...restorable],
		});
		actions.push({ kind: "notice-pending", agent: ticket.agent, count: restorable.length });
		return actions;
	}

	onChildOpened(view: ChildViewSnapshot, currentHostSessionId: string | undefined): readonly LostQueueRestoreAction[] {
		if (this.detached || view.gone) return [];
		const identity = statusChildIdentity(view);
		if (identity === undefined) return [];
		const key = childSessionKey(identity);
		const entry = this.pending.get(key);
		if (entry === undefined) return [];
		// One-shot: remove before returning so it can never be consumed twice.
		this.pending.delete(key);
		if (currentHostSessionId !== entry.hostSessionId) return [];
		if (view.readOnlyReason !== undefined) {
			return [{ kind: "notice-full", agent: entry.agent, messages: entry.messages }];
		}
		return [
			{
				kind: "restore-on-open",
				agentKey: view.agentKey,
				agent: entry.agent,
				messages: entry.messages,
			},
		];
	}

	invalidateChild(identity: ChildSessionIdentity, _reason: ChildInvalidationReason): void {
		if (this.detached) return;
		if (identity.sessionFile !== undefined) {
			const key = childSessionKey(identity);
			this.invalidationVersions.set(key, (this.invalidationVersions.get(key) ?? 0) + 1);
			this.pending.delete(key);
			return;
		}
		this.sessionInvalidationVersions.set(
			identity.sessionId,
			(this.sessionInvalidationVersions.get(identity.sessionId) ?? 0) + 1,
		);
		for (const [key, entry] of [...this.pending]) {
			if (entry.identity.sessionId === identity.sessionId) this.pending.delete(key);
		}
	}

	hostSessionChanged(): void {
		this.hostEpoch++;
		this.pending.clear();
		this.invalidationVersions.clear();
		this.sessionInvalidationVersions.clear();
	}

	hasPending(identity?: ChildSessionIdentity): boolean {
		if (identity === undefined) return this.pending.size > 0;
		return this.pending.has(childSessionKey(identity));
	}

	dispose(): void {
		this.detached = true;
		this.pending.clear();
		this.invalidationVersions.clear();
		this.sessionInvalidationVersions.clear();
	}

	private wasInvalidatedSince(identity: ChildSessionIdentity, ticket: LostChildLookupTicket): boolean {
		const key = childSessionKey(identity);
		return (
			(this.invalidationVersions.get(key) ?? 0) !== ticket.invalidationKeyVersion ||
			(this.sessionInvalidationVersions.get(identity.sessionId) ?? 0) !== ticket.invalidationSessionVersion
		);
	}
}
