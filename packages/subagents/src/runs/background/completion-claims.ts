import type { FrozenCompletionEnvelope } from "./result-file-claims.js";

type CompletionClaimStatus = "delivered" | "retry" | "exhausted" | "conflict" | "released";
type TerminalStatus = Extract<CompletionClaimStatus, "delivered" | "exhausted">;

interface CompletionAttempt {
	status: CompletionClaimStatus;
	noProgressFailures: number;
}

interface CompletionFlight {
	promise: Promise<CompletionAttempt>;
}

export interface CompletionClaimSnapshot {
	intercomDelivered: boolean;
	localDelivered: boolean;
	noProgressFailures: number;
	terminalStatus?: TerminalStatus;
	envelope: FrozenCompletionEnvelope;
}

interface CompletionClaim extends CompletionClaimSnapshot {
	signature: string;
	inFlight?: CompletionFlight;
	completedAt?: number;
	lastTouchedAt: number;
}

export interface CompletionClaimResult extends CompletionAttempt {
	owner: boolean;
}

export interface CompletionDeliveryPhases {
	intercom?: (envelope: FrozenCompletionEnvelope) => Promise<boolean> | boolean;
	local?: (envelope: FrozenCompletionEnvelope) => Promise<boolean> | boolean;
	isOwned?: () => boolean;
	onState?: (snapshot: CompletionClaimSnapshot) => void;
}

export interface CompletionClaimInitial {
	intercomDelivered?: boolean;
	localDelivered?: boolean;
	noProgressFailures?: number;
	terminalStatus?: TerminalStatus;
	envelope?: FrozenCompletionEnvelope;
}

const STORE_KEY = "__atomicSubagentCompletionClaims";
const DEFAULT_MAX_NO_PROGRESS_FAILURES = 8;
const MAX_CLAIMS = 2048;

function cloneEnvelope(envelope: FrozenCompletionEnvelope): FrozenCompletionEnvelope {
	return JSON.parse(JSON.stringify(envelope)) as FrozenCompletionEnvelope;
}

function claims(): Map<string, CompletionClaim> {
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[STORE_KEY];
	if (existing instanceof Map) return existing as Map<string, CompletionClaim>;
	const created = new Map<string, CompletionClaim>();
	globalStore[STORE_KEY] = created;
	return created;
}

function prune(store: Map<string, CompletionClaim>, now: number, ttlMs: number): void {
	for (const [key, claim] of store) {
		if (claim.completedAt !== undefined && now - claim.completedAt > ttlMs) store.delete(key);
	}
	if (store.size <= MAX_CLAIMS) return;
	const disposable = [...store.entries()]
		.filter(([, claim]) => !claim.inFlight && !claim.intercomDelivered && !claim.localDelivered)
		.sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
	for (const [key] of disposable) {
		if (store.size <= MAX_CLAIMS) break;
		store.delete(key);
	}
}

function snapshot(claim: CompletionClaim): CompletionClaimSnapshot {
	return {
		intercomDelivered: claim.intercomDelivered,
		localDelivered: claim.localDelivered,
		noProgressFailures: claim.noProgressFailures,
		terminalStatus: claim.terminalStatus,
		envelope: cloneEnvelope(claim.envelope),
	};
}

function persist(claim: CompletionClaim, callback: CompletionDeliveryPhases["onState"]): void {
	claim.lastTouchedAt = Date.now();
	callback?.(snapshot(claim));
}

