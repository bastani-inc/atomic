/**
 * Delegation boundary helpers.
 *
 * Delegation is exactly one level deep and is not configurable: a top-level
 * session may call the `subagent` tool, and the
 * children it admits may not.
 */

import type { ExtensionContext } from "@bastani/atomic";

// Depth is admission state carried in the typed child policy, not process environment.

/** Read the admitted depth carried by an in-process child session. */
export function getCurrentSubagentDepth(ctx: Pick<ExtensionContext, "subagentPolicy">): number {
	const depth = ctx.subagentPolicy?.depth;
	return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

/**
 * True when this session was itself admitted as a subagent child. Such a session
 * may never delegate further, regardless of any other capability it carries.
 */
export function isSubagentChildSession(ctx: Pick<ExtensionContext, "subagentPolicy">): boolean {
	return getCurrentSubagentDepth(ctx) >= 1;
}

export const SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE =
	"Subagent delegation is not available inside a subagent. " +
	"Only a top-level session can call the subagent tool. " +
	"Complete your assigned task directly.";
