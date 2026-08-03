/**
 * Root-shared `ctx.tool` admission boundary for graceful quit.
 *
 * Rescanning live tool handles cannot make quit an exact durability boundary on
 * its own: `markDurableQuit()` awaits backend work, so a callback admitted
 * after the last scan would still be running when the paused/resumable
 * transition is published. A bounded rescan loop cannot fix that either — it
 * either misses a late admission or spins while author continuations keep
 * admitting calls.
 *
 * This boundary supplies the missing invariant instead:
 *
 * > Once quit closes admission, no root or nested run can admit another
 * > `ctx.tool` callback, so the collected handle set can only shrink.
 *
 * `admit()` opens a short *registration section*, not the callback's lifetime.
 * `ctx.tool` releases its lease as soon as the call has published its live node
 * controller (or resolved as cached/refused without a live callback), so
 * `closeForQuit()` waits microseconds rather than for callback settlement.
 *
 * cross-ref: issue #2078.
 */

import type { WorkflowGracefulQuitError } from "./workflow-tool-abort.js";

export interface ToolAdmissionLease {
	/** Idempotent; the registration section ends on the first call. */
	release(): void;
}

export type ToolAdmissionResult =
	| { readonly accepted: true; readonly lease: ToolAdmissionLease }
	| { readonly accepted: false; readonly error: WorkflowGracefulQuitError };

export interface ToolAdmissionBoundary {
	/** Enter a registration section, or refuse once quit has closed admission. */
	admit(): ToolAdmissionResult;
	/**
	 * Refuse every future admission and wait only for registration sections that
	 * were already open. Idempotent and safe to call concurrently.
	 */
	closeForQuit(reason: WorkflowGracefulQuitError): Promise<void>;
	readonly closed: boolean;
	/**
	 * The reason a whole-run quit closed this workflow tree, when one did.
	 *
	 * This is the authoritative signal that quit owns the run's outcome, even
	 * when author code caught the tool rejection: `run()` reads it on both the
	 * success and failure paths so a later author return cannot convert an
	 * operator-selected quit into a terminal completion.
	 */
	readonly quitReason: WorkflowGracefulQuitError | undefined;
	/** True while a `ctx.tool` call is between admission and node registration. */
	readonly hasPendingAdmissions: boolean;
}

export function createToolAdmissionBoundary(): ToolAdmissionBoundary {
	let closedReason: WorkflowGracefulQuitError | undefined;
	let openSections = 0;
	let drained: PromiseWithResolvers<void> | undefined;

	const settleWhenDrained = (): void => {
		if (closedReason !== undefined && openSections === 0) drained?.resolve();
	};

	return {
		get closed(): boolean {
			return closedReason !== undefined;
		},
		get quitReason(): WorkflowGracefulQuitError | undefined {
			return closedReason;
		},
		get hasPendingAdmissions(): boolean {
			return openSections > 0;
		},
		admit(): ToolAdmissionResult {
			if (closedReason !== undefined) return { accepted: false, error: closedReason };
			openSections += 1;
			let released = false;
			return {
				accepted: true,
				lease: {
					release(): void {
						if (released) return;
						released = true;
						openSections -= 1;
						settleWhenDrained();
					},
				},
			};
		},
		async closeForQuit(reason: WorkflowGracefulQuitError): Promise<void> {
			closedReason ??= reason;
			if (openSections === 0) return;
			drained ??= Promise.withResolvers<void>();
			await drained.promise;
		},
	};
}
