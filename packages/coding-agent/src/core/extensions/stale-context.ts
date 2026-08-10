/*
 * Error contract for extension APIs captured across runtime replacement.
 * Consumers should use the predicate instead of matching host error text.
 */
export const STALE_EXTENSION_CONTEXT_MARKER = "extension ctx is stale";

export const STALE_EXTENSION_CONTEXT_MESSAGE = `This ${STALE_EXTENSION_CONTEXT_MARKER} after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().`;

/** Return true for an error raised by an extension API after its runtime became stale. */
export function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_MARKER);
}
