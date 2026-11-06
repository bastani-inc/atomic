import { rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { SessionIdError } from "../session-manager-errors.js";
import { assertValidSessionId } from "../session-manager-validation.js";
import { TOOL_RESULT_BLOBS_SUBDIR } from "./tool-limits.js";

/**
 * Directory holding the oversized tool results of one released workflow stage's session:
 * `<agentDir>/blobs/tool-output/<sessionId>/`. Files in it are named `<sha256>.txt` and live as long as the session.
 */
export function getReleasedStageBlobDir(agentDir: string, sessionId: string): string {
	return join(agentDir, TOOL_RESULT_BLOBS_SUBDIR, sessionId);
}

/**
 * Remove a deleted session's released-stage tool results. A session that has none is not an error. The id is checked
 * first: a valid id has no separator and is not `.` or `..`, so the directory it names is inside the blob root.
 */
export async function removeReleasedStageBlobs(agentDir: string, sessionId: string): Promise<void> {
	assertValidSessionId(sessionId);
	const target = getReleasedStageBlobDir(agentDir, sessionId);
	if (!isDirectChild(resolve(agentDir, TOOL_RESULT_BLOBS_SUBDIR), resolve(target)))
		throw new SessionIdError(sessionId);
	await rm(target, { recursive: true, force: true });
}

function isDirectChild(root: string, target: string): boolean {
	const path = relative(root, target);
	return path.length > 0 && !path.startsWith("..") && !path.includes(sep);
}
