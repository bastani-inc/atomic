import { isAbsolute } from "node:path";
import type { SessionActivity } from "./activity.js";
import type { HerdrEnvironment } from "./environment.js";
import { executeHerdr, type HerdrDiagnostic } from "./transport.js";

export interface PaneIdentity {
	id: string;
	path?: string;
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
	lastDeliveredActivity?: SessionActivity;
	pending?: { activity: SessionActivity; skipUnchanged: boolean };
	flight?: Promise<void>;
	release?: Promise<void>;
	flush(): Promise<void>;
}

// Host module lifetime outlives inline extension factories and runner generations.
const owners = new Map<string, PaneOwner>();
let highWater = 0;

function diagnostic(owner: PaneOwner, value: HerdrDiagnostic): void {
	owner.options.diagnostic?.(value);
}

/** Every admitted command, including release, takes a fresh strictly increasing sequence: Herdr ignores equal or older `--seq`. */
function allocateSequence(owner: PaneOwner): void {
	owner.seq = highWater = Math.max((owner.options.clock ?? Date.now)(), highWater + 1);
}

function argv(owner: PaneOwner, command: string): string[] {
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
			const args = [...argv(owner, "report-agent"), "--state", next.state];
			if (next.message) args.push("--message", next.message);
			if (!owner.identitySent) {
				args.push("--agent-session-id", owner.identity.id);
				if (owner.identity.path && isAbsolute(owner.identity.path))
					args.push("--agent-session-path", owner.identity.path);
			}
			if (await send(owner, args)) {
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
