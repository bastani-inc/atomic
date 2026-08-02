import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentSession, PromptOptions } from "@bastani/atomic";
import type { StageOutputOptions, StagePromptOptions, WorkflowMaxOutput } from "../../shared/types.js";
import { ensureWorkflowArtifactRunDirectory, workflowArtifactRunPath } from "../../shared/workflow-artifacts.js";

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 5000;

type TranscriptContentBlock = {
	readonly type?: string;
	readonly text?: string;
	readonly name?: string;
	readonly id?: string;
};

type TranscriptMessage = {
	readonly role?: string;
	readonly content?: string | readonly TranscriptContentBlock[];
	readonly customType?: string;
	readonly stageAdmissionKey?: string;
	readonly stageAdmissionProvenance?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
};

function normalizeMaxOutput(maxOutput: WorkflowMaxOutput | undefined): Required<WorkflowMaxOutput> {
	return {
		bytes: maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		lines: maxOutput?.lines ?? DEFAULT_MAX_OUTPUT_LINES,
	};
}

function truncateByLines(text: string, maxLines: number): { text: string; truncated: boolean } {
	if (!Number.isFinite(maxLines) || maxLines <= 0) return { text: "", truncated: text.length > 0 };
	const lines = text.split(/\r?\n/);
	if (lines.length <= maxLines) return { text, truncated: false };
	return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: "", truncated: text.length > 0 };
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return { text: text.slice(0, low), truncated: true };
}

function truncateOutput(text: string, maxOutput: WorkflowMaxOutput | undefined): string {
	const limits = normalizeMaxOutput(maxOutput);
	const byLines = truncateByLines(text, limits.lines);
	const byBytes = truncateByBytes(byLines.text, limits.bytes);
	if (!byLines.truncated && !byBytes.truncated) return text;
	return `${byBytes.text}\n\n[workflow output truncated; limits: ${limits.bytes} bytes, ${limits.lines} lines]`;
}

function countLines(text: string): number {
	if (!text) return 0;
	const newlineMatches = text.match(/\r\n|\r|\n/g);
	return (newlineMatches?.length ?? 0) + (text.endsWith("\n") || text.endsWith("\r") ? 0 : 1);
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function transcriptPath(runId: string, outputPath: string): string {
	const digest = createHash("sha256").update(outputPath).digest("hex").slice(0, 16);
	return join(workflowArtifactRunPath(runId), "transcripts", `${digest}-${basename(outputPath)}.transcript.md`);
}

function appendContent(lines: string[], content: TranscriptMessage["content"]): void {
	if (typeof content === "string") {
		lines.push(content);
		return;
	}
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			lines.push(block.text);
			continue;
		}
		const serialized = JSON.stringify(block);
		if (serialized !== undefined) lines.push(serialized);
	}
}

function renderTranscript(messages: AgentSession["messages"] | undefined, fallbackOutput: string): string {
	const lines = ["# Workflow stage transcript", ""];
	for (const [index, message] of (messages ?? []).entries()) {
		const record = message as TranscriptMessage;
		const role = typeof record.role === "string" ? record.role : "message";
		lines.push(`## ${index + 1} ${role}`);
		if (typeof record.customType === "string") lines.push(`customType: ${record.customType}`);
		if (typeof record.stageAdmissionKey === "string") lines.push(`stageAdmissionKey: ${record.stageAdmissionKey}`);
		if (typeof record.stageAdmissionProvenance === "string") {
			lines.push(`stageAdmissionProvenance: ${record.stageAdmissionProvenance}`);
		}
		if (typeof record.toolName === "string") lines.push(`toolName: ${record.toolName}`);
		if (typeof record.toolCallId === "string") lines.push(`toolCallId: ${record.toolCallId}`);
		appendContent(lines, record.content);
		lines.push("");
	}
	if ((messages?.length ?? 0) === 0) {
		lines.push("## 1 assistant");
		lines.push(fallbackOutput);
		lines.push("");
	}
	return lines.join("\n");
}

