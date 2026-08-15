/**
 * `NO_COLOR` is the one variable that decides whether Atomic emits any ANSI at
 * all: `chat-session-host-rendering.ts` drops caller-owned spinner styling when
 * it is set, and `atomic-working-status.ts` returns every frame and message
 * unpainted. That is the correct product contract, and
 * `packages/coding-agent/test/atomic-working-status.test.ts` covers it.
 *
 * The consequence is that any suite asserting an escape sequence inherits a
 * verdict from the developer's terminal. Four suites did: with `NO_COLOR`
 * exported, seven assertions across `chat-session-host-working-lifecycle`,
 * `interactive-working-loader-turn-reset` and `stage-chat-view-07` read a
 * bare `∀` and failed, while the same code passed in an unset shell. Those
 * files already pin `ATOMIC_REDUCED_MOTION`, which governs the same rendering
 * decision; this closes the other half.
 *
 * Restoring the previous value matters as much as clearing it. vitest runs the
 * files in one project sequentially inside a shared worker process, so a helper
 * that left `NO_COLOR` deleted — or, worse, set to `""`, which still reads as
 * suppression because the product tests `!== undefined` rather than
 * truthiness — would export this suite's preference to every file that ran
 * after it.
 */

import { afterAll, beforeAll } from "vitest";

/** The environment variable that suppresses every ANSI sequence Atomic writes. */
export const ANSI_SUPPRESSION_ENV_VAR = "NO_COLOR";

/**
 * Clear an inherited ANSI suppression for the caller, returning the restore
 * that puts the environment back exactly as it was found — absent stays
 * absent, and an empty string stays an empty string.
 */
export function clearAnsiSuppression(): () => void {
	const previous = process.env[ANSI_SUPPRESSION_ENV_VAR];
	delete process.env[ANSI_SUPPRESSION_ENV_VAR];
	return () => {
		if (previous === undefined) delete process.env[ANSI_SUPPRESSION_ENV_VAR];
		else process.env[ANSI_SUPPRESSION_ENV_VAR] = previous;
	};
}

/**
 * Pin a colour-emitting environment for one test file. Call it at module scope
 * in any suite whose assertions read ANSI escapes.
 */
export function useAnsiColorEnvironment(): void {
	let restore: (() => void) | undefined;
	beforeAll(() => {
		restore = clearAnsiSuppression();
	});
	afterAll(() => {
		restore?.();
		restore = undefined;
	});
}
