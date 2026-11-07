import { existsSync } from "node:fs";

export interface SessionCwdIssue {
	sessionFile?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}

interface StoredSessionCwdSource extends SessionCwdSource {
	isPersisted(): boolean;
	getEntries(): readonly object[];
}

/**
 * The missing-cwd issue for a resumed session kept in database storage, which has no session file: its recorded cwd
 * may be another machine's path. New sessions and in-memory sessions have none.
 */
export function getMissingStoredSessionCwdIssue(
	sessionManager: StoredSessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	if (sessionManager.getSessionFile() || !sessionManager.isPersisted() || sessionManager.getEntries().length === 0) {
		return undefined;
	}
	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) return undefined;
	return { sessionCwd, fallbackCwd };
}
