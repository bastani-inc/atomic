import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { Message } from "../types.ts";

/** Diagnostics a reply records when Claude rejected its request's strict tools for exceeding its limits. */
const STRICT_TOOL_LIMIT_FALLBACK_DIAGNOSTICS: ReadonlySet<string> = new Set([
	"anthropic_strict_tools_fallback",
	"bedrock_strict_tools_fallback",
]);

/**
 * Claude rejects (on the Anthropic API and on Bedrock) a request whose strict tools exceed its limits with one of these
 * messages. Observed limits: 20 strict tools, and 16 optional or union-typed parameters across all strict tools.
 */
const STRICT_TOOL_LIMIT_ERROR_MESSAGES = [
	"The compiled grammar is too large",
	"Too many strict tools (",
	"Schemas contains too many parameters with union types (",
];

/** Returns true when a provider error message says the request's strict tools exceed the provider's limits. */
export function isStrictToolLimitErrorMessage(message: string): boolean {
	return STRICT_TOOL_LIMIT_ERROR_MESSAGES.some((limitMessage) => message.includes(limitMessage));
}

/**
 * Sessions whose strict tools Claude rejected for exceeding its limits. Their later requests send `strict: "prefer"`
 * tools non-strict right away: the tool set rarely changes between turns, so trying strict again would only repeat
 * the rejection, and switching back to strict later would rewrite the tool definitions and miss the prompt cache.
 * Shared by the Anthropic and Bedrock providers, which run the same Claude limits.
 */
const sessionsOverStrictToolLimits = new Set<string>();
const MAX_SESSIONS_OVER_STRICT_TOOL_LIMITS = 10_000;

/**
 * Records that a session's strict tools exceeded Claude's limits; does nothing without a session. Keeps at most
 * `MAX_SESSIONS_OVER_STRICT_TOOL_LIMITS` sessions.
 *
 * Entries are normally freed by `cleanupSessionResources(sessionId)` when a session ends. The cap bounds memory for
 * library users that never call it; a dropped session just pays one more rejection.
 */
export function markStrictToolLimitsExceeded(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	sessionsOverStrictToolLimits.add(sessionId);
	if (sessionsOverStrictToolLimits.size > MAX_SESSIONS_OVER_STRICT_TOOL_LIMITS) {
		const oldest = sessionsOverStrictToolLimits.values().next().value;
		if (oldest !== undefined) sessionsOverStrictToolLimits.delete(oldest);
	}
}

/** Returns true when an earlier request of this session had its strict tools rejected for exceeding Claude's limits. */
export function hasExceededStrictToolLimits(sessionId: string | undefined): boolean {
	return sessionId !== undefined && sessionsOverStrictToolLimits.has(sessionId);
}

/**
 * Returns true when an earlier request had its strict tools rejected for exceeding Claude's limits, as this process
 * remembers it or as a reply in `messages` recorded it: the rejected reply's diagnostic, or a later reply sent without
 * strict schemas for that reason, which a compaction keeps longer. A resumed session runs in a process that never saw the
 * rejection; trying strict tools again would only repeat it, and the retry is what keeps the tool definitions, and so
 * the prompt cache, unchanged. A transcript record is remembered for the session like a rejection.
 */
export function strictToolLimitsExceeded(sessionId: string | undefined, messages: readonly Message[]): boolean {
	if (hasExceededStrictToolLimits(sessionId)) return true;
	const recorded = messages.some(
		(message) =>
			message.role === "assistant" &&
			(message.strictToolsDisabled === true ||
				(message.diagnostics ?? []).some((diagnostic) => STRICT_TOOL_LIMIT_FALLBACK_DIAGNOSTICS.has(diagnostic.type))),
	);
	if (recorded) markStrictToolLimitsExceeded(sessionId);
	return recorded;
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) sessionsOverStrictToolLimits.delete(sessionId);
	else sessionsOverStrictToolLimits.clear();
});
