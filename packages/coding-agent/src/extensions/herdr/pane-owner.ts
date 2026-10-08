import { isAbsolute } from "node:path";
import type { SessionActivity } from "./activity.js";
import type { HerdrEnvironment } from "./environment.js";
import { executeHerdr, type HerdrDiagnostic } from "./transport.js";

export interface PaneIdentity {
	id: string;
	path?: string;
	resume?: string[];
}
export interface PaneReportingOptions {
	clock?: () => number;
	timeoutMs?: number;
	diagnostic?: (diagnostic: HerdrDiagnostic) => void;
}
export interface PaneOwner {
	environment: HerdrEnvironment;
	identity: PaneIdentity;
	options: PaneReportingOptions;
	status: "active" | "releasing" | "retired";
	seq: number;
	identitySent: boolean;
	resumeUnsupported: boolean;
	lastDeliveredActivity?: SessionActivity;
	pending?: { activity: SessionActivity; skipUnchanged: boolean };
	flight?: Promise<void>;
	release?: Promise<void>;
	flush(): Promise<void>;
}

// Host module lifetime outlives inline extension factories and runner generations.
const owners = new Map<string, PaneOwner>();
let highWater = 0;

const MAX_RESUME_ARGS = 64;
const MAX_RESUME_BYTES = 8 * 1024;

function diagnostic(owner: PaneOwner, value: HerdrDiagnostic): void {
	owner.options.diagnostic?.(value);
}

/** Every admitted command, including release, takes a fresh strictly increasing sequence: Herdr ignores equal or older `--seq`. */
function allocateSequence(owner: Pick<PaneOwner, "options" | "seq">): void {
	owner.seq = highWater = Math.max((owner.options.clock ?? Date.now)(), highWater + 1);
}

function argv(owner: Pick<PaneOwner, "environment" | "seq">, command: string): string[] {
	return [
		"pane",
		command,
		owner.environment.paneId,
		"--source",
		"custom:atomic",
		"--agent",
		"atomic",
		"--seq",
		String(owner.seq),
	];
}

