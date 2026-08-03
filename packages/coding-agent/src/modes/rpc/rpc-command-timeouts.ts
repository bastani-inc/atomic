/**
 * Commands exempt from the generic request deadline.
 *
 * Two groups, for two reasons:
 *
 *  - Work legitimately gated on human or agent interaction: interactive prompts
 *    and custom-UI pickers (routed through `prompt`), queued turn-boundary sends
 *    (`steer`/`follow_up`), long-running shell and compaction work, and
 *    session-tree navigation or mutation that can open pickers.
 *  - Cooperative cancellation. Escape's whole contract is that it asks the
 *    engine to stop and waits for as long as the engine takes. A host-side
 *    deadline would surface as `Timeout waiting for response to abort…` — a red
 *    error about the host's own impatience while the engine is still working —
 *    and would not stop anything.
 *
 * Failure detection is unaffected: engine exit, transport violations, generation
 * replacement, and explicit stop all reject pending requests through
 * rejectPendingRequests/failTransport independently of any timer.
 */
export const LONG_LIVED_COMMANDS: ReadonlySet<string> = new Set<string>([
	// Cooperative cancellation, all unbounded by design.
	"abort",
	"abort_bash",
	"abort_compaction",
	"abort_retry",
	"cancel_login_provider",
	// Interaction- or turn-gated work.
	"prompt",
	"login_provider",
	"steer",
	"follow_up",
	"bash",
	"user_bash",
	"compact",
	"fork",
	"clone",
	"switch_session",
	"new_session",
	"import_session",
	"navigate_tree",
	"invoke_shortcut",
]);

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a dead child's stdout to drain before failing the
 * requests it never answered. `'close'` normally arrives first; this only
 * bounds the case where a descendant inherited stdout and keeps it open.
 */
export const EXIT_DRAIN_TIMEOUT_MS = 500;

/** Rejection message for a restart superseded by an explicit stop or disposal. */
export const RESTART_CANCELLED_MESSAGE = "Interactive engine restart cancelled";
