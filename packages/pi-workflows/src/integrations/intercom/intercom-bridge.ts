/**
 * pi-intercom cooperation: parent session naming + presence detection.
 *
 * Responsibilities:
 *  1. Detect whether pi-intercom-like surfaces exist on the ExtensionAPI
 *     (structural check — no hard import).
 *  2. On session_start, register the parent session name as
 *     `pi-workflows-parent-<short-cwd-hash>` so detached child processes
 *     can `contact_supervisor` through the intercom channel.
 *
 * cross-ref: pi-subagents src/intercom/intercom-bridge.ts
 * cross-ref: spec §5.10 Integration with pi-intercom, §8.1 Phase G
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal structural types — no hard imports from pi-intercom
// ---------------------------------------------------------------------------

/** Minimal ExtensionAPI surface expected by intercom integration. */
export interface PiIntercomExtensionAPI {
  /** Sets the session name that children can use as `contact_supervisor` target. */
  setSessionName?: (name: string) => void;
  /** Event subscription surface used by multiple integrations. */
  events?: {
    emit?: (event: string, payload: Record<string, unknown>) => void;
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session name derivation
// ---------------------------------------------------------------------------

/**
 * Derives a short (8-char) hex hash from the given string (typically cwd).
 * Stable across restarts for the same directory, short enough for display.
 */
export function deriveCwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}

/**
 * Returns the canonical parent session name for this workflow run.
 * Format: `pi-workflows-parent-<8-char-hash>`
 *
 * Spec default: derive from cwd (§9 open question 7 → resolved as cwd hash).
 */
export function buildParentSessionName(cwd: string = process.cwd()): string {
  return `pi-workflows-parent-${deriveCwdHash(cwd)}`;
}

// ---------------------------------------------------------------------------
// Presence detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the pi runtime exposes an intercom-like `setSessionName`
 * method. Purely structural — does not import pi-intercom.
 */
export function isIntercomPresent(pi: PiIntercomExtensionAPI): boolean {
  return typeof pi.setSessionName === "function";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the workflow parent session name via `pi.setSessionName` so
 * detached child processes can `contact_supervisor` back to this session.
 *
 * - No-op when `pi.setSessionName` is absent (pi-intercom not installed).
 * - Called once during extension initialization (session_start equivalent).
 *
 * @param pi   The ExtensionAPI instance.
 * @param cwd  Working directory used to derive a stable hash. Defaults to
 *             `process.cwd()`.
 * @returns    The session name that was set, or `null` if intercom absent.
 */
export function registerIntercomParentSession(
  pi: PiIntercomExtensionAPI,
  cwd: string = process.cwd(),
): string | null {
  if (!isIntercomPresent(pi)) return null;

  const name = buildParentSessionName(cwd);
  // Safe: isIntercomPresent guard above ensures setSessionName exists.
  pi.setSessionName!(name);
  return name;
}
