import type { SessionHeader, SessionWorkflowMetadata } from "./session-manager-types.ts";

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Returns valid workflow ownership metadata without rewriting its string values. */
export function validSessionWorkflowMetadata(value: unknown): SessionWorkflowMetadata | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const metadata = value as Record<string, unknown>;
	if (
		!isNonEmptyString(metadata.runId) ||
		!isNonEmptyString(metadata.stageId) ||
		!isNonEmptyString(metadata.stageName)
	) {
		return undefined;
	}
	return value as SessionWorkflowMetadata;
}

/** A session is hidden from normal history only when both ownership markers are valid. */
export function classifiedWorkflowMetadata(
	header: Pick<SessionHeader, "internal" | "workflow"> | null | undefined,
): SessionWorkflowMetadata | undefined {
	if (header?.internal !== true) return undefined;
	return validSessionWorkflowMetadata(header.workflow);
}

export function isClassifiedWorkflowSession(
	header: Pick<SessionHeader, "internal" | "workflow"> | null | undefined,
): boolean {
	return classifiedWorkflowMetadata(header) !== undefined;
}
