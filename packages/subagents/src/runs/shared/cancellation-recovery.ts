import { access, readFile } from "node:fs/promises";
import { INITIAL_PROGRESS_CONTENT } from "../../shared/progress-content.js";
import { truncateOutput } from "../../shared/types-output.js";

export { INITIAL_PROGRESS_CONTENT };

export const PARENT_CANCEL_CAUSE = "abort";

const PARTIAL_FINDINGS_MAX = { bytes: 32 * 1024, lines: 200 } as const;

export type CancellationRecoverySource = "progress.md" | "assistant" | "none";

export interface CancellationRecoveryInput {
	readonly progressPath?: string;
	readonly assistantText?: string;
	readonly toolCount?: number;
	readonly sessionPath?: string;
	/** Set, equal to `sessionPath`, when the child's session has no file and is cited by its history URL. */
	readonly sessionUrl?: string;
	readonly outputArtifactPath?: string;
	readonly progressArtifactPath?: string;
}

export interface CancellationRecovery {
	readonly text: string;
	readonly source: CancellationRecoverySource;
}

export function isParentCancellation(cause: string | undefined): boolean {
	return cause === PARENT_CANCEL_CAUSE;
}

export async function readModifiedProgress(progressPath: string | undefined): Promise<string | undefined> {
	if (!progressPath) return undefined;
	try {
		const content = await readFile(progressPath, "utf8");
		if (content.trim() === INITIAL_PROGRESS_CONTENT.trim()) return undefined;
		const trimmed = content.trim();
		return trimmed ? content : undefined;
	} catch {
		return undefined;
	}
}

function lastNonEmptyText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? value : undefined;
}

export async function existingArtifactPath(pathValue: string | undefined): Promise<string | undefined> {
	if (!pathValue) return undefined;
	try {
		await access(pathValue);
		return pathValue;
	} catch {
		return undefined;
	}
}

async function boundPartial(text: string, artifactPath?: string): Promise<string> {
	return truncateOutput(text, PARTIAL_FINDINGS_MAX, await existingArtifactPath(artifactPath)).text;
}

function afterLabel(toolCount: number | undefined): string {
	return typeof toolCount === "number" && toolCount > 0
		? ` after ${toolCount} tool call${toolCount === 1 ? "" : "s"}`
		: "";
}

async function artifactLines(input: CancellationRecoveryInput): Promise<string[]> {
	const lines: string[] = [];
	for (const [label, pathValue] of [
		["Session", input.sessionPath],
		["Progress", input.progressArtifactPath],
		["Output", input.outputArtifactPath],
	] as const) {
		// The session of a child with no session file is its history URL, a session in the store: no file to check for.
		const existing =
			label === "Session" && input.sessionUrl !== undefined && pathValue === input.sessionUrl
				? pathValue
				: await existingArtifactPath(pathValue);
		if (existing) lines.push(`${label}: ${existing}`);
	}
	return lines;
}

export async function recoverCancelledChildOutput(input: CancellationRecoveryInput): Promise<CancellationRecovery> {
	const progress = await readModifiedProgress(input.progressPath);
	const assistant = lastNonEmptyText(input.assistantText);
	const source: CancellationRecoverySource = progress ? "progress.md" : assistant ? "assistant" : "none";
	const lines = [`Run cancelled by parent${afterLabel(input.toolCount)}.`, ""];
	if (progress) {
		lines.push("Partial findings from progress.md:", await boundPartial(progress, input.progressArtifactPath), "");
	} else if (assistant) {
		lines.push("Partial findings from assistant history:", await boundPartial(assistant), "");
	}
	lines.push("This is incomplete and has not been validated as a final answer.");
	const refs = await artifactLines(input);
	if (refs.length) lines.push("", ...refs);
	return { text: lines.join("\n"), source };
}

export function lastNonEmptyAssistantText(
	messages: readonly { role?: string; content?: readonly { type?: string; text?: string }[] | string }[] | undefined,
	fallback?: string,
): string {
	if (messages) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			if (typeof message.content === "string") {
				if (message.content.trim()) return message.content;
				continue;
			}
			const text = (message.content ?? [])
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text)
				.join("");
			if (text.trim()) return text;
		}
	}
	return lastNonEmptyText(fallback) ?? "";
}

export function presentCancelledStatus(status: string, cause?: string): string {
	return status === "interrupted" && isParentCancellation(cause) ? "cancelled" : status;
}