/** Atomically owns and advances one completion across aliases and watcher replacements. */
export async function deliverClaimedCompletion(
	key: string,
	signature: string,
	ttlMs: number,
	phases: CompletionDeliveryPhases,
	maxNoProgressFailures = DEFAULT_MAX_NO_PROGRESS_FAILURES,
	initial: CompletionClaimInitial = {},
	envelope: FrozenCompletionEnvelope = { local: {} },
): Promise<CompletionClaimResult> {
	const store = claims();
	const now = Date.now();
	prune(store, now, ttlMs);
	let claim = store.get(key);
	if (!claim) {
		claim = {
			signature,
			envelope: cloneEnvelope(initial.envelope ?? envelope),
			intercomDelivered: initial.intercomDelivered === true,
			localDelivered: initial.localDelivered === true,
			noProgressFailures: initial.noProgressFailures ?? 0,
			terminalStatus: initial.terminalStatus,
			completedAt: initial.terminalStatus ? now : undefined,
			lastTouchedAt: now,
		};
		store.set(key, claim);
		persist(claim, phases.onState);
	} else if (claim.signature !== signature) {
		return { owner: false, status: "conflict", noProgressFailures: claim.noProgressFailures };
	}
	claim.lastTouchedAt = now;
	if (claim.terminalStatus) return { owner: false, status: claim.terminalStatus, noProgressFailures: claim.noProgressFailures };
	if (claim.inFlight) return { owner: false, ...await claim.inFlight.promise };

	const ownedClaim = claim;
	const hasVisibleProgress = () => ownedClaim.intercomDelivered || ownedClaim.localDelivered;
	const retireForOwnershipLoss = (): CompletionAttempt => {
		if (!hasVisibleProgress()) {
			store.delete(key);
			return { status: "released", noProgressFailures: ownedClaim.noProgressFailures };
		}
		persist(ownedClaim, phases.onState);
		return { status: "released", noProgressFailures: ownedClaim.noProgressFailures };
	};
	const attempt = (async (): Promise<CompletionAttempt> => {
		let progressed = false;
		const failed = (): CompletionAttempt => {
			if (phases.isOwned && !phases.isOwned()) return retireForOwnershipLoss();
			ownedClaim.noProgressFailures = progressed ? 0 : ownedClaim.noProgressFailures + 1;
			if (ownedClaim.noProgressFailures >= Math.max(1, maxNoProgressFailures)) {
				ownedClaim.terminalStatus = "exhausted";
				ownedClaim.completedAt = Date.now();
				persist(ownedClaim, phases.onState);
				return { status: "exhausted", noProgressFailures: ownedClaim.noProgressFailures };
			}
			persist(ownedClaim, phases.onState);
			return { status: "retry", noProgressFailures: ownedClaim.noProgressFailures };
		};
		const runPhase = async (phase: ((value: FrozenCompletionEnvelope) => Promise<boolean> | boolean) | undefined): Promise<boolean | undefined> => {
			if (!phase) return undefined;
			if (phases.isOwned && !phases.isOwned()) return false;
			try { return await phase(cloneEnvelope(ownedClaim.envelope)); } catch { return false; }
		};
		if (!ownedClaim.intercomDelivered && phases.intercom) {
			const delivered = await runPhase(phases.intercom);
			if (!delivered) return failed();
			ownedClaim.intercomDelivered = true;
			progressed = true;
			persist(ownedClaim, phases.onState);
			if (phases.isOwned && !phases.isOwned()) return retireForOwnershipLoss();
		}
		if (!ownedClaim.localDelivered && phases.local) {
			const delivered = await runPhase(phases.local);
			if (!delivered) return failed();
			ownedClaim.localDelivered = true;
			progressed = true;
			persist(ownedClaim, phases.onState);
			if (phases.isOwned && !phases.isOwned()) return retireForOwnershipLoss();
		}
		ownedClaim.noProgressFailures = 0;
		ownedClaim.terminalStatus = "delivered";
		ownedClaim.completedAt = Date.now();
		persist(ownedClaim, phases.onState);
		return { status: "delivered", noProgressFailures: 0 };
	})();
	const flight: CompletionFlight = { promise: attempt };
	ownedClaim.inFlight = flight;
	try {
		return { owner: true, ...await flight.promise };
	} finally {
		// The explicit flight handle is the ownership token; comparing resolved
		// values would let an older attempt clear a newer in-flight claim.
		if (ownedClaim.inFlight === flight) ownedClaim.inFlight = undefined;
	}
}
