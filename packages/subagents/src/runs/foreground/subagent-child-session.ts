import { existsSync } from "node:fs";
import { type ExtensionContext, SessionManager } from "@bastani/atomic";
import type { SubagentChildRecord } from "./subagent-child-records.js";

/** Intercom's entry recording the Intercom id a session registered under (`packages/intercom/session-identity.ts`). */
const INTERCOM_SESSION_IDENTITY_ENTRY = "intercom_session_identity";

/** The Intercom id the child's own Intercom extension recorded for its session before the restart. */
export function readPreviousIntercomId(sessionManager: SessionManager): string | undefined {
	const sessionId = sessionManager.getSessionId();
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== INTERCOM_SESSION_IDENTITY_ENTRY) continue;
		const data = entry.data as { sessionId?: string; intercomSessionId?: string } | undefined;
		if (data?.sessionId === sessionId && typeof data.intercomSessionId === "string" && data.intercomSessionId)
			return data.intercomSessionId;
	}
	return undefined;
}

/**
 * Reopen a child's own session from wherever it was created: its JSONL session file when
 * one was recorded, otherwise by session id from the owner's session store (forked children
 * live in the store of the session that launched them, which is a database by default and
 * has no session file).
 */
export async function reopenChildSession(
	ctx: Pick<ExtensionContext, "sessionManager">,
	record: SubagentChildRecord,
): Promise<{ readonly sessionManager: SessionManager } | { readonly reason: string }> {
	try {
		if (record.childSessionFile && existsSync(record.childSessionFile)) {
			const sessionManager = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
			return record.childSessionId !== undefined && sessionManager.getSessionId() !== record.childSessionId
				? { reason: "its session file now belongs to a different session" }
				: { sessionManager };
		}
		if (record.childSessionId === undefined) return { reason: "no session was recorded for it" };
		return {
			sessionManager: await SessionManager.open(
				ctx.sessionManager.getSessionStore(),
				record.childSessionId,
				record.cwd,
			),
		};
	} catch (error) {
		if (error instanceof Error && error.name === "SessionNotFoundError")
			return { reason: "its session no longer exists in the session store" };
		throw error;
	}
}