/** Herdr drops the whole report for a resume argv it cannot accept, so only offer one it will. */
function acceptedResume(resume: string[] | undefined): string[] | undefined {
	if (!resume?.[0] || resume.length > MAX_RESUME_ARGS || /[\\/]/.test(resume[0])) return undefined;
	let bytes = 0;
	for (const word of resume) {
		if (/['\u0000-\u001f\u007f-\u009f]/.test(word)) return undefined;
		bytes += Buffer.byteLength(word) + 1;
	}
	return bytes > MAX_RESUME_BYTES ? undefined : resume;
}

function reportArgv(owner: PaneOwner, activity: SessionActivity, resume?: string[]): string[] {
	const args = [...argv(owner, "report-agent"), "--state", activity.state];
	if (activity.message) args.push("--message", activity.message);
	if (!owner.identitySent) {
		args.push("--agent-session-id", owner.identity.id);
		if (owner.identity.path && isAbsolute(owner.identity.path))
			args.push("--agent-session-path", owner.identity.path);
	}
	if (resume) args.push("--", ...resume);
	return args;
}

async function send(owner: PaneOwner, args: string[]): Promise<boolean> {
	const result = await executeHerdr(owner.environment, args, owner.options.timeoutMs);
	if (result) diagnostic(owner, result);
	return result === undefined;
}

export async function claimPaneReporting(
	environment: HerdrEnvironment,
	identity: PaneIdentity,
	options: PaneReportingOptions = {},
): Promise<PaneOwner> {
	let previous: PaneOwner | undefined;
	do {
		previous = owners.get(environment.paneId);
		if (previous) await retirePaneReporting(previous);
	} while (owners.get(environment.paneId) !== previous);
	const owner: PaneOwner = {
		environment,
		identity,
		options,
		status: "active",
		// Inherit the registration even if recovery produces no successor report before quit.
		seq: previous?.seq ?? 0,
		identitySent: false,
		// The same Herdr serves every session in a pane, so a rejection stays true for the successor.
		resumeUnsupported: previous?.resumeUnsupported ?? false,
		async flush() {
			await this.flight;
		},
	};
	owners.set(environment.paneId, owner);
	return owner;
}

function matchesActivity(previous: SessionActivity | undefined, activity: SessionActivity): boolean {
	return (
		activity.state === previous?.state &&
		activity.reason === previous?.reason &&
		activity.message === previous?.message
	);
}

export function reportPaneActivity(owner: PaneOwner, activity: SessionActivity, skipUnchanged = false): void {
	if (owner.status !== "active" || owners.get(owner.environment.paneId) !== owner) {
		diagnostic(owner, { kind: "stale_owner" });
		return;
	}
	if (!owner.flight && skipUnchanged && matchesActivity(owner.lastDeliveredActivity, activity)) return;
	const pendingExplicitRefresh =
		owner.pending?.skipUnchanged === false && matchesActivity(owner.pending.activity, activity);
	owner.pending = { activity, skipUnchanged: skipUnchanged && !pendingExplicitRefresh };
	if (owner.flight) return;
	owner.flight = (async () => {
		while (owner.pending && owner.status === "active") {
			const { activity: next, skipUnchanged } = owner.pending;
			owner.pending = undefined;
			if (skipUnchanged && matchesActivity(owner.lastDeliveredActivity, next)) continue;
			allocateSequence(owner);
			const resume =
				owner.identitySent || owner.resumeUnsupported ? undefined : acceptedResume(owner.identity.resume);
			let failure = await executeHerdr(owner.environment, reportArgv(owner, next, resume), owner.options.timeoutMs);
			if (resume && failure?.kind === "protocol_rejected") {
				// Herdr older than 0.9.2 may refuse the trailing argv; keep the status and identity it would accept.
				allocateSequence(owner);
				failure = await executeHerdr(owner.environment, reportArgv(owner, next), owner.options.timeoutMs);
				if (!failure) owner.resumeUnsupported = true;
			}
			if (failure) {
				diagnostic(owner, failure);
				owner.lastDeliveredActivity = undefined;
			} else {
				owner.identitySent = true;
				owner.lastDeliveredActivity = next;
			}
		}
	})().finally(() => {
		owner.flight = undefined;
	});
}

/** Fence and drain a local reporter without unregistering the still-running agent. */
export function retirePaneReporting(owner: PaneOwner): Promise<void> {
	return stopPaneReporting(owner, false);
}

export function releasePaneReporting(owner: PaneOwner): Promise<void> {
	return stopPaneReporting(owner, true);
}

function stopPaneReporting(owner: PaneOwner, releaseRegistration: boolean): Promise<void> {
	if (owner.release) return owner.release;
	if (owners.get(owner.environment.paneId) !== owner || owner.status !== "active") {
		diagnostic(owner, { kind: "stale_owner" });
		return Promise.resolve();
	}
	owner.status = "releasing";
	owner.pending = undefined;
	owner.release = (async () => {
		await owner.flight;
		// A failed command may still have claimed authority before its response was lost.
		if (releaseRegistration && owner.seq > 0) {
			allocateSequence(owner);
			await send(owner, argv(owner, "release-agent"));
		}
		owner.status = "retired";
		if (releaseRegistration && owners.get(owner.environment.paneId) === owner)
			owners.delete(owner.environment.paneId);
	})();
	return owner.release;
}

/**
 * Clears Atomic's registration in this pane when no reporter can: an explicit quit the engine child never recorded,
 * because it was stopped mid-recovery or did not answer, would otherwise leave the conversation eligible for restore.
 */
export async function releaseUnownedPaneRegistration(
	environment: HerdrEnvironment,
	options: PaneReportingOptions = {},
): Promise<void> {
	const owner: Pick<PaneOwner, "environment" | "options" | "seq"> = { environment, options, seq: 0 };
	allocateSequence(owner);
	const result = await executeHerdr(environment, argv(owner, "release-agent"), options.timeoutMs);
	if (result) options.diagnostic?.(result);
}