function savedOutputReference(
	outputPath: string,
	fullOutput: string,
	transcriptPathValue: string,
	transcriptText: string,
	transcriptAvailable: boolean,
	warning?: string,
): string {
	const absolutePath = resolve(outputPath);
	const bytes = Buffer.byteLength(fullOutput, "utf8");
	const lines = countLines(fullOutput);
	const transcriptBytes = Buffer.byteLength(transcriptText, "utf8");
	const transcriptLines = countLines(transcriptText);
	const outputReference = `Output saved to: ${absolutePath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}). Read this file if needed.`;
	const transcriptReference = transcriptAvailable
		? `Transcript saved to: ${transcriptPathValue} (${formatByteSize(transcriptBytes)}, ${transcriptLines} ${transcriptLines === 1 ? "line" : "lines"}). Search it with rg, read narrow line ranges, and do not read it whole.`
		: `Transcript unavailable at: ${transcriptPathValue}. Search it with rg when it becomes available, read narrow line ranges, and do not read it whole.`;
	return [outputReference, transcriptReference, warning]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function resolveOutputPath(
	output: string | false | undefined,
	runtimeCwd: string,
	requestedCwd: string | undefined,
): string | undefined {
	if (typeof output !== "string" || output.length === 0) return undefined;
	if (isAbsolute(output)) return output;
	const baseCwd =
		requestedCwd === undefined
			? runtimeCwd
			: isAbsolute(requestedCwd)
				? requestedCwd
				: resolve(runtimeCwd, requestedCwd);
	return resolve(baseCwd, output);
}

function degenerateWarning(fullOutput: string, outputPath: string): string | undefined {
	const trimmed = fullOutput.trim();
	if (trimmed.length === 0)
		return "WARNING: the nominated stage artifact is empty; inspect the companion transcript for the failed turn.";
	const normalized = trimmed.replaceAll("\\", "/").replace(/\s+/g, " ");
	const normalizedPath = outputPath.replaceAll("\\", "/");
	const mentionsOutputPath = normalized.includes(normalizedPath) || normalized.includes(basename(normalizedPath));
	if (!mentionsOutputPath || trimmed.includes("\n")) return undefined;
	const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pathReference = `(?:${escapeRegex(normalizedPath)}|${escapeRegex(basename(normalizedPath))})`;
	const pointerOnly =
		new RegExp(`^${pathReference}$`, "i").test(normalized) ||
		/^(?:see|refer to|read|find|review)\s+(?:the\s+)?(?:output|artifact|report|results?)?(?:\s+(?:at|in|from))?\s*[^ ]+$/i.test(
			normalized,
		) ||
		/^(?:research|report|output|artifact)\s+complete,\s+saved\s+to\s+[^ ]+$/i.test(normalized) ||
		/^(?:output|artifact|report|research)?\s*(?:complete|saved|written|available)(?:\s+(?:to|at|in))?\s*[^ ]+$/i.test(
			normalized,
		) ||
		new RegExp(
			`^(?:done|complete|finished|ok|okay)[.!,:;]?\\s+(?:(?:the\\s+)?(?:output|artifact|report|results?)\\s+)?${pathReference}$`,
			"i",
		).test(normalized) ||
		new RegExp(
			`^(?:the\\s+)?(?:report|output|artifact|results?)\\s+(?:is|are)\\s+(?:at|in|from)\\s+${pathReference}$`,
			"i",
		).test(normalized);
	return pointerOnly
		? "WARNING: the nominated stage artifact only points to its own output path; inspect the companion transcript for the real work."
		: undefined;
}
export function splitPromptOptions(options: StagePromptOptions | undefined): {
	sdkOptions: PromptOptions | undefined;
	outputOptions: StageOutputOptions;
} {
	if (!options) return { sdkOptions: undefined, outputOptions: {} };
	const sdkOptions: PromptOptions = {};
	if (options.expandPromptTemplates !== undefined) sdkOptions.expandPromptTemplates = options.expandPromptTemplates;
	if (options.images !== undefined) sdkOptions.images = options.images;
	if (options.streamingBehavior !== undefined) sdkOptions.streamingBehavior = options.streamingBehavior;
	if (options.source !== undefined) sdkOptions.source = options.source;
	if (options.preflightResult !== undefined) sdkOptions.preflightResult = options.preflightResult;

	const outputOptions: StageOutputOptions = {
		...(options.output !== undefined ? { output: options.output } : {}),
		...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
		...(options.context !== undefined ? { context: options.context } : {}),
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.maxOutput !== undefined ? { maxOutput: options.maxOutput } : {}),
		...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
		...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
	};

	return {
		sdkOptions: Object.keys(sdkOptions).length === 0 ? undefined : sdkOptions,
		outputOptions,
	};
}

export function validatePromptOutputOptions(outputOptions: StageOutputOptions): void {
	if (
		outputOptions.outputMode === "file-only" &&
		(typeof outputOptions.output !== "string" || outputOptions.output.length === 0)
	) {
		throw new Error(
			'atomic-workflows: prompt sets outputMode: "file-only" but does not configure an output file. Set output to a path or use outputMode: "inline".',
		);
	}
}

export async function finalizePromptOutput(
	fullOutput: string,
	outputOptions: StageOutputOptions,
	runtimeCwd: string,
	runId: string,
	messages?: AgentSession["messages"],
): Promise<string> {
	const outputPath = resolveOutputPath(outputOptions.output, runtimeCwd, outputOptions.cwd);
	validatePromptOutputOptions(outputOptions);
	const displayOutput = truncateOutput(fullOutput, outputOptions.maxOutput);
	if (outputPath === undefined) return displayOutput;

	const transcriptFile = transcriptPath(runId, outputPath);
	const transcript = renderTranscript(messages, fullOutput);
	try {
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, fullOutput, "utf8");
	} catch (err) {
		return `${displayOutput}\n\nOutput file error: ${outputPath}\n${err instanceof Error ? err.message : String(err)}`;
	}
	let transcriptAvailable = false;
	let transcriptError: string | undefined;
	try {
		await ensureWorkflowArtifactRunDirectory(runId);
		await mkdir(dirname(transcriptFile), { recursive: true });
		await writeFile(transcriptFile, transcript, "utf8");
		transcriptAvailable = true;
	} catch (err) {
		transcriptError = err instanceof Error ? err.message : String(err);
	}

	const warning =
		[
			transcriptError === undefined
				? undefined
				: `WARNING: companion transcript unavailable at ${transcriptFile}: ${transcriptError}`,
			degenerateWarning(fullOutput, outputPath),
		]
			.filter((line): line is string => line !== undefined)
			.join("\n") || undefined;
	const reference = savedOutputReference(
		outputPath,
		fullOutput,
		transcriptFile,
		transcript,
		transcriptAvailable,
		warning,
	);
	return outputOptions.outputMode === "file-only" ? reference : `${displayOutput}\n\n${reference}`;
}
